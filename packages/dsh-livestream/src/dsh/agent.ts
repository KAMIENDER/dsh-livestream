/**
 * agent 子插件：挂在「大肥鱼直播」预设下（见 cordis.patch.yml），接上 DSH 的服务，盯着她直播的会话。
 *
 * 只有一个说话出口：她回复的正文。会话里每出现一条带正文的 assistant 消息就念一条（写出一段念一段），
 * 每条只念一次。正文里的 [表情] 标记（角色包里有的）把话切成几段，每段带着自己的表情念：说着说着可以换表情。
 * 只发工具调用、没写正文的消息很正常（她在做事），没有要念的就跳过。
 * 没有说话工具、没有 say 参数：那种「要模型自己选择用的通道」在 HiyoriAI 和 dsh-game 里都踩过坑（她会不用）。
 *
 * 身体往会话里推一件事：DSH 的 agent 句柄 followup（追加一条消息并唤醒她）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import { fetchProfile, profileSummary, profileText } from '../body/biliProfile';
import { clock, infoText, searchText, subtitleText, type Subtitles, type VideoInfo, type VideoPart } from '../body/biliVideo';
import { lookupProblem } from '../core/viewerLookup';
import { splitByMood } from '../core/moodText';
import { asr, cookie, currentMoods, dm, hooks, settings, show, videos } from './runtime';

export const name = 'dsh-livestream-agent';
export const inject = ['tools'];

interface AgentContext {
  effect(effect: () => () => void, label?: string): unknown;
  get?(name: string): any;
  [service: string]: any;
}

/** 已经念过的消息：会话 id + 消息序号 */
const voiced = new Set<string>();

const wordsOf = (event: any): string => (event?.data?.message?.content ?? [])
  .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
  .map((p: any) => p.text.trim()).filter(Boolean).join('\n');

/** 盯着直播的会话：新的正文就念，一轮开始、结束告诉身体 */
let watched: { sessionId: string; seq: number } | null = null;
let watching = false;
/** 这场直播（她的会话）累计用掉的 token：舞台上换算成她吃了多少饭 */
let usage = { sessionId: '', tokens: 0 };

function countUsage(sessionId: string, event: any): void {
  const turn = Number(event?.data?.usage?.totalTokens);
  if (!Number.isFinite(turn) || turn <= 0) return;
  if (usage.sessionId !== sessionId) usage = { sessionId, tokens: 0 };
  usage.tokens += turn;
  const model = event?.data?.message?.source?.model;
  show.stage.broadcast({ type: 'usage', tokens: usage.tokens, turn, ...(typeof model === 'string' ? { model } : {}) });
}
async function watch(ctx: AgentContext): Promise<void> {
  const sessionId = show.currentSession;
  if (!sessionId || watching) return;
  const session = ctx.get?.('sessions')?.get?.(sessionId);
  if (!session) return;
  // 刚开始盯这个会话：只管从现在起的新事件
  if (!watched || watched.sessionId !== sessionId) {
    watched = { sessionId, seq: Number(session.seq) };
    return;
  }
  const events = session.snapshotEvents(watched.seq) as any[];
  watched.seq = Number(session.seq);
  watching = true;
  try {
    for (const event of events) {
      if (event?.type === 'turn/start') show.turnStarted(sessionId);
      else if (event?.type === 'turn/end') show.turnEnded(sessionId);
      else if (event?.type === 'assistant/message') {
        countUsage(sessionId, event);
        const key = `${sessionId}:${event.seq}`;
        if (voiced.has(key)) continue;
        voiced.add(key);
        const words = wordsOf(event);
        if (!words) continue;
        for (const part of splitByMood(words, currentMoods())) await show.say(part.text, part.mood, AbortSignal.timeout(120_000));
      }
    }
  } finally {
    watching = false;
  }
}

/** 往她的会话里推一条消息（追加并唤醒）；会话不在线返回 false */
async function push(ctx: AgentContext, sessionId: string, text: string): Promise<boolean> {
  const agents = ctx.get?.('agents');
  const found = agents?.get?.(sessionId);
  const agent = found?.followup ? found : found?.agent;
  if (!agent?.followup) return false;
  // 和 DSH 自己的 createUserMessage 一样：带 id、role，冻结（消息进会话后不能再改）
  await agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-livestream' } }));
  return true;
}

/** 默认放多久、最多放多久（秒）：一个长视频不会把整场直播占掉 */
const PLAY_DEFAULT_SEC = 180;
const PLAY_MAX_SEC = 600;

/** 「1:30」「90」→ 秒 */
function seconds(value: unknown): number {
  if (typeof value === 'number') return Math.max(0, value);
  const text = String(value ?? '').trim();
  if (!text) return 0;
  return Math.max(0, text.split(':').reduce((sum, n) => sum * 60 + (Number(n) || 0), 0));
}

/** 她给的视频（BV 号、av 号、链接）和第几 P → 视频详情；认不出、找不到时返回告诉她怎么改的话 */
async function findVideo(video: unknown, part: unknown): Promise<{ info: VideoInfo; part: VideoPart } | string> {
  const text = String(video ?? '').trim();
  const ref = await videos.resolve(text);
  if (!ref) return `没认出「${text.slice(0, 40)}」是哪个视频：video 填 BV 号（BV 开头的 12 位，search_videos 的结果和 view_profile 的投稿里都有）、av 号或者视频链接。`;
  const info = await videos.info(ref);
  if (!info) return `${ref.bvid ?? `av${ref.aid}`} 打不开：可能没有这个视频、被删了，或者 B 站没返回（网络问题）。检查一下号码。`;
  const page = Math.floor(Number(part) || ref.part || 1);
  const found = info.parts.find((p) => p.page === page);
  if (!found) return `「${info.title}」只有 ${info.parts.length} P，没有 P${page}。`;
  return { info, part: found };
}

/** 视频没字幕：听 from 所在的那一段（没配语音识别、听失败返回 null，照「没有字幕」说） */
async function listen(info: VideoInfo, part: VideoPart, from: number): Promise<Subtitles | null> {
  try {
    const heard = await asr.chunk({ bvid: info.bvid, cid: part.cid, durationSec: part.durationSec }, from, () => videos.audioUrl(info.bvid, part.cid));
    return heard ? { kind: 'asr', lang: heard.lang, lines: heard.lines, until: heard.until, engine: settings.asrModel } : null;
  } catch (err) {
    hooks.log('warn', `语音识别失败（${info.bvid}）：${(err as Error).message}`);
    return null;
  }
}

/** 调一次模型（下播提炼记忆）：不思考，只要文字 */
async function completeWithDsh(ctx: AgentContext, model: string, system: string, user: string): Promise<string> {
  const llm = ctx.get?.('llm');
  if (!llm) throw new Error('DSH 的模型服务不可用');
  const slash = model.indexOf('/');
  let out = '';
  for await (const chunk of llm.stream({
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
    system,
    messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'dsh-livestream' } }],
    maxTokens: 3000,
    reasoningEffort: 'off',
    purpose: 'dsh-livestream-memory',
    signal: AbortSignal.timeout(120_000),
  })) {
    if (chunk.type === 'text-delta') out += chunk.text;
  }
  return out.trim();
}

export function apply(ctx: AgentContext): void {
  hooks.secret = async (name) => {
    const credentials = ctx.get?.('credentials');
    const hit = credentials ? await credentials.resolve(name).catch(() => undefined) : undefined;
    return hit?.value ?? process.env[name] ?? '';
  };
  hooks.complete = (model, system, user) => completeWithDsh(ctx, model, system, user);
  hooks.push = (sessionId, text) => push(ctx, sessionId, text);
  // 警告也打到 stderr：DSH 网页版的日志只在内存里，服务器上看 web.log 才找得到
  if (ctx.logger) hooks.log = (level, message) => {
    ctx.logger[level]?.(`dsh-livestream: ${message}`);
    if (level === 'warn') console.warn(`[dsh-livestream] ${message}`);
  };

  ctx.effect(() => {
    const timer = setInterval(() => void watch(ctx).catch((err) => hooks.log('warn', `盯会话出错：${(err as Error).message}`)), 300);
    return () => clearInterval(timer);
  }, 'dsh-livestream session watch');

  // 看观众的 B 站主页（公开信息）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'view_profile',
    description: '看一位观众的 B 站个人主页：等级、签名、粉丝和关注数、最近投稿、置顶视频、代表作、空间公告、有没有直播间。'
      + '只看得到主页上公开的东西。要几秒钟。',
    parameters: {
      who: { type: 'string', required: true, description: '观众的名字（照消息里写的）或 UID' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const who = String(args.who ?? '');
      const viewer = show.lookupViewer(who);
      if (viewer.kind !== 'found') return lookupProblem(who, viewer);
      if (show.optedOut(viewer.uid)) return `${viewer.user.name} 说过不想被记住，他的主页就不看了。`;
      show.toolCall('view_profile', viewer.how === 'unseen-uid' ? `UID ${viewer.uid}` : viewer.user.name, viewer.how === 'unseen-uid' ? `在看 UID ${viewer.uid} 的主页` : `在看${viewer.user.name}的主页`);
      const profile = await fetchProfile(viewer.uid, await cookie());
      if (!profile) return viewer.how === 'unseen-uid' ? `UID ${viewer.uid} 打不开：可能没有这个用户，检查一下数字。` : `没打开 ${viewer.user.name} 的主页（B 站没返回，可能是网络问题）。`;
      const marks = [
        viewer.user.guardLevel ? ['', '总督', '提督', '舰长'][viewer.user.guardLevel] : '',
        viewer.user.medal?.ofThisRoom ? `粉丝牌${viewer.user.medal.level}级` : '',
        viewer.user.isAdmin ? '房管' : '',
      ].filter(Boolean).join('，');
      show.rememberProfile(viewer.uid, profileSummary(profile));
      // 按名字的一部分找到的：告诉她是谁，对不上可以换 UID 再查
      const note = viewer.how === 'partial' ? `（按「${who}」找到的是 ${profile.name}；不是他的话，用 UID 再查）\n` : '';
      return note + profileText(profile, marks || undefined);
    },
  })), 'view_profile tool');

  // 私信观众（开播账号发）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'send_dm',
    description: '用开播账号给一位观众发一条 B 站私信（文字）。只能发给这场直播里出现过、或者以前来过的观众。'
      + 'B 站规定：对方没关注开播账号、也没回过私信时，只能发一条，要等他关注或回复才能再发；结果里会告诉你他关注了没有。',
    parameters: {
      who: { type: 'string', required: true, description: '观众的名字（照消息里写的）或 UID' },
      text: { type: 'string', required: true, description: '私信内容（2000 字节以内）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const who = String(args.who ?? '');
      const viewer = show.lookupViewer(who);
      if (viewer.kind !== 'found') return lookupProblem(who, viewer);
      if (!show.knowsViewer(viewer.uid)) return `UID ${viewer.uid} 没在这场直播里出现过，也不是以前来过的观众：私信只发给直播间里的观众。`;
      if (show.optedOut(viewer.uid)) return `${viewer.user.name} 说过不想被记住，就不私信他了。`;
      show.toolCall('send_dm', `→ ${viewer.user.name}`, `在给${viewer.user.name}发私信`);
      const result = await dm.send({ uid: viewer.uid, name: viewer.user.name }, String(args.text ?? ''));
      if (result.ok) show.noteDm(viewer.user.name, String(args.text ?? ''));
      return result.text;
    },
  })), 'send_dm tool');

  // 搜 B 站视频
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'search_videos',
    description: '搜 B 站视频，返回一页候选（BV 号、标题、UP 主、时长、播放量、发布日期、标签、简介）。'
      + '可以只搜某位 UP 主的投稿（up），可以按最新或播放最多排（order），可以翻页（page）。',
    parameters: {
      query: { type: 'string', required: true, description: '关键词（观众说的大概意思就行）；只看某位 UP 主最新的投稿时可以留空' },
      up: { type: 'string', description: 'UP 主的名字或 UID：只在他的投稿里找' },
      order: { type: 'string', enum: ['relevance', 'newest', 'views'], description: 'relevance 相关度（默认）、newest 最新、views 播放最多（填了 up 时按发布时间）' },
      page: { type: 'number', description: '第几页，默认 1' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const query = String(args.query ?? '').trim();
      const up = String(args.up ?? '').trim() || undefined;
      if (!query && !up) return 'query 和 up 至少填一个。';
      const order = (['relevance', 'newest', 'views'] as const).find((o) => o === args.order);
      const options = { up, order, page: Number(args.page) || 1 };
      show.toolCall('search_videos', query ? `「${query}」` : `UP ${up}`, `在搜视频：${query || up}`);
      asr.warm();
      const result = await videos.search(query, options);
      if (!result) return 'B 站搜索没返回（可能是网络问题或者被限流了），过一会儿再搜。';
      return searchText(query, result, options);
    },
  })), 'search_videos tool');

  // 看一个视频：详情和字幕
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'watch_video',
    description: '看一个 B 站视频：详情（标题、UP 主、时长、播放点赞投币收藏、标签、简介、分 P）和带时间的字幕。'
      + '字幕一次给一段，长的用 from 接着往后看；视频没有字幕时会听一遍、把说的话写下来（要几秒到十几秒）。',
    parameters: {
      video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' },
      part: { type: 'number', description: '多 P 视频的第几 P，默认 1' },
      from: { type: 'number', description: '从第几秒的字幕开始看（接着看时填上次给的数）；填了就只给字幕' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const found = await findVideo(args.video, args.part);
      if (typeof found === 'string') return found;
      const { info, part } = found;
      const from = seconds(args.from);
      show.toolCall('watch_video', `「${info.title.slice(0, 16)}」`, `在看「${info.title.slice(0, 20)}」`);
      const sub = (await videos.subtitles(info.bvid, part.cid)) ?? (await listen(info, part, from));
      const partArg = part.page > 1 ? `, part=${part.page}` : '';
      const subtitle = subtitleText(info, part, sub, from, partArg);
      const noLogin = !sub && !(await videos.loggedIn()) ? '（开播账号没登录：B 站的 AI 字幕要登录才给）' : '';
      if (from > 0) return `「${info.title}」${part.page > 1 ? `P${part.page} ` : ''}从 ${clock(from)} 起：\n${subtitle}${noLogin}`;
      return `${infoText(info, part)}\n\n${subtitle}${noLogin}`;
    },
  })), 'watch_video tool');

  // 在舞台上放视频
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'play_video',
    description: '在直播间的舞台上放一个 B 站视频给大家看：舞台换成看视频的布局，放完换回来，放完了会告诉你。'
      + `默认从头放 ${PLAY_DEFAULT_SEC / 60} 分钟，可以指定从哪里开始、放多久（最长 ${PLAY_MAX_SEC / 60} 分钟）。`
      + '放的时候你照常说话、回弹幕，你说话时视频声音会自动调小。正在放的会被换掉。'
      + '舞台只在这个工具被调用时开始放：你说「我放一下」只是念给大家听，视频要靠这次调用才出现在舞台上。',
    parameters: {
      video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' },
      part: { type: 'number', description: '多 P 视频的第几 P，默认 1' },
      from: { type: 'string', description: '从哪里开始放：秒数或「分:秒」，默认 0' },
      seconds: { type: 'number', description: `放多少秒，默认 ${PLAY_DEFAULT_SEC}，最多 ${PLAY_MAX_SEC}` },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const found = await findVideo(args.video, args.part);
      if (typeof found === 'string') return found;
      const { info, part } = found;
      const from = Math.floor(seconds(args.from));
      if (part.durationSec && from >= part.durationSec) return `「${info.title}」一共只有 ${clock(part.durationSec)}，从 ${clock(from)} 开始就没有了。`;
      const length = Math.min(PLAY_MAX_SEC, Math.max(5, Number(args.seconds) || PLAY_DEFAULT_SEC));
      const until = part.durationSec ? Math.min(part.durationSec, from + length) : from + length;
      const url = await videos.playUrl(info.bvid, part.cid);
      if (!url) return `B 站没给「${info.title}」的播放地址（可能是付费、番剧、充电专属或者有地区限制），放不了。`;
      show.toolCall('play_video', `「${info.title.slice(0, 16)}」`);
      const { replaced } = show.playVideo({ bvid: info.bvid, title: info.title, up: info.up.name, url, fromSec: from, untilSec: until });
      const lines = [
        `舞台上开始放「${info.title}」（UP ${info.up.name}），${clock(from)}–${clock(until)}，共 ${clock(until - from)}。舞台换成了看视频的布局。`,
        '放完了会告诉你；想停用 stop_video，想换直接 play_video 别的。',
      ];
      if (replaced) lines.push(`（换掉了正在放的「${replaced.title}」）`);
      if (!show.stage.watchers) lines.push('（现在没有出声的舞台页开着：观众看不到画面，按时长算放完）');
      return lines.join('\n');
    },
  })), 'play_video tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'stop_video',
    description: '停下舞台上正在放的视频，舞台换回聊天的布局。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      show.toolCall('stop_video', '');
      const stopped = show.player.stop();
      if (!stopped) return '现在没在放视频。';
      return `停了「${stopped.video.title}」（放了 ${clock(stopped.playedSec)}），舞台换回了聊天的布局。`;
    },
  })), 'stop_video tool');
}

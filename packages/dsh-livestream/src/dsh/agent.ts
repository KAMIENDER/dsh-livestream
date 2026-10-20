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
import { splitByMood } from '../core/moodText';
import { currentMoods, hooks, show } from './runtime';

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
  if (ctx.logger) hooks.log = (level, message) => ctx.logger[level]?.(`dsh-livestream: ${message}`);

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
      const viewer = show.findViewer(String(args.who ?? ''));
      if (!viewer) return `这场直播里没找到「${args.who}」（名字被打码的观众也看不到主页）。`;
      if ('simulated' in viewer) return `${viewer.name} 是主人在控制台里模拟的观众（彩排用），没有真的 B 站主页。`;
      if (show.optedOut(viewer.uid)) return `${viewer.user.name} 说过不想被记住，他的主页就不看了。`;
      show.doing(`在看${viewer.user.name}的主页`);
      const profile = await fetchProfile(viewer.uid);
      if (!profile) return `没打开 ${viewer.user.name} 的主页（B 站没返回，可能是网络问题）。`;
      const marks = [
        viewer.user.guardLevel ? ['', '总督', '提督', '舰长'][viewer.user.guardLevel] : '',
        viewer.user.medal?.ofThisRoom ? `粉丝牌${viewer.user.medal.level}级` : '',
        viewer.user.isAdmin ? '房管' : '',
      ].filter(Boolean).join('，');
      show.rememberProfile(viewer.uid, profileSummary(profile));
      return profileText(profile, marks || undefined);
    },
  })), 'view_profile tool');
}

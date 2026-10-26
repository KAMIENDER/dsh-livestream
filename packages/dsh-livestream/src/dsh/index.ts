/**
 * dsh-livestream 根插件（宿主端）：开舞台服务器，给控制台（网页端 client.tsx）用的路由。
 *
 *   GET  /api/dsh-livestream/state      直播状态、设置、舞台地址、能选的角色和模板
 *   POST /api/dsh-livestream/settings   改设置（房间号、角色、模板、音色……）
 *   POST /api/dsh-livestream/connect    连直播间（用 DSH 凭据里的 B 站 Cookie）    /disconnect 断开
 *   POST /api/dsh-livestream/onair      开播 { sessionId }：她直播用的会话（控制台开好的），身体先推开场    /offair 下播（先道别）
 *   POST /api/dsh-livestream/owner      主人跟她说话（排在弹幕前面）
 *   POST /api/dsh-livestream/simulate   模拟观众：不开直播间也能试（弹幕、礼物、进场……）
 *   GET  /api/dsh-livestream/events     控制台的事件流（SSE）：直播间事件、她说的话、大脑状态
 *
 * 盯她的会话、念她说的话、往会话里推事情的部分在 agent 子插件（./agent.ts），挂在「大肥鱼直播」预设下。
 */

import { checkObs, connectObs } from '../body/obs';
import { pollQrLogin, startQrLogin, whoIs } from '../body/biliLogin';
import { SIMULATED_PREFIX } from '../body/show';
import type { LiveEvent, LiveUser } from '../core/live';
import type { GameSource, StageEvent } from '../stage/protocol';
import { splitByMood } from '../core/moodText';
import { speakable } from '../core/speakable';
import { GUEST_VOICE } from '../body/voices';
import { agentReady, asr, broadcast, cookie, DEFAULT_BOARD, hooks, placeGame, publishBoard, publishNotice, SECRETS, social, takeLive, currentCharacter, currentMoods, dm, packs, prepareSpeech, server, settings, show, updateSettings, type Pace, type Settings } from './runtime';

export const name = 'dsh-livestream';
export const inject = ['connection'];

interface HostContext {
  effect(effect: () => () => void, label?: string): unknown;
  [service: string]: any;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (message: string, status = 400) => json({ ok: false, error: message }, status);

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function state() {
  return {
    ok: true,
    show: show.status(),
    broadcast: broadcast.status(),
    settings: { ...settings, stageToken: undefined },
    stageUrl: server.url,
    characters: packs.list('characters'),
    templates: packs.list('templates'),
    asr: { available: asr.available },
    defaultBoard: DEFAULT_BOARD,
  };
}

/** dsh-game 给的画面来源：只认约定里的两种，别的当没有 */
/** 控制台填的节奏：空的项删掉（回到自动），秒数夹在 0～600，一次回几位 1～5，欢迎可以填 off */
function cleanPace(raw: Record<string, unknown>): Pace {
  const sec = (v: unknown) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Math.max(0, Math.min(600, Math.round(Number(v)))));
  const welcome = raw.welcomeSec === 'off' ? 'off' : sec(raw.welcomeSec);
  const thanks = sec(raw.thanksSec), follow = sec(raw.followSec);
  const picks = sec(raw.chatPicks);
  return {
    ...(welcome !== undefined ? { welcomeSec: welcome } : {}),
    ...(thanks !== undefined ? { thanksSec: thanks } : {}),
    ...(follow !== undefined ? { followSec: follow } : {}),
    ...(picks !== undefined ? { chatPicks: Math.max(1, Math.min(5, picks)) } : {}),
  };
}

function gameSource(value: unknown): GameSource | null {
  const v = value as { url?: unknown; window?: unknown; overlay?: unknown } | null;
  const web = (x: unknown): x is string => typeof x === 'string' && /^https?:\/\//.test(x);
  if (v && web(v.url)) return { url: v.url };
  if (v && typeof v.window === 'string' && v.window) return { window: v.window, ...(web(v.overlay) ? { overlay: v.overlay } : {}) };
  return null;
}

let simSeq = 0;
/** 模拟观众：控制台里填的名字和文字 → 一条直播事件 */
function simulated(input: { kind?: string; name?: string; text?: string; gift?: string; count?: number; yuan?: number; guard?: number }): LiveEvent | null {
  const name = (input.name ?? '').trim() || '模拟观众';
  const user: LiveUser = { id: `${SIMULATED_PREFIX}${name}`, name, ...(input.guard ? { guardLevel: input.guard } : {}) };
  const base = { id: `sim-${Date.now()}-${++simSeq}`, platform: 'bilibili' as const, ts: Date.now(), user };
  switch (input.kind) {
    case 'chat': return input.text?.trim() ? { ...base, kind: 'chat', text: input.text.trim() } : null;
    case 'gift': return { ...base, kind: 'gift', giftName: input.gift || '小花花', count: input.count ?? 1, valueYuan: input.yuan ?? 0.1 };
    case 'superchat': return input.text?.trim() ? { ...base, kind: 'superchat', text: input.text.trim(), valueYuan: input.yuan ?? 30 } : null;
    case 'membership': return { ...base, kind: 'membership', levelName: '舰长', level: 3, count: 1, valueYuan: 138 };
    case 'enter': return { ...base, kind: 'enter' };
    case 'follow': return { ...base, kind: 'follow' };
    default: return null;
  }
}

/** 下播后等她道别说完再停推 */
let waitingOffair: NodeJS.Timeout | null = null;
/** 舞台的谢幕画面放多久（stage/store.ts 的 ENDING_MS 是 16 秒）：放完再停推流 */
const ENDING_SCENE_MS = 17_000;

/** 断多久以内算重启（接着播）；更久就当上一场已经结束了 */
const RESUME_WITHIN_MS = 10 * 60_000;

/**
 * 插件起来时，上次停下的那一场还没收尾：恢复她的会话（DSH 的 sessionController 从磁盘接回来，
 * 她的 agent 起来以后推消息、念话的那套也就接上了）、重连直播间、接上还在推的 OBS，告诉她断了多久。
 */
async function resumeLive(ctx: HostContext, stopped: () => boolean): Promise<void> {
  const saved = takeLive();
  if (!saved) return;
  if (Date.now() - saved.at > RESUME_WITHIN_MS) {
    show.closeStale(saved);
    return;
  }
  // DSH 的服务和她的 agent 要一会儿才起来：最多等一分钟
  const deadline = Date.now() + 60_000;
  let resumed = false;
  while (!stopped() && Date.now() < deadline) {
    const controller = ctx.get?.('sessionController');
    if (controller?.agents?.resolveAgent) {
      const result = await controller.agents.resolveAgent(saved.sessionId).catch((err: Error) => ({ error: err }));
      if (!('error' in result)) { resumed = true; break; }
      console.warn(`[dsh-livestream] 恢复她的会话失败：${String(result.error?.message ?? result.error)}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!resumed || stopped()) {
    show.closeStale(saved);
    return;
  }
  // 游戏线的会话也要接回来（不然交给它的话一直送不出去，游戏也开不回来）；接不回来就这场不用游戏线
  if (saved.gameSessionId) {
    const controller = ctx.get?.('sessionController');
    const result = await controller.agents.resolveAgent(saved.gameSessionId).catch((err: Error) => ({ error: err }));
    if ('error' in result) {
      console.warn(`[dsh-livestream] 恢复游戏线的会话失败：${String(result.error?.message ?? result.error)}`);
      saved.gameSessionId = undefined;
      saved.playing = undefined;
    }
  }
  // 等 agent 子插件把推消息的钩子装上
  while (!stopped() && Date.now() < deadline && !agentReady()) await new Promise((r) => setTimeout(r, 500));
  if (saved.roomId) show.connect(saved.roomId, await cookie(), settings.ownRooms.includes(saved.roomId));
  show.resumeLive(saved);
  if (saved.broadcasting && saved.roomId) await broadcast.adopt(saved.roomId);
  const pushing = saved.broadcasting ? `，推流${broadcast.streaming ? '接上了' : '没接上（OBS 已经不在推了）'}` : '（彩排，没在推流）';
  console.warn(`[dsh-livestream] 接着播：会话 ${saved.sessionId}，断了 ${Math.round((Date.now() - saved.at) / 1000)} 秒${pushing}`);
}

export function apply(ctx: HostContext): void {
  ctx.effect(() => {
    server.start().catch((err) => console.warn(`[dsh-livestream] 舞台服务器起不来（端口 ${settings.stagePort}）：${(err as Error).message}`));
    return () => server.stop();
  }, 'dsh-livestream stage server');
  ctx.effect(() => () => show.dispose(), 'dsh-livestream show');
  // 断点续播：上次停下时还在播（DSH 重启、更新插件），接着播
  ctx.effect(() => {
    let stopped = false;
    void resumeLive(ctx, () => stopped).catch((err) => console.warn(`[dsh-livestream] 接着播失败：${(err as Error).message}`));
    return () => { stopped = true; };
  }, 'dsh-livestream resume');
  ctx.effect(() => () => asr.close(), 'dsh-livestream asr');
  // 直播身体：给 dsh-game 用（约定见 docs/game-live-contract.md）。在播时她的话由这里念、游戏画面由这里放上舞台
  ctx.provide('liveBody', {
    get onAir() { return show.isOnAir; },
    attention: (signal: AbortSignal) => show.waitAttention(signal),
    showGame: (source: unknown) => show.showGame(gameSource(source)),
  });
  ctx.effect(() => () => show.showGame(null), 'dsh-livestream game screen');

  const route = (path: string, methods: string[], fetch: (request: Request) => Response | Promise<Response>, label: string) =>
    ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }), label);

  route('/api/dsh-livestream/state', ['GET'], () => json(state()), 'state');

  route('/api/dsh-livestream/settings', ['POST'], async (request) => {
    const patch = await body<Partial<Settings>>(request);
    const next: Partial<Settings> = {};
    if (patch.roomId !== undefined) {
      const room = Number(patch.roomId);
      if (!Number.isInteger(room) || room <= 0) return fail('房间号要是正整数');
      next.roomId = room;
    }
    if (patch.character !== undefined) {
      if (!packs.character(String(patch.character))) return fail('没有这个角色包');
      next.character = String(patch.character);
    }
    if (patch.template !== undefined) {
      if (!packs.template(String(patch.template))) return fail('没有这个模板');
      next.template = String(patch.template);
    }
    if (patch.voice !== undefined) next.voice = String(patch.voice).trim();
    if (patch.idleAfterSec !== undefined) next.idleAfterSec = Math.max(10, Math.min(600, Number(patch.idleAfterSec) || 45));
    if (patch.gameChatGapSec !== undefined) next.gameChatGapSec = Math.max(5, Math.min(120, Number(patch.gameChatGapSec) || 15));
    if (patch.pace !== undefined) next.pace = cleanPace({ ...settings.pace, ...patch.pace });
    if (patch.distillModel !== undefined) next.distillModel = String(patch.distillModel).trim() || settings.distillModel;
    if (patch.broadcast !== undefined) next.broadcast = !!patch.broadcast;
    if (patch.areaId !== undefined) next.areaId = patch.areaId ? Number(patch.areaId) : null;
    if (patch.liveTitle !== undefined) next.liveTitle = String(patch.liveTitle).slice(0, 40);
    if (patch.liveCover !== undefined) next.liveCover = String(patch.liveCover).trim().replace(/^"|"$/g, '');
    if (patch.pushProtocol !== undefined) next.pushProtocol = patch.pushProtocol === 'rtmp' ? 'rtmp' : 'srt';
    if (patch.streamKbps !== undefined) next.streamKbps = Math.max(1000, Math.min(12000, Number(patch.streamKbps) || 4500));
    if (patch.asrPython !== undefined) next.asrPython = String(patch.asrPython).trim().replace(/^"|"$/g, '');
    if (patch.asrModel !== undefined) next.asrModel = String(patch.asrModel).trim() || 'large-v3-turbo';
    if (patch.boardText !== undefined) next.boardText = String(patch.boardText).replace(/\r/g, '').slice(0, 1000);
    if (patch.noticeText !== undefined) next.noticeText = String(patch.noticeText).replace(/\s+/g, ' ').trim().slice(0, 200);
    const own = (patch as { ownRoom?: boolean }).ownRoom;
    if (own !== undefined && settings.roomId) {
      const rooms = new Set(settings.ownRooms);
      if (own) rooms.add(settings.roomId); else rooms.delete(settings.roomId);
      next.ownRooms = [...rooms];
      show.rememberViewers = own && show.status().roomId === settings.roomId;
    }
    const repaint = (next.character && next.character !== settings.character) || (next.template && next.template !== settings.template);
    // 换了 Python 或模型：关掉正在跑的识别进程，下次用新的
    if ((next.asrPython !== undefined && next.asrPython !== settings.asrPython) || (next.asrModel !== undefined && next.asrModel !== settings.asrModel)) asr.close();
    updateSettings(next);
    if (next.boardText !== undefined) publishBoard();
    if (next.noticeText !== undefined) publishNotice();
    if (next.character) show.setNames(currentCharacter()?.names ?? []);
    if (repaint) show.stage.broadcast({ type: 'reload' });
    // 换了主题，游戏位可能挪了：OBS 里的游戏画面跟着挪
    if (next.template && show.gameSource) placeGame(show.gameSource);
    return json(state());
  }, 'settings');

  route('/api/dsh-livestream/connect', ['POST'], async () => {
    if (!settings.roomId) return fail('先填直播间房间号');
    show.connect(settings.roomId, await cookie(), settings.ownRooms.includes(settings.roomId));
    return json(state());
  }, 'connect');

  route('/api/dsh-livestream/disconnect', ['POST'], () => {
    show.disconnect();
    return json(state());
  }, 'disconnect');

  route('/api/dsh-livestream/onair', ['POST'], async (request) => {
    const { sessionId, gameSessionId } = await body<{ sessionId?: string; gameSessionId?: string }>(request);
    if (!sessionId) return fail('缺她直播用的会话');
    show.goLive(sessionId, gameSessionId || undefined);
    // 先推上流、后开播的：这一场一开始就不是彩排
    if (broadcast.streaming) show.markBroadcast();
    dm.newShow();
    social.newShow();
    return json(state());
  }, 'onair');

  route('/api/dsh-livestream/offair', ['POST'], () => {
    show.endLive();
    // 在推流：等她道别说完（这场结束），舞台放完谢幕，再停推、下播（以前一说完就断，观众看不到谢幕）
    if (broadcast.streaming && !waitingOffair) {
      waitingOffair = setInterval(() => {
        if (show.isOnAir) return;
        if (waitingOffair) clearInterval(waitingOffair);
        waitingOffair = null;
        setTimeout(() => void broadcast.stop(), ENDING_SCENE_MS);
      }, 1000);
    }
    return json(state());
  }, 'offair');

  // 推流到 B 站：开播拿推流码、OBS 推流（在后台跑，进度看 state().broadcast）
  route('/api/dsh-livestream/broadcast/start', ['POST'], () => {
    broadcast.start();
    return json(state());
  }, 'broadcast start');

  route('/api/dsh-livestream/broadcast/stop', ['POST'], async () => {
    await broadcast.stop();
    return json(state());
  }, 'broadcast stop');

  // 检查 OBS：没开就打开（在 DSH 所在的桌面会话里），设好专用配置和场景，回一帧节目画面；不推流
  route('/api/dsh-livestream/obs/check', ['POST'], async () => {
    try {
      const obs = await connectObs(true);
      try {
        return json({ ok: true, ...(await checkObs(obs, server.url, settings.streamKbps)) });
      } finally {
        obs.close();
      }
    } catch (err) {
      return fail((err as Error).message, 500);
    }
  }, 'obs check');

  // 开播账号：现在登的是谁；扫码登录（拿到的 Cookie 直接存进 DSH 凭据，不经过网页）
  route('/api/dsh-livestream/account', ['GET'], async () => json({ ok: true, account: await whoIs(await cookie()) }), 'account');
  route('/api/dsh-livestream/login/start', ['POST'], async () => {
    try {
      return json({ ok: true, ...(await startQrLogin()) });
    } catch (err) {
      return fail((err as Error).message, 502);
    }
  }, 'login start');
  route('/api/dsh-livestream/login/poll', ['POST'], async (request) => {
    const { key } = await body<{ key?: string }>(request);
    if (!key) return fail('缺 key');
    try {
      const result = await pollQrLogin(String(key));
      if (result.state !== 'ok') return json({ ok: true, state: result.state, ...(result.state === 'error' ? { message: result.message } : {}) });
      const account = await whoIs(result.cookie);
      if (!account) return json({ ok: true, state: 'error', message: '登录成功了，但用这个 Cookie 查不到账号' });
      await hooks.setSecret(SECRETS.cookie, result.cookie);
      return json({ ok: true, state: 'ok', account });
    } catch (err) {
      return fail((err as Error).message, 502);
    }
  }, 'login poll');

  route('/api/dsh-livestream/owner', ['POST'], async (request) => {
    const { text, who } = await body<{ text?: string; who?: string }>(request);
    if (!text?.trim()) return fail('说点什么');
    show.ownerSay(text, who ? String(who).slice(0, 20) : undefined);
    return json({ ok: true });
  }, 'owner');

  // 嘉宾上直播间说话（Claude 小姐这些在电脑前帮忙管直播的人）：用嘉宾的音色念给观众听，字幕写嘉宾的名字；念完交给她回。念完才返回
  route('/api/dsh-livestream/guest', ['POST'], async (request) => {
    const { who, text, voice } = await body<{ who?: string; text?: string; voice?: string }>(request);
    if (!text?.trim()) return fail('说点什么');
    if (!show.isOnAir) return fail('没在播');
    const name = String(who ?? '').trim().slice(0, 20) || 'Claude小姐';
    const said = await show.guestSay(name, text.slice(0, 300), String(voice ?? '').trim() || GUEST_VOICE, AbortSignal.timeout(120_000));
    return json({ ok: true, said });
  }, 'guest');

  // 念稿：主人写好的话由她原样念出来（口播、公告、彩排台词），不经过她的会话；[mood] 标记照样换表情。念完才返回。
  // prepare: true 只提前合成好语音（一串台词先全部 prepare，念的时候句和句之间不用等合成）
  route('/api/dsh-livestream/say', ['POST'], async (request) => {
    const { text, prepare } = await body<{ text?: string; prepare?: boolean }>(request);
    if (!text?.trim()) return fail('念什么');
    if (prepare) {
      for (const part of splitByMood(text.slice(0, 500), currentMoods())) prepareSpeech(speakable(part.text));
      return json({ ok: true });
    }
    const said: string[] = [];
    for (const part of splitByMood(text.slice(0, 500), currentMoods())) said.push(await show.say(part.text, part.mood, AbortSignal.timeout(120_000)));
    return json({ ok: true, said: said.filter(Boolean) });
  }, 'say');

  route('/api/dsh-livestream/simulate', ['POST'], async (request) => {
    const event = simulated(await body(request));
    if (!event) return fail('模拟的事件不完整');
    show.inject(event);
    return json({ ok: true });
  }, 'simulate');

  // 控制台的事件流：舞台事件（不带语音）+ 每秒一次状态
  route('/api/dsh-livestream/events', ['GET'], () => {
    let unsubscribe: (() => void) | null = null;
    let tick: NodeJS.Timeout | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const send = (text: string) => { try { controller.enqueue(enc.encode(text)); } catch { /* 已关闭 */ } };
        unsubscribe = show.stage.subscribe((event: StageEvent) => {
          if (event.type === 'hello') return;
          send(`data: ${JSON.stringify(event.type === 'say' ? { ...event, audio: null } : event)}\n\n`);
        }, false);
        const status = () => {
          send(`event: status\ndata: ${JSON.stringify(show.status())}\n\n`);
          send(`event: broadcast\ndata: ${JSON.stringify(broadcast.status())}\n\n`);
        };
        tick = setInterval(status, 1000);
        status();
      },
      cancel() {
        unsubscribe?.();
        if (tick) clearInterval(tick);
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }, 'events');
}

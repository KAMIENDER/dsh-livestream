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
import { FarmGrantStorageError } from '../core/farm-access';
import { access, agentReady, asr, broadcast, cookie, DEFAULT_BOARD, hooks, placeGame, publishBoard, publishNotice, SECRETS, social, takeLive, currentCharacter, currentMoods, dm, packs, prepareSpeech, server, settings, show, updateSettings, type BlockedViewer, type Pace, type Settings } from './runtime';

export const name = 'dsh-livestream';
export const inject = ['connection', 'tools'];

interface HostContext {
  effect(effect: () => () => void, label?: string): unknown;
  [service: string]: any;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (message: string, status = 400) => json({ ok: false, error: message }, status);

const scopedAgents = new WeakSet<object>();
let hasCharacters = () => false;
function bindProtectedAgent(ctx: HostContext, id: string): boolean {
  const found = ctx.get?.('agents')?.get?.(id);
  const agent = found?.agent ?? found;
  if (!agent?.ctx?.tools?.guard) return false;
  if (scopedAgents.has(agent)) return true;
  // Register via the ACTUAL agent context. SDK scope ancestry then carries this monotonic guard
  // to descendants; importing a separately bundled dsh-scope WeakMap would not share ancestry.
  // Owned by the actual agent context, not by this host plugin's lifetime. If the owner
  // disables the host while an agent survives, access.ready=false must still stop that
  // tainted agent; removing its last scoped guard here would silently elevate it.
  agent.ctx.tools.guard((exec: any) => {
    try {
      if (exec.agent?.id && exec.agent.id !== id) access.inherit(exec.agent.id, id);
      return access.guard(exec);
    } catch { return '无法继承直播权限，已拒绝子会话工具。'; }
  });
  scopedAgents.add(agent); return true;
}

function verifyLiveAgents(ctx: HostContext, sessionId: string, gameId?: string): void {
  const expected: Array<[string, string[]]> = [[sessionId, ['dsh-livestream', 'dsh-character-live']]];
  if (gameId) expected.push([gameId, settings.gamePreset === 'dsh-stardew' ? ['dsh-stardew', 'dsh-character-stardew'] : ['dsh-livestream-game']]);
  let selected: { profile: { id: string }; revision: number } | undefined;
  for (const [id, presets] of expected) {
    const found = ctx.get?.('agents')?.get?.(id);
    const agent = found?.agent ?? found;
    if (!presets.includes(agent?.session?.header?.agentPreset) || !bindProtectedAgent(ctx, id)) {
      throw new Error('只能使用匹配直播/游戏预设且具有执行 guard 的专用会话；不能把普通开发会话直接拿来接收弹幕。');
    }
    if (agent.session.header.agentPreset.startsWith('dsh-character-')) {
      const service = ctx.get?.('characterMemory');
      if (typeof service?.bindSession !== 'function') throw new Error('人物服务缺少会话绑定接口，请更新人物插件并新建会话。');
      const binding = service.bindSession(agent, true);
      if (selected && (selected.profile.id !== binding.profile.id || selected.revision !== binding.revision)) throw new Error('直播线和游戏线绑定的人物/版本不同，不能混播；请用同一默认人物新建本场会话。');
      selected = binding;
    }
  }
}

function syncCharacterNames(ctx: HostContext, sessionId = show.status().brainSession): void {
  const found = sessionId ? ctx.get?.('agents')?.get?.(sessionId) : undefined;
  const agent = found?.agent ?? found;
  const profile = agent?.session?.header?.agentPreset === 'dsh-character-live' ? ctx.get?.('characterMemory')?.bindingFor?.(sessionId)?.profile : undefined;
  show.setNames(profile ? [profile.name, ...profile.aliases] : currentCharacter()?.names ?? []);
}

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
    characterReady: hasCharacters(),
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

/** 控制台填的黑名单：UID 是数字串；同一个 UID 只留一条 */
function cleanBlocked(raw: unknown): BlockedViewer[] {
  const out = new Map<string, BlockedViewer>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const b = item as Partial<BlockedViewer>;
    const uid = String(b.uid ?? '').trim();
    if (!/^\d{1,20}$/.test(uid)) continue;
    out.set(uid, { uid, name: String(b.name ?? '').trim().slice(0, 40), why: String(b.why ?? '').trim().slice(0, 200), at: Number(b.at) || Date.now() });
  }
  return [...out.values()];
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
  // Register persisted session identities before resolveAgent can resume any model/tool execution.
  access.protect(saved.sessionId, saved.gameSessionId);
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
  verifyLiveAgents(ctx, saved.sessionId, saved.gameSessionId);
  syncCharacterNames(ctx, saved.sessionId);
  show.resumeLive(saved);
  if (saved.broadcasting && saved.roomId) await broadcast.adopt(saved.roomId);
  const pushing = saved.broadcasting ? `，推流${broadcast.streaming ? '接上了' : '没接上（OBS 已经不在推了）'}` : '（彩排，没在推流）';
  console.warn(`[dsh-livestream] 接着播：会话 ${saved.sessionId}，断了 ${Math.round((Date.now() - saved.at) / 1000)} 秒${pushing}`);
}

export function apply(ctx: HostContext): void {
  hasCharacters = () => typeof ctx.get?.('characterMemory')?.bindSession === 'function';
  ctx.effect(() => access.bindFarmResolver((id, workflow, text) => {
    // Resolve identity in the actual game host. Parameters and viewer text cannot choose
    // a session, save, build or a production job's original material budget.
    if (!show.isOnAir || show.currentGameSession !== id) return undefined;
    return ctx.get?.('stardewControl')?.autonomyFor?.(id, workflow, text);
  }), 'owner bounded farm authorization identity');
  ctx.effect(() => {
    const syncForget = (uid: string) => {
      const memory = ctx.get?.('characterMemory');
      if (!memory?.forgetViewer) return false;
      memory.forgetViewer(uid); return true;
    };
    hooks.onViewerForget = syncForget;
    return () => { if (hooks.onViewerForget === syncForget) hooks.onViewerForget = () => false; };
  }, 'platform self-forget propagation');
  ctx.effect(() => {
    if (typeof ctx.tools?.guard !== 'function') return () => {};
    const dispose = ctx.tools.guard((exec: any) => {
      try {
        const parent = exec.agent?.session?.header?.parentSession;
        if (parent && exec.agent?.id) access.inherit(exec.agent.id, parent);
        if (exec.agent?.id && access.protected(exec.agent.id)) bindProtectedAgent(ctx, exec.agent.id);
        return access.guard(exec);
      }
      catch { return '直播权限校验异常，已拒绝本次工具；不能绕过校验执行。'; }
    });
    access.ready = true;
    return () => { access.ready = false; dispose(); };
  }, 'dsh-livestream monotonic execution guard');
  ctx.effect(() => ctx.on('agent/created', ({ agent }: any) => {
    const parent = ctx.get?.('agents')?.currentInitiator?.();
    if (parent?.id && agent?.id && parent.id !== agent.id) access.inherit(agent.id, parent.id);
    if (agent?.id && access.protected(agent.id)) bindProtectedAgent(ctx, agent.id);
  }), 'dsh-livestream child authority inheritance');
  // Consumers receive inspection only; no model-facing service can grant itself owner rights.
  ctx.provide('liveAccess', Object.freeze({ protected: (id: string) => access.protected(id), farmPermissionsFor: (id: string) => access.farmPermissionsFor(id) }));
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
    get gameSessionId() { return show.currentGameSession; },
    attention: (signal: AbortSignal) => show.waitAttention(signal),
    canRememberViewer: (uid: string) => !show.optedOut(uid) && !show.isBlocked(uid),
    showGame: (source: unknown) => show.showGame(gameSource(source)),
  });
  ctx.effect(() => () => show.showGame(null), 'dsh-livestream game screen');

  const route = (path: string, methods: string[], fetch: (request: Request) => Response | Promise<Response>, label: string) =>
    ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch: (request: Request) => {
      if (request.method !== 'GET' && !access.ownerRequest(request)) return fail('仅主人控制台可以修改直播状态或权限。', 403);
      return fetch(request);
    } }), label);

  route('/api/dsh-livestream/state', ['GET'], () => {
    // Native connection.fetch exact routes are owner-only. This nonce supplements that
    // authenticated boundary and is never served from the separately bound stage server.
    const response = json(state());
    response.headers.set('x-dsh-live-control', access.controlHeader());
    return response;
  }, 'state');

  route('/api/dsh-livestream/access', ['GET'], request => access.ownerRequest(request)
    ? json({ ok: true, access: access.status() }) : fail('只有主人控制台可查看待审操作。', 403), 'live permissions');
  route('/api/dsh-livestream/access/review', ['POST'], async request => {
    const input = await body<{ id?: string; allow?: boolean }>(request);
    try { access.review(String(input.id ?? ''), input.allow === true); return json({ ok: true, access: access.status() }); }
    catch (error) { return fail((error as Error).message); }
  }, 'review live tool');
  route('/api/dsh-livestream/access/farm/grant', ['POST'], async request => {
    const input = await body<{ id?: string; calls?: number; minutes?: number }>(request);
    try {
      const session = show.currentGameSession;
      if (!show.isOnAir || !session) return fail('当前没有在播游戏线，未创建经营授权。');
      access.grantFarm(String(input.id ?? ''), session, input.calls ?? 1, input.minutes ?? 60);
      return json({ ok: true, access: access.status() });
    } catch (error) { return fail((error as Error).message); }
  }, 'grant bounded farm autonomy');
  route('/api/dsh-livestream/access/farm/revoke', ['POST'], async request => {
    const input = await body<{ id?: string }>(request);
    let failure: Error | undefined;
    try { access.revokeFarm(String(input.id ?? '')); }
    catch (error) {
      if (!(error instanceof FarmGrantStorageError)) return fail((error as Error).message);
      failure = error;
    }
    // A semantic workflow has already reserved its whole envelope. Cancelling the real
    // driver prevents subsequent internal substeps; changing a UI badge alone would not.
    const session = show.currentGameSession;
    if (session) await ctx.get?.('stardewControl')?.stopSession?.(session);
    if (failure) return fail(failure.message);
    return json({ ok: true, access: access.status() });
  }, 'revoke farm autonomy and stop active control');
  route('/api/dsh-livestream/access/proposal', ['POST'], async request => {
    const input = await body<{ id?: string; allow?: boolean }>(request);
    try {
      const id = String(input.id ?? '');
      const proposal = access.proposal(id);
      if (input.allow === true && !show.ownerGameSuggestion(proposal.text, proposal.who)) return fail('游戏线不在线；建议未执行。');
      access.takeProposal(id);
      return json({ ok: true, access: access.status() });
    } catch (error) { return fail((error as Error).message); }
  }, 'review audience suggestion');
  route('/api/dsh-livestream/access/revoke', ['POST'], async () => {
    access.revoke();
    const game = show.currentGameSession;
    const control = ctx.get?.('stardewControl');
    if (game && control?.stopSession) await control.stopSession(game);
    return json({ ok: true, access: access.status() });
  }, 'revoke live tools');

  const character = () => {
    const service = ctx.get?.('characterMemory');
    if (!service) throw new Error('请先安装并启用 dsh-character 人物与长期记忆插件。');
    return service;
  };
  const characterState = (service: any, state = 'pending', offset = 0, bindingOffset = 0) => ({
    ok: true, active: service.active(), profiles: service.listProfiles(),
    history: service.history(service.active().profile.id), memories: service.list(state, offset, 20), memoryState: state, offset,
    bindings: service.listBindings(bindingOffset, 20),
  });
  route('/api/dsh-livestream/character', ['GET'], request => {
    if (!access.ownerRequest(request)) return fail('仅主人控制台可以查看完整人物和私密记忆。', 403);
    try {
      const url = new URL(request.url);
      return json(characterState(character(), url.searchParams.get('state') ?? 'pending', Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('bindingOffset') ?? 0)));
    } catch (error) { return fail((error as Error).message, 409); }
  }, 'character and memory inspection');
  route('/api/dsh-livestream/character', ['POST'], async request => {
    const input = await body<Record<string, any>>(request);
    try {
      const service = character();
      switch (input.action) {
        case 'save_profile': service.saveProfile(input.profile); break;
        case 'activate': service.activate(String(input.id ?? '')); break;
        case 'restore_profile': service.restore(String(input.id ?? ''), Number(input.revision)); break;
        case 'add_memory': service.ownerAdd(input.memory); break;
        case 'review_memory': service.review(String(input.id ?? ''), input.accept === true, input.visibility); break;
        case 'correct_memory': service.correct(String(input.id ?? ''), input.memory); break;
        case 'forget_memory': service.forget(String(input.id ?? '')); break;
        case 'forget_subject': service.forgetSubject(String(input.scope ?? ''), String(input.subject ?? '')); break;
        default: return fail('未知人物或记忆操作。');
      }
      syncCharacterNames(ctx);
      return json(characterState(service));
    } catch (error) { return fail((error as Error).message); }
  }, 'owner-managed character and memory changes');

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
    if (patch.gamePreset !== undefined) {
      if (!['dsh-livestream-game', 'dsh-stardew'].includes(patch.gamePreset)) return fail('没有这个游戏预设');
      next.gamePreset = patch.gamePreset;
    }
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
    if (patch.blocked !== undefined) next.blocked = cleanBlocked(patch.blocked);
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
    if (next.character) syncCharacterNames(ctx);
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
    try { access.protect(sessionId, gameSessionId); verifyLiveAgents(ctx, sessionId, gameSessionId); }
    catch (error) { return fail((error as Error).message, 409); }
    syncCharacterNames(ctx, sessionId);
    show.goLive(sessionId, gameSessionId || undefined);
    if (settings.gamePreset === 'dsh-stardew' && gameSessionId) {
      show.ownerToGame('开始星露谷今天的自主经营：用 game_start 的 stardew 接管主角，先观察农场并安排今天，正常睡眠进入次日后总结并停止。');
    }
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

  // 点单队列：主人改一单的状态（{ id, state: queued|doing|done|dropped }），或者清空（{ clear: true }）
  route('/api/dsh-livestream/orders', ['POST'], async (request) => {
    const { id, state: to, clear } = await body<{ id?: number; state?: string; clear?: boolean }>(request);
    const ok = (['queued', 'doing', 'done', 'dropped'] as const).find((s) => s === to);
    return show.ownerOrders({ id: Number(id) || undefined, state: ok, clear: !!clear }) ? json(state()) : fail('没有这一单，或者状态不对');
  }, 'orders');

  route('/api/dsh-livestream/owner', ['POST'], async (request) => {
    const { text, who, line } = await body<{ text?: string; who?: string; line?: string }>(request);
    if (!text?.trim()) return fail('说点什么');
    // line: 'game'：只交给游戏线（长图纸、坐标清单这类只关游戏的事），直播线不经手
    if (line === 'game') return show.ownerToGame(text) ? json({ ok: true }) : fail('这场没开游戏线');
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

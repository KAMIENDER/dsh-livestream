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

import { SIMULATED_PREFIX } from '../body/show';
import type { LiveEvent, LiveUser } from '../core/live';
import type { StageEvent } from '../stage/protocol';
import { cookie, currentCharacter, packs, server, settings, show, updateSettings, type Settings } from './runtime';

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
    settings: { ...settings, stageToken: undefined },
    stageUrl: server.url,
    characters: packs.list('characters'),
    templates: packs.list('templates'),
  };
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

export function apply(ctx: HostContext): void {
  ctx.effect(() => {
    server.start().catch((err) => console.warn(`[dsh-livestream] 舞台服务器起不来（端口 ${settings.stagePort}）：${(err as Error).message}`));
    return () => server.stop();
  }, 'dsh-livestream stage server');
  ctx.effect(() => () => show.dispose(), 'dsh-livestream show');

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
    if (patch.distillModel !== undefined) next.distillModel = String(patch.distillModel).trim() || settings.distillModel;
    const repaint = (next.character && next.character !== settings.character) || (next.template && next.template !== settings.template);
    updateSettings(next);
    if (next.character) show.setNames(currentCharacter()?.names ?? []);
    if (repaint) show.stage.broadcast({ type: 'reload' });
    return json(state());
  }, 'settings');

  route('/api/dsh-livestream/connect', ['POST'], async () => {
    if (!settings.roomId) return fail('先填直播间房间号');
    show.connect(settings.roomId, await cookie());
    return json(state());
  }, 'connect');

  route('/api/dsh-livestream/disconnect', ['POST'], () => {
    show.disconnect();
    return json(state());
  }, 'disconnect');

  route('/api/dsh-livestream/onair', ['POST'], async (request) => {
    const { sessionId } = await body<{ sessionId?: string }>(request);
    if (!sessionId) return fail('缺她直播用的会话');
    show.goLive(sessionId);
    return json(state());
  }, 'onair');

  route('/api/dsh-livestream/offair', ['POST'], () => {
    show.endLive();
    return json(state());
  }, 'offair');

  route('/api/dsh-livestream/owner', ['POST'], async (request) => {
    const { text } = await body<{ text?: string }>(request);
    if (!text?.trim()) return fail('说点什么');
    show.ownerSay(text);
    return json({ ok: true });
  }, 'owner');

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
        tick = setInterval(() => send(`event: status\ndata: ${JSON.stringify(show.status())}\n\n`), 1000);
        send(`event: status\ndata: ${JSON.stringify(show.status())}\n\n`);
      },
      cancel() {
        unsubscribe?.();
        if (tick) clearInterval(tick);
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }, 'events');
}

/**
 * 舞台页的状态：只从事件流来（protocol.ts）。挂件都读这里，不发请求、不含逻辑。
 * 唯一往回发的是「这句念完了」（出声的页面才发；预览页静音、不回执）。
 */

import type { BrainState, CharacterManifest, StageEvent, StageLiveEvent, StageUser, TemplateManifest } from './protocol';

export interface ChatRow {
  id: string;
  event: Extract<StageLiveEvent, { kind: 'chat' }>;
  at: number;
}

export interface Alert {
  key: string;
  event: Exclude<StageLiveEvent, { kind: 'chat' }>;
  at: number;
}

/** 「她在回」卡片的一条：那位观众和他说的话（focus 那一刻从最近的事件里找） */
export interface ReplyItem {
  key: string;
  event: StageLiveEvent;
}

export interface Line {
  id: string;
  text: string;
  mood: string;
  startedAt: number;
  durationMs: number;
  /** 逐字时间（音频毫秒 → 亮到第几个字）；没有就按 durationMs 匀速 */
  timeline?: Array<{ chars: number; atMs: number }>;
}

/** 这句念到了第几毫秒：有在放的音频就读它的真实播放位置，不然按开始以来的时间 */
export function playbackMs(line: Line): number {
  if (audio && audioLine === line.id && !audio.paused) return audio.currentTime * 1000;
  return Date.now() - line.startedAt;
}

/**
 * 字幕该亮到第几个字。逐字时间里一个点常常一次跨好几个字（豆包按词给），
 * 这几个字在前后两个点之间均匀地一个个亮，字幕像流出来一样，不会几个字一起蹦出来再停住
 */
export function litChars(line: Line, length: number): number {
  const ms = playbackMs(line);
  if (line.timeline?.length) {
    let prev = { chars: 0, atMs: 0 };
    for (const p of line.timeline) {
      if (p.atMs > ms) {
        const span = p.atMs - prev.atMs;
        const f = span > 0 ? Math.min(1, Math.max(0, (ms - prev.atMs) / span)) : 1;
        return Math.max(prev.chars, Math.floor(prev.chars + (p.chars - prev.chars) * f));
      }
      prev = p;
    }
    return prev.chars;
  }
  return Math.round(length * Math.min(1, ms / Math.max(1, line.durationMs)));
}

/** 一场直播的阶段：开播前等待 → 开场动画 → 直播中 → 谢幕（之后回到等待） */
export type ShowPhase = 'waiting' | 'opening' | 'live' | 'ending';

/** 这场直播到现在的数（谢幕时的感谢名单也从这里来） */
export interface ShowStats {
  startedAt: number;
  chats: number;
  viewers: number;
  peakOnline: number;
  /** 送过礼物、醒目留言、上舰的人（按花的钱从多到少） */
  supporters: Array<{ name: string; yuan: number }>;
}

/** 终端的一行 */
export interface TermLine {
  id: number;
  at: number;
  tag: string;
  text: string;
}

export interface StageState {
  connected: boolean;
  character: CharacterManifest | null;
  template: TemplateManifest | null;
  brain: BrainState;
  brainDetail: string;
  line: Line | null;
  /** 最近一句说完的时刻（字幕淡出用） */
  lineEndedAt: number;
  chats: ChatRow[];
  alerts: Alert[];
  focus: Set<string>;
  /** 她正在回应的那几条（她回完就清空） */
  reply: ReplyItem[];
  /** 每来一次 focus 加一：卡片重新入场 */
  replySeq: number;
  online?: number;
  onAir: boolean;
  phase: ShowPhase;
  stats: ShowStats;
  /** 这场直播她用掉的 token */
  tokens: number;
  model: string;
  term: TermLine[];
  /** 浏览器拦住了自动播放：要点一下 */
  needsClick: boolean;
}

const MAX_CHATS = 30;
const MAX_ALERTS = 6;
/** 「她在回」从这里找观众说过的话：比弹幕列表留得久，礼物、醒目留言、进场都在 */
const MAX_RECENT = 120;
const recent: StageLiveEvent[] = [];
const MAX_TERM = 40;
/** 开场动画、谢幕各放多久 */
export const OPENING_MS = 5200;
export const ENDING_MS = 16_000;
/** 连上以后这么短的时间里收到的「在播」是补发的当前状态（中途打开舞台），不放开场动画 */
const CATCHUP_MS = 2000;

const viewers = new Set<string>();
const supporters = new Map<string, { name: string; yuan: number }>();
let helloAt = 0;
let phaseTimer: ReturnType<typeof setTimeout> | null = null;
let termSeq = 0;

function freshStats(): ShowStats {
  viewers.clear();
  supporters.clear();
  return { startedAt: Date.now(), chats: 0, viewers: 0, peakOnline: 0, supporters: [] };
}

let state: StageState = {
  connected: false, character: null, template: null, brain: 'off', brainDetail: '', line: null, lineEndedAt: 0,
  chats: [], alerts: [], focus: new Set(), reply: [], replySeq: 0, onAir: false, needsClick: false,
  phase: 'waiting', stats: freshStats(), tokens: 0, model: '', term: [],
};
const subscribers = new Set<() => void>();

export function getState(): StageState {
  return state;
}

export function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

function update(change: (s: StageState) => StageState): void {
  state = change(state);
  for (const notify of subscribers) notify();
}

// ── 连接 ─────────────────────────────────────────────

const params = new URLSearchParams(location.search);
export const token = params.get('token') ?? '';
/** 控制台里的预览：静音、不回执 */
export const preview = params.get('preview') === '1';
/** 控制台里刚换了主题：预览页演示一遍开场动画和直播中的样子（只在预览页、没在播的时候） */
const demo = preview && params.has('demo');

export function assetUrl(kind: 'characters' | 'templates', id: string, file: string): string {
  return `/${kind}/${id}/${encodeURIComponent(file)}?token=${encodeURIComponent(token)}`;
}

let audio: HTMLAudioElement | null = null;
/** 正在放的音频是哪一句的 */
let audioLine: string | null = null;
let pendingClick: (() => void) | null = null;

function said(id: string): void {
  if (!preview) void fetch(`/said?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
}

function endLine(id: string): void {
  update((s) => (s.line?.id === id ? { ...s, line: null, lineEndedAt: Date.now() } : s));
  said(id);
}

function onSay(event: Extract<StageEvent, { type: 'say' }>): void {
  audio?.pause();
  const begin = (durationMs: number) => update((s) => ({ ...s, line: { id: event.id, text: event.text, mood: event.mood, startedAt: Date.now(), durationMs, timeline: event.timeline } }));
  const fallback = () => {
    begin(event.estimateMs);
    setTimeout(() => endLine(event.id), event.estimateMs);
  };
  if (!event.audio || preview) return fallback();
  const player = new Audio(`data:audio/mpeg;base64,${event.audio}`);
  audio = player;
  audioLine = event.id;
  player.onloadedmetadata = () => begin(Number.isFinite(player.duration) ? player.duration * 1000 : event.estimateMs);
  player.onended = () => endLine(event.id);
  player.onerror = fallback;
  player.play().catch(() => {
    // 普通浏览器标签页没交互过不让出声（OBS 的浏览器源可以）：先按字数走，提示点一下
    update((s) => ({ ...s, needsClick: true }));
    pendingClick = () => update((s) => ({ ...s, needsClick: false }));
    fallback();
  });
}

export function unlockAudio(): void {
  void new Audio().play().catch(() => {});
  pendingClick?.();
  pendingClick = null;
}

let alertSeq = 0;

function remember(event: StageLiveEvent): void {
  const i = recent.findIndex((e) => e.id === event.id);
  if (i >= 0) recent[i] = event;
  else recent.push(event);
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
}

/** 每位被回应的观众最近的一件事（一人一条，按事件先后） */
function replyItems(userIds: string[]): ReplyItem[] {
  const items: ReplyItem[] = [];
  // 同一位观众一轮里可能出现两次（先送礼又上舰）：只列一次
  for (const id of new Set(userIds)) {
    const event = recent.findLast((e) => e.user.id === id);
    if (event) items.push({ key: `${event.id}`, event });
  }
  return items.sort((a, b) => recent.indexOf(a.event) - recent.indexOf(b.event));
}

// ── 终端 ─────────────────────────────────────────────

function term(s: StageState, tag: string, text: string): StageState {
  return { ...s, term: [...s.term, { id: ++termSeq, at: Date.now(), tag, text }].slice(-MAX_TERM) };
}

function short(text: string, max = 22): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

const MOOD_TEXT: Record<string, string> = { laugh: '笑', shy: '害羞', angry: '生气', sad: '难过', scared: '害怕', shocked: '吃惊', think: '想' };

// ── 开播、下播 ─────────────────────────────────────────

function setPhase(phase: ShowPhase, after?: { ms: number; next: ShowPhase }): void {
  if (phaseTimer) clearTimeout(phaseTimer);
  phaseTimer = after ? setTimeout(() => setPhase(after.next), after.ms) : null;
  update((s) => ({ ...s, phase }));
}

/** 开没开播变了：刚连上时补发来的状态直接到位，真的开播放开场、真的下播放谢幕 */
function onAirChanged(onAir: boolean): void {
  const s = state;
  if (onAir === s.onAir && !(onAir && s.phase === 'waiting')) return;
  const catchingUp = Date.now() - helloAt < CATCHUP_MS;
  if (onAir) {
    update((x) => term({ ...x, onAir: true, stats: freshStats(), tokens: 0 }, 'live', catchingUp ? '舞台连上，正在直播' : '开播'));
    if (catchingUp) setPhase('live');
    else setPhase('opening', { ms: OPENING_MS, next: 'live' });
  } else {
    update((x) => term({ ...x, onAir: false }, 'live', '下播'));
    if (catchingUp || s.phase === 'waiting') setPhase('waiting');
    else setPhase('ending', { ms: ENDING_MS, next: 'waiting' });
  }
}

/** 上舰按舰长的价钱算（谢幕名单排序用） */
const GUARD_YUAN = 138;

function countLive(s: StageState, event: StageLiveEvent, isUpdate: boolean): StageState {
  viewers.add(event.user.id);
  const stats = { ...s.stats, viewers: viewers.size };
  if (event.kind === 'chat' && !isUpdate) stats.chats += 1;
  const value = event.kind === 'gift' || event.kind === 'superchat' ? event.yuan : event.kind === 'membership' ? GUARD_YUAN * Math.max(1, event.count) : 0;
  if (value > 0) {
    // 礼物连击：同一个 id 再来时是更新后的总数，按 id 记一份
    supporters.set(event.id, { name: event.user.name, yuan: value });
    const byName = new Map<string, number>();
    for (const { name, yuan } of supporters.values()) byName.set(name, (byName.get(name) ?? 0) + yuan);
    stats.supporters = [...byName].map(([name, yuan]) => ({ name, yuan: Math.round(yuan * 10) / 10 })).sort((x, y) => y.yuan - x.yuan);
  }
  return { ...s, stats };
}

function onLive(event: StageLiveEvent, isUpdate: boolean): void {
  remember(event);
  update((s) => {
    let next = countLive(s, event, isUpdate);
    if (!isUpdate) {
      if (event.kind === 'gift') next = term(next, 'gift', `${event.user.name} 送出 ${event.gift} ×${event.count}`);
      else if (event.kind === 'superchat') next = term(next, 'sc', `${event.user.name} ¥${event.yuan}：${short(event.text, 18)}`);
      else if (event.kind === 'membership') next = term(next, 'gift', `${event.user.name} 开通了${event.level}`);
    }
    return next;
  });
  if (event.kind === 'chat') {
    if (isUpdate) return;
    update((s) => ({ ...s, chats: [...s.chats, { id: event.id, event, at: Date.now() }].slice(-MAX_CHATS) }));
    return;
  }
  // 礼物连击：同 id 更新数量，不再弹一次
  update((s) => {
    const existing = s.alerts.findIndex((a) => a.event.id === event.id);
    if (existing >= 0) {
      const alerts = s.alerts.slice();
      alerts[existing] = { ...alerts[existing], event };
      return { ...s, alerts };
    }
    if (isUpdate) return s;
    return { ...s, alerts: [...s.alerts, { key: `a${++alertSeq}`, event, at: Date.now() }].slice(-MAX_ALERTS) };
  });
}

export function dropAlert(key: string): void {
  update((s) => ({ ...s, alerts: s.alerts.filter((a) => a.key !== key) }));
}

function onBrain(event: Extract<StageEvent, { type: 'brain' }>): void {
  update((s) => {
    let next: StageState = {
      ...s, brain: event.state, brainDetail: event.detail ?? (event.state === s.brain ? s.brainDetail : ''),
      // 这一轮回完了：不再标「正在回你」
      ...(event.state === 'thinking' || event.state === 'speaking' ? {} : { focus: new Set<string>(), reply: [] }),
    };
    if (event.state === 'thinking' && event.detail) next = term(next, 'push', event.detail);
    if (event.state === 'away') next = term(next, 'warn', event.detail || '她的会话不在线');
    return next;
  });
  // 她在动就是在播（旧版身体连上时不补发 room 事件）
  if (event.state !== 'off' && !state.onAir) onAirChanged(true);
}

function handle(event: StageEvent): void {
  switch (event.type) {
    case 'hello':
      helloAt = Date.now();
      update((s) => ({ ...s, connected: true, character: event.character, template: event.template }));
      if (demo && !demoStarted) startDemo(event.character.name);
      return;
    case 'say':
      update((s) => term(s, 'say', `${MOOD_TEXT[event.mood] ? `（${MOOD_TEXT[event.mood]}）` : ''}${short(event.text, 26)}`));
      return onSay(event);
    case 'brain': return onBrain(event);
    case 'live': return onLive(event.event, event.isUpdate);
    case 'focus': return update((s) => ({ ...s, focus: new Set(event.userIds), reply: replyItems(event.userIds), replySeq: s.replySeq + 1 }));
    case 'room':
      update((s) => ({ ...s, online: event.online, stats: { ...s.stats, peakOnline: Math.max(s.stats.peakOnline, event.online ?? 0) } }));
      return onAirChanged(event.onAir);
    case 'usage':
      return update((s) => {
        const next = { ...s, tokens: event.tokens, model: event.model ?? s.model };
        return event.turn ? term(next, 'token', `+${event.turn.toLocaleString()}${event.model ? ` · ${event.model}` : ''} · 累计 ${event.tokens.toLocaleString()}`) : next;
      });
    case 'reload': location.reload(); return;
  }
}

// ── 换主题时的演示（只在控制台预览里）────────────────

let demoStarted = false;

/** 先放开场动画，再来几条示例弹幕、她说一句：看得出这个主题直播时是什么样 */
function startDemo(name: string): void {
  demoStarted = true;
  setTimeout(() => {
    // 补发过来的状态说明真的在播：不演示
    if (state.onAir) return;
    setPhase('opening', { ms: OPENING_MS, next: 'live' });
    const at = Date.now();
    const user = (id: string, n: string, guard?: number): StageUser => ({ id: `demo:${id}`, name: n, ...(guard ? { guard } : {}) });
    const chats: Array<[string, string, number?]> = [['晚风', '晚上好呀！'], ['橘子汽水', '这个主题好可爱', 3], ['放学路上', `${name}今天吃了几碗饭？`], ['云朵收集者', '来啦来啦']];
    const v = 1 as const;
    const script: Array<[number, StageEvent]> = [
      ...chats.map(([n, text, guard], i) => [OPENING_MS + 300 + i * 450, { v, type: 'live', isUpdate: false, at, event: { kind: 'chat', id: `demo-${i}`, user: user(n, n, guard), text } }] as [number, StageEvent]),
      [OPENING_MS + 2200, { v, type: 'live', isUpdate: false, at, event: { kind: 'gift', id: 'demo-gift', user: user('晚风', '晚风'), gift: '小花花', count: 5, yuan: 0.5 } }],
      [OPENING_MS + 2400, { v, type: 'usage', tokens: 12_800, turn: 640, at }],
      [OPENING_MS + 2600, { v, type: 'focus', userIds: ['demo:放学路上'], at }],
      [OPENING_MS + 2700, { v, type: 'say', id: 'demo-say', text: `放学路上，今天吃了三碗！${name}的小屋装修好啦，大家随便坐～`, mood: 'laugh', audio: null, estimateMs: 5200, at }],
    ];
    for (const [ms, event] of script) setTimeout(() => handle(event), ms);
  }, CATCHUP_MS);
}

export function connect(): void {
  const source = new EventSource(`/events?token=${encodeURIComponent(token)}${preview ? '&preview=1' : ''}`);
  source.onmessage = (message) => {
    try {
      handle(JSON.parse(message.data) as StageEvent);
    } catch {
      // 认不出的事件跳过（新版本的事件旧舞台不认识）
    }
  };
  source.onerror = () => update((s) => ({ ...s, connected: false }));
  source.onopen = () => update((s) => ({ ...s, connected: true }));
}

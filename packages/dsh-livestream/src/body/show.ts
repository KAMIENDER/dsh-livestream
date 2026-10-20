/**
 * 一场直播的身体：连着直播间、看着注意力层，把「现在该说的事」交给大脑，把大脑写的话念出来。
 *
 *   一场直播 = 大脑的一个会话，完整保留历史。身体在她空下来时（上一轮结束、话也念完了）挑出下一件事，
 *   作为一条消息推进这个会话；她回复的正文就是说出口的话，写出一段念一段（见 dsh/agent.ts）。
 *   节奏全归身体管：她在想、在说的时候不推新的；主人的话、开场、谢幕排在弹幕前面。
 *
 * 不碰 DSH：推消息、TTS、提炼用的模型、记录目录都由插件从外面给（ShowHooks）。
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LiveAttention } from '../core/attention/attention';
import { setHerNames } from '../core/attention/features';
import type { Topic, TopicBody } from '../core/attention/topics';
import { LiveHub } from '../core/hub';
import type { LiveEvent, LiveStatus, LiveUser } from '../core/live';
import { distillStream, type DistillLlm } from '../core/memory/distill';
import { LiveMemory } from '../core/memory/memory';
import { LiveMemoryStore } from '../core/memory/store';
import { cleanName, cleanText } from '../core/safety';
import { speakable } from '../core/speakable';
import { topicText } from '../core/topicText';
import { lookupViewer, type ViewerLookup } from '../core/viewerLookup';
import type { BrainState, StageLiveEvent, StageUser } from '../stage/protocol';
import { Stage } from './stage';

export interface ShowHooks {
  /** 把一件事作为一条消息推进她的会话（唤醒她）；会话不在线返回 false */
  push(sessionId: string, text: string): Promise<boolean>;
  /** 合成一句话的语音（mp3）和逐字时间；没配密钥或失败返回 null（只有字幕，按字数走） */
  synthesize(text: string, signal: AbortSignal): Promise<{ audio: Uint8Array; timeline: Array<{ chars: number; atMs: number }> } | null>;
  /** 下播后提炼观众记忆用的模型 */
  distill?: DistillLlm;
  log?(level: 'info' | 'warn', message: string): void;
}

export interface ShowOptions {
  /** 数据目录：记忆库、每场的记录 */
  dataDir: string;
  /** 观众叫她时用的名字 */
  names: string[];
  /** 没话题时多久开始自己找话说 */
  idleAfterMs?: number;
}

/** 她说过的一句话（控制台显示、下播提炼用） */
export interface SpokenLine {
  text: string;
  mood: string;
  at: number;
}

export interface ShowStatus {
  live: LiveStatus;
  onAir: boolean;
  brain: BrainState;
  /** 正在直播的那个会话 */
  brainSession: string | null;
  heat: string;
  audience: boolean;
  pending: Record<string, number>;
  lines: SpokenLine[];
  stageWatchers: number;
  /** 当前连着的房间号（没连为 null） */
  roomId: number | null;
}

const TICK_MS = 200;
/** 推了一件事以后，她这一轮最多等多久（模型卡住时不让直播停住） */
const TURN_MAX_MS = 3 * 60_000;
/** 推道别以后最多等多久就收工 */
const ENDING_GRACE_MS = 90_000;
const RECENT_LINES = 40;
/** 控制台「模拟观众」的用户 id 前缀 */
export const SIMULATED_PREFIX = 'sim-';

export class LiveShow {
  readonly hub = new LiveHub();
  readonly stage = new Stage();
  private attention: LiveAttention;
  private memory: LiveMemory;
  private onAir = false;
  private ending = false;
  private endingTimer: NodeJS.Timeout | null = null;
  private brain: BrainState = 'off';
  private brainSession: string | null = null;
  /** 她这一轮还在进行（推了一件事、或者主人在会话里直接跟她说话） */
  private turnRunning = false;
  private turnSince = 0;
  private pushing = false;
  /** 道别已经推给她了：这一轮结束、话念完就收工 */
  private endingPushed = false;
  private director: NodeJS.Timeout | null = null;
  private seq = 0;
  /** 排在弹幕前面的事：主人的话、开场、谢幕 */
  private priority: TopicBody[] = [];
  private speaking = 0;
  private lines: SpokenLine[] = [];
  private herLines: string[] = [];
  private logFile: string | null = null;
  private roomTimer: NodeJS.Timeout | null = null;
  private lastRoom = '';
  private roomId: number | null = null;
  private unsubscribe: (() => void) | null = null;
  /** 记住这个直播间的观众：只有主人说这是自己的直播间才记（连别人的直播间旁观时不建档） */
  rememberViewers = false;
  /** 这一场记不记（开播时按 rememberViewers 定下来） */
  private memoryStream = false;

  constructor(private readonly hooks: ShowHooks, private readonly options: ShowOptions) {
    mkdirSync(options.dataDir, { recursive: true });
    this.memory = new LiveMemory(new LiveMemoryStore(join(options.dataDir, 'live-memory.db')));
    this.attention = this.freshAttention();
    setHerNames(options.names);
  }

  private freshAttention(): LiveAttention {
    const a = new LiveAttention(Date.now());
    if (this.options.idleAfterMs) a.idleAfterMs = this.options.idleAfterMs;
    return a;
  }

  setNames(names: string[]): void {
    this.options.names = names;
    setHerNames(names);
  }

  // ── 直播间连接 ─────────────────────────────────────

  connect(roomId: number, cookie: string, rememberViewers = false): LiveStatus {
    this.rememberViewers = rememberViewers;
    this.unsubscribe?.();
    const status = this.hub.connect({ platform: 'bilibili', roomId, cookie });
    this.roomId = roomId;
    this.unsubscribe = this.hub.subscribe((event, isUpdate) => this.observe(event, isUpdate));
    if (!this.roomTimer) this.roomTimer = setInterval(() => this.syncRoom(), 1000);
    return status;
  }

  disconnect(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.hub.disconnect();
    this.roomId = null;
    if (this.roomTimer) clearInterval(this.roomTimer);
    this.roomTimer = null;
  }

  /** 测试用：不连直播间也能往里塞事件（控制台的「模拟观众」） */
  inject(event: LiveEvent): void {
    this.hub.ingest(event);
    if (!this.unsubscribe) this.unsubscribe = this.hub.subscribe((e, isUpdate) => this.observe(e, isUpdate));
  }

  private observe(event: LiveEvent, isUpdate: boolean): void {
    const now = Date.now();
    this.attention.observe(event, isUpdate, now);
    // 只记自己直播间的观众（主人在控制台勾了的）；模拟观众（控制台彩排）不记
    if (this.onAir && this.memoryStream && !event.user.id.startsWith(SIMULATED_PREFIX)) this.memory.observe(event, isUpdate, now);
    const shown = toStage(event);
    if (shown) this.stage.broadcast({ type: 'live', event: shown, isUpdate });
    if (this.onAir && !isUpdate && (event.kind === 'superchat' || event.kind === 'membership' || (event.kind === 'gift' && event.valueYuan > 0))) {
      this.record({ type: 'event', kind: event.kind, user: cleanName(event.user.name), yuan: event.valueYuan, text: event.kind === 'superchat' ? cleanText(event.text) : undefined });
    }
  }

  /** 在线人数、主播身份、开没开播：跟着直播间走 */
  private syncRoom(): void {
    const status = this.hub.status();
    this.attention.setOnline(status.stats.online);
    this.attention.setAnchorId(status.room?.anchorId);
    // 直播间没开播（主人在测试）：没人在看也照常演
    this.attention.setRehearsal(status.stats.live !== true);
    const room = JSON.stringify([status.stats.online, status.room?.title, this.onAir]);
    if (room !== this.lastRoom) {
      this.lastRoom = room;
      this.stage.broadcast({ type: 'room', online: status.stats.online, title: status.room?.title, onAir: this.onAir });
    }
  }

  // ── 开播、下播 ─────────────────────────────────────

  /** 开播：sessionId 是她直播用的会话（控制台刚开好的），身体先推开场 */
  goLive(sessionId: string): void {
    this.brainSession = sessionId;
    if (this.onAir) return;
    this.onAir = true;
    this.ending = false;
    this.endingPushed = false;
    this.turnRunning = false;
    this.attention = this.freshAttention();
    // 别人的直播间（旁观、试播）不留任何记忆：不建档，也不写这场的回顾
    this.memoryStream = this.rememberViewers;
    if (this.memoryStream) this.memory.begin(Date.now());
    this.priority = [{ kind: 'opening' }];
    this.lines = [];
    this.herLines = [];
    this.openLog();
    this.setBrain('listening');
    this.syncRoom();
    if (!this.director) this.director = setInterval(() => void this.direct(), TICK_MS);
  }

  /** 下播：先让她道别，说完（或等太久）就收工 */
  endLive(): void {
    if (!this.onAir || this.ending) return;
    this.ending = true;
    this.priority.unshift({ kind: 'ending', summary: '' });
    this.endingTimer = setTimeout(() => this.finish(), ENDING_GRACE_MS);
  }

  private finish(): void {
    if (this.endingTimer) clearTimeout(this.endingTimer);
    this.endingTimer = null;
    if (!this.onAir) return;
    this.onAir = false;
    this.ending = false;
    this.endingPushed = false;
    this.priority = [];
    if (this.director) clearInterval(this.director);
    this.director = null;
    this.setBrain('off');
    this.syncRoom();
    const streamId = this.memoryStream ? this.memory.end(Date.now()) : null;
    this.memoryStream = false;
    this.record({ type: 'end' });
    this.logFile = null;
    if (streamId !== null && this.hooks.distill) {
      const herLines = this.herLines.slice();
      void distillStream(this.memory.store, streamId, { herLines }, this.hooks.distill, Date.now())
        .then((r) => this.hooks.log?.('info', `直播记忆提炼完：${r.viewers} 位观众，回顾 ${r.recap.length} 条`))
        .catch((err) => this.hooks.log?.('warn', `直播记忆提炼失败：${(err as Error).message}`));
    }
  }

  ownerSay(text: string): void {
    const said = text.trim();
    if (!said) return;
    this.priority.push({ kind: 'owner', text: said });
  }

  // ── 导演：她空下来就推下一件事 ─────────────────────

  private async direct(): Promise<void> {
    if (!this.onAir || !this.brainSession || this.pushing || this.speaking > 0) return;
    const now = Date.now();
    if (this.turnRunning) {
      if (now - this.turnSince < TURN_MAX_MS) return;
      this.hooks.log?.('warn', `她这一轮超过 ${TURN_MAX_MS / 1000} 秒还没结束，接着往下推`);
      this.turnRunning = false;
    }
    // 道别说完了：收工
    if (this.endingPushed) return this.finish();
    const topic = this.take(now);
    if (!topic) return;
    this.seq += 1;
    const focus = focusOf(topic);
    if (focus.length) this.stage.broadcast({ type: 'focus', userIds: focus });
    this.record({ type: 'topic', seq: this.seq, kind: topic.kind });
    const d = new Date(now);
    const text = topicText(topic, {
      viewerCard: (u: LiveUser) => this.memory.viewerCard(u, now),
      lastRecap: topic.kind === 'opening' && this.memoryStream ? this.memory.lastRecap() : undefined,
      today: topic.kind === 'opening' ? `${d.getMonth() + 1}月${d.getDate()}日` : undefined,
    });
    this.pushing = true;
    this.setBrain('thinking', topicLabel(topic));
    try {
      const ok = await this.hooks.push(this.brainSession, text);
      if (!ok) {
        // 她的会话不在线（DSH 重启过、会话被关了）：要紧的事放回去，等控制台重新开播
        if (topic.kind === 'opening' || topic.kind === 'ending' || topic.kind === 'owner') this.priority.unshift(topic);
        this.setBrain('away', '她的会话不在线');
        return;
      }
      this.turnRunning = true;
      this.turnSince = Date.now();
      if (topic.kind === 'ending') this.endingPushed = true;
    } finally {
      this.pushing = false;
    }
  }

  /** 她的会话开始了一轮（身体推的，或者主人在会话里直接说话） */
  turnStarted(sessionId: string): void {
    if (sessionId !== this.brainSession) return;
    this.turnRunning = true;
    this.turnSince = Date.now();
  }

  /** 她这一轮结束了：话念完以后导演再推下一件 */
  turnEnded(sessionId: string): void {
    if (sessionId !== this.brainSession) return;
    this.turnRunning = false;
    if (this.onAir && this.speaking === 0) this.setBrain('listening');
  }

  private take(now: number): Topic | null {
    const body = this.priority.shift();
    if (body) return { ...body, id: `p-${now}`, priority: 200, heat: this.attention.heat(now), createdAt: now };
    return this.attention.next(now);
  }

  /** 念她写的话：合成语音、交给舞台、等念完 */
  async say(raw: string, mood: string, signal: AbortSignal): Promise<string> {
    const text = speakable(raw);
    if (!text) return '';
    return this.stage.withMic(async () => {
      this.speaking += 1;
      this.attention.speechStarted();
      this.setBrain('speaking');
      const start = Date.now();
      try {
        let speech: { audio: Uint8Array; timeline: Array<{ chars: number; atMs: number }> } | null = null;
        try {
          speech = await this.hooks.synthesize(text, signal);
        } catch (err) {
          this.hooks.log?.('warn', `语音合成失败：${(err as Error).message}`);
        }
        const id = randomUUID();
        const estimateMs = estimateSpeechMs(text);
        const done = this.stage.waitSaid(id, estimateMs, signal);
        this.stage.broadcast({
          type: 'say', id, text, mood, estimateMs,
          audio: speech ? Buffer.from(speech.audio).toString('base64') : null,
          ...(speech?.timeline.length ? { timeline: speech.timeline } : {}),
        });
        await done;
      } finally {
        this.speaking -= 1;
        this.attention.speechEnded(Date.now());
        this.lines = [...this.lines, { text, mood, at: start }].slice(-RECENT_LINES);
        this.herLines.push(text);
        this.record({ type: 'say', text, mood, start, end: Date.now() });
        this.setBrain(!this.onAir ? 'off' : this.turnRunning ? 'thinking' : 'listening');
      }
      return text;
    });
  }

  get currentSession(): string | null {
    return this.brainSession;
  }

  // ── 她的工具用到的 ──────────────────────────────────

  /** 按她看到的名字（或 UID）在这场直播最近的事件里找观众；找不到、对不上好几位时带着候选（见 core/viewerLookup） */
  lookupViewer(who: string): ViewerLookup {
    return lookupViewer(who, this.hub.recentEvents(), { simulatedPrefix: SIMULATED_PREFIX });
  }

  /** 她私信了一位观众：记进这场的记录（复盘、剪视频用） */
  noteDm(to: string, text: string): void {
    this.record({ type: 'dm', to, text });
  }

  /** 这位观众认不认识：这场里出现过，或者观众记忆里有他（私信只发给认识的人） */
  knowsViewer(uid: string): boolean {
    return this.hub.recentEvents().some((e) => e.user.id === uid) || !!this.memory.store.getViewer('bilibili', uid);
  }

  /** 这位观众说过「忘了我」：不看、不记 */
  optedOut(uid: string): boolean {
    return this.memory.store.isOptedOut('bilibili', uid);
  }

  /** 她看了这位观众的主页：自己的直播间里记一句，下次见到他卡片里会提 */
  rememberProfile(uid: string, summary: string): void {
    if (this.memoryStream && this.memory.store.getViewer('bilibili', uid)) this.memory.store.setAppraisal('bilibili', uid, { summary, at: Date.now() });
  }

  /** 她在用工具做事：舞台上显示她在干什么 */
  doing(detail: string): void {
    if (this.onAir) this.setBrain('thinking', detail);
  }

  get isOnAir(): boolean {
    return this.onAir;
  }

  private setBrain(state: BrainState, detail?: string): void {
    if (this.brain === state && !detail) return;
    this.brain = state;
    this.stage.broadcast({ type: 'brain', state, detail });
  }

  status(): ShowStatus {
    const now = Date.now();
    const snap = this.attention.snapshot(now);
    return {
      live: this.hub.status(now),
      onAir: this.onAir,
      brain: this.brain,
      brainSession: this.brainSession,
      heat: snap.heat,
      audience: snap.audience,
      pending: snap.pending,
      lines: this.lines,
      stageWatchers: this.stage.watchers,
      roomId: this.roomId,
    };
  }

  // ── 记录（剪视频、复盘用） ─────────────────────────

  private openLog(): void {
    const dir = join(this.options.dataDir, 'shows');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFile = join(dir, `${stamp}.jsonl`);
    this.record({ type: 'begin', roomId: this.roomId });
  }

  private record(entry: Record<string, unknown>): void {
    if (!this.logFile) return;
    try {
      appendFileSync(this.logFile, JSON.stringify({ t: Date.now(), ...entry }) + '\n');
    } catch {
      // 记录写不进去不影响直播
    }
  }

  dispose(): void {
    this.finish();
    if (this.director) clearInterval(this.director);
    this.director = null;
    this.disconnect();
  }
}

/** 没有音频时按字数估朗读时长 */
export function estimateSpeechMs(text: string): number {
  return Math.max(1500, [...text].length * 230);
}


const KIND_LABEL: Record<Topic['kind'], string> = {
  chat: '在看弹幕', superchat: '在看醒目留言', thanks: '在谢礼物', gifts: '在谢礼物', trend: '在看大家刷屏',
  welcome: '在欢迎新观众', follow: '在谢关注', idle: '在找话说', opening: '在准备开场', ending: '在准备道别', owner: '在听主人说话',
};

function topicLabel(topic: Topic): string {
  return KIND_LABEL[topic.kind];
}

/** 她这次要回应的观众（舞台上高亮） */
function focusOf(topic: Topic): string[] {
  const ids = (users: LiveUser[]) => users.map((u) => u.id || u.name);
  switch (topic.kind) {
    case 'chat': return ids(topic.picks.map((p) => p.event.user));
    case 'superchat': return ids([topic.event.user]);
    case 'thanks': case 'gifts': return ids(topic.events.map((e) => e.user));
    case 'welcome': case 'follow': return ids(topic.users);
    default: return [];
  }
}

function stageUser(user: LiveUser): StageUser {
  return {
    id: user.id || user.name,
    name: cleanName(user.name),
    ...(user.face ? { face: user.face } : {}),
    ...(user.guardLevel ? { guard: user.guardLevel } : {}),
    ...(user.medal?.ofThisRoom ? { medal: { name: cleanName(user.medal.name), level: user.medal.level } } : {}),
    ...(user.isAdmin ? { admin: true } : {}),
  };
}

/** 直播事件 → 舞台显示用（清洗过的名字和文字；点赞不上舞台） */
function toStage(event: LiveEvent): StageLiveEvent | null {
  const user = stageUser(event.user);
  switch (event.kind) {
    case 'chat': return { kind: 'chat', id: event.id, user, text: cleanText(event.text), ...(event.stickerUrl ? { sticker: event.stickerUrl } : {}) };
    case 'gift': return { kind: 'gift', id: event.id, user, gift: cleanName(event.giftName), count: event.count, yuan: event.valueYuan };
    case 'superchat': return { kind: 'superchat', id: event.id, user, text: cleanText(event.text), yuan: event.valueYuan };
    case 'membership': return { kind: 'membership', id: event.id, user, level: cleanName(event.levelName), count: event.count };
    case 'enter': case 'follow': return { kind: event.kind, id: event.id, user };
    default: return null;
  }
}

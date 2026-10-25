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
import { basename, join } from 'node:path';
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
import type { BrainState, GameSource, StageLiveEvent, StageUser } from '../stage/protocol';
import { Player, type PlayRequest } from './player';
import type { VideoNotes } from './watchAlong';
import { Stage } from './stage';

/** 一个视频不放了：怎么结束的、放了多少秒、这期间她说了什么 */
export interface VideoEnd {
  how: string;
  playedSec: number;
  said: string[];
}

export interface ShowHooks {
  /**
   * 把一件事作为一条消息推进她的会话（唤醒她）；会话不在线返回 false。
   * now：插进她这一轮的下一步（她在玩游戏、一轮没完时）；不然排到下一轮
   */
  push(sessionId: string, text: string, now?: boolean): Promise<boolean>;
  /** 合成一句话的语音（mp3）和逐字时间；没配密钥或失败返回 null（只有字幕，按字数走） */
  synthesize(text: string, signal: AbortSignal): Promise<{ audio: Uint8Array; timeline: Array<{ chars: number; atMs: number }> } | null>;
  /** 下播后提炼观众记忆用的模型 */
  distill?: DistillLlm;
  log?(level: 'info' | 'warn', message: string): void;
  /** 存下正在播的这一场（插件重启后接着播用）；null：这场结束了 */
  persist?(snapshot: LiveSnapshot | null): void;
  /** 游戏画面上舞台、撤下（OBS 抓游戏窗口、叠 HUD） */
  onGame?(source: GameSource | null): void;
}

/** 正在播的一场：插件重启后接着播要的东西 */
export interface LiveSnapshot {
  sessionId: string;
  roomId: number | null;
  /** 观众记忆里这一场的 id（不记的房间为 null） */
  streamId: number | null;
  logFile: string | null;
  /** 最后一次存的时间（算断了多久） */
  at: number;
  /** 这场什么时候开播的 */
  startedAt?: number;
  /** 到停下时她念了多少字 */
  spokenChars?: number;
  /** 停下时她在直播里玩着游戏（插件重启时游戏那局也跟着断了） */
  playing?: boolean;
}

export interface ShowOptions {
  /** 数据目录：记忆库、每场的记录 */
  dataDir: string;
  /** 观众叫她时用的名字 */
  names: string[];
  /** 没话题时多久开始自己找话说 */
  idleAfterMs?: number;
  /** 告示板上写的（开场时告诉她，观众看得到什么） */
  board?: () => string;
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
/** 合成一段语音最多等多久（超时再试一次，还不行就只出字幕） */
const SYNTH_TIMEOUT_MS = 15_000;
/** 在播时多久存一次这一场（插件重启后按它算断了多久） */
const PERSIST_EVERY_MS = 20_000;
/** 边看边聊：放视频时她安静了这么久（离上次「视频这会儿」也这么久），就告诉她视频这段在说什么 */
const WATCH_GAP_MS = 20_000;
/** 一次最多告诉她多长一段 */
const WATCH_WINDOW_SEC = 45;
/** 视频里不到这么多秒的一段不值得说 */
const WATCH_MIN_SEC = 8;
/** 她在玩游戏时，两次把直播间的事推给她至少隔多久（热闹时弹幕攒成一批，别让游戏走不动） */
const GAME_PUSH_GAP_MS = 12_000;
/** 她在玩游戏、这一轮停下了、话也说完了，等这么久直播间还没事，就叫她接着玩 */
const GAME_WAKE_MS = 6_000;
/** 她在玩游戏时，嘴里还排着这么多句没念完，就先不推新的弹幕 */
const GAME_MOUTH_BACKLOG = 2;
/** 控制台「模拟观众」的用户 id 前缀 */
export const SIMULATED_PREFIX = 'sim-';

export class LiveShow {
  readonly hub = new LiveHub();
  readonly stage = new Stage();
  /** 舞台上放视频（她用 play_video）：放完了告诉她 */
  readonly player = new Player(this.stage, (video, how, playedSec) => {
    this.record({ type: 'video', bvid: video.bvid, title: video.title, how, playedSec: Math.round(playedSec) });
    this.endWatch(how, playedSec);
    if (this.onAir && !this.ending && !video.answered) this.priority.push({ kind: 'video', title: video.title, how, playedSec });
  });
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
  /** 边看边聊：正在放的视频里有什么、上次告诉她看到了哪一秒、什么时候告诉的 */
  private watch: { id: string; notes: VideoNotes; seenSec: number; toldAt: number } | null = null;
  /** 正在放的视频放完 / 停下 / 被换掉时告诉谁（视频库记她放的时候说了什么）；saidFrom：开始放时她说到第几句 */
  private playing: { id: string; saidFrom: number; done: (end: VideoEnd) => void } | null = null;
  /** 开播账号新收到的私信、回复（没别的事要回时告诉她） */
  private inbox: string[] = [];
  /** 她在直播里玩的游戏（dsh-game 给的画面来源）；null：没在玩 */
  private game: GameSource | null = null;
  private gamePushedAt = 0;
  private turnEndedAt = 0;
  /** game_continue 在等：直播间有事推给她时叫醒它（liveBody.attention） */
  private attentionWaiters = new Set<() => void>();
  private director: NodeJS.Timeout | null = null;
  private seq = 0;
  /** 排在弹幕前面的事：主人的话、开场、谢幕 */
  private priority: TopicBody[] = [];
  private speaking = 0;
  /** 她写好、还没念完的话（包括排着队等嘴的）：导演看这个决定要不要推下一件 */
  private queued = 0;
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
    // 先订阅再塞：反过来的话，没连直播间时塞的第一条事件谁也收不到（彩排里第一位进场的观众没被欢迎）
    if (!this.unsubscribe) this.unsubscribe = this.hub.subscribe((e, isUpdate) => this.observe(e, isUpdate));
    this.hub.ingest(event);
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
    this.liveSince = Date.now();
    this.spoken = 0;
    // 别人的直播间（旁观、试播）不留任何记忆：不建档，也不写这场的回顾
    this.memoryStream = this.rememberViewers;
    if (this.memoryStream) this.memory.begin(Date.now());
    this.priority = [{ kind: 'opening' }];
    this.inbox = [];
    this.lines = [];
    this.herLines = [];
    this.openLog();
    this.setBrain('listening');
    this.syncRoom();
    if (!this.director) this.director = setInterval(() => void this.direct(), TICK_MS);
    this.persistLive();
  }

  /** 插件重启后接着播（同一个会话、同一场记忆和记录）：先告诉她断了多久 */
  resumeLive(snapshot: LiveSnapshot, now = Date.now()): void {
    if (this.onAir) return;
    this.brainSession = snapshot.sessionId;
    this.onAir = true;
    this.ending = false;
    this.endingPushed = false;
    this.turnRunning = false;
    this.attention = this.freshAttention();
    this.memoryStream = snapshot.streamId !== null;
    if (snapshot.streamId !== null) this.memory.resume(snapshot.streamId);
    this.liveSince = snapshot.startedAt ?? snapshot.at;
    this.spoken = snapshot.spokenChars ?? 0;
    this.priority = [{ kind: 'resumed', gapSec: Math.max(1, Math.round((now - snapshot.at) / 1000)), ...(snapshot.playing ? { playing: true } : {}) }];
    this.inbox = [];
    this.logFile = snapshot.logFile;
    this.record({ type: 'resume', gapMs: now - snapshot.at });
    this.setBrain('listening');
    this.syncRoom();
    if (!this.director) this.director = setInterval(() => void this.direct(), TICK_MS);
    this.persistLive();
  }

  /** 一场没收尾就停了、又太久没接上（不是正常的重启）：把它记成结束，观众记忆照常提炼 */
  closeStale(snapshot: LiveSnapshot): void {
    if (snapshot.streamId === null || !this.hooks.distill) return;
    this.memory.resume(snapshot.streamId);
    const streamId = this.memory.end(snapshot.at);
    if (streamId === null) return;
    void distillStream(this.memory.store, streamId, { herLines: [], name: this.options.names[0] ?? '' }, this.hooks.distill, Date.now())
      .then((r) => this.hooks.log?.('info', `上一场直播的记忆提炼完：${r.viewers} 位观众`))
      .catch((err) => this.hooks.log?.('warn', `上一场直播的记忆提炼失败：${(err as Error).message}`));
  }

  private persistedAt = 0;
  private persistLive(now = Date.now()): void {
    if (!this.onAir || !this.brainSession) return;
    this.persistedAt = now;
    this.hooks.persist?.({ sessionId: this.brainSession, roomId: this.roomId, streamId: this.memoryStream ? this.memory.currentStream : null, logFile: this.logFile, at: now, startedAt: this.liveSince, spokenChars: this.spoken, ...(this.game ? { playing: true } : {}) });
  }

  private liveSince = 0;
  private spoken = 0;

  /** 这场播了多久、她念了多少字 */
  stats(now = Date.now()): { liveMs: number; spokenChars: number } {
    return { liveMs: this.onAir ? now - this.liveSince : 0, spokenChars: this.spoken };
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
    this.stopVideo('off');
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
    this.hooks.persist?.(null);
    this.record({ type: 'end' });
    this.logFile = null;
    if (streamId !== null && this.hooks.distill) {
      const herLines = this.herLines.slice();
      void distillStream(this.memory.store, streamId, { herLines, name: this.options.names[0] ?? '' }, this.hooks.distill, Date.now())
        .then((r) => this.hooks.log?.('info', `直播记忆提炼完：${r.viewers} 位观众，回顾 ${r.recap.length} 条`))
        .catch((err) => this.hooks.log?.('warn', `直播记忆提炼失败：${(err as Error).message}`));
    }
  }

  /** 主人（或 who：主人那边别的人，比如帮忙管直播的经理）在控制台跟她说话 */
  ownerSay(text: string, who?: string): void {
    const said = text.trim();
    if (!said) return;
    this.priority.push({ kind: 'owner', text: said, ...(who?.trim() ? { who: who.trim() } : {}) });
  }

  // ── 导演：她空下来就推下一件事 ─────────────────────

  private async direct(): Promise<void> {
    if (this.onAir && Date.now() - this.persistedAt > PERSIST_EVERY_MS) this.persistLive();
    if (!this.onAir || !this.brainSession || this.pushing) return;
    const now = Date.now();
    // 她在玩游戏、这一轮还没完（在 game_continue 里等、在做事）：直播间的事照样推给她，插进她这一轮的下一步
    if (this.turnRunning && this.game) return this.directGame(now);
    if (this.queued > 0) return;
    if (this.turnRunning) {
      if (now - this.turnSince < TURN_MAX_MS) return;
      this.hooks.log?.('warn', `她这一轮超过 ${TURN_MAX_MS / 1000} 秒还没结束，接着往下推`);
      this.turnRunning = false;
    }
    // 道别说完了：收工
    if (this.endingPushed) return this.finish();
    const topic = this.game ? this.takeInGame(now) : this.take(now);
    if (!topic) return;
    await this.deliver(topic, now);
  }

  /** 她在玩游戏、一轮没完：有弹幕、礼物、主人说话就推给她（隔开一点），推了就叫醒在等的 game_continue */
  private async directGame(now: number): Promise<void> {
    if (now - this.gamePushedAt < GAME_PUSH_GAP_MS) return;
    // 嘴跟不上：她写好的话还排着好几句没念，先不推新的，弹幕攒着等她说完一起给（不然观众听到的回应越来越晚）
    if (this.queued >= GAME_MOUTH_BACKLOG) return;
    const topic = this.takeLive(now);
    if (!topic) return;
    if (!(await this.deliver(topic, now, true))) return;
    this.gamePushedAt = Date.now();
    for (const wake of [...this.attentionWaiters]) wake();
  }

  /** 直播间里真的有事：主人的话、开场、谢幕，和注意力层挑的弹幕、礼物（不含「没人说话，自己找话说」） */
  private takeLive(now: number): Topic | null {
    const body = this.priority.shift();
    if (body) return { ...body, id: `p-${now}`, priority: 200, heat: this.attention.heat(now), createdAt: now };
    const topic = this.attention.next(now);
    return topic && topic.kind !== 'idle' ? topic : null;
  }

  /** 在玩游戏、这一轮停下了：直播间有事先回；没事、又安静了一会儿，叫她接着玩（不另找话题、不推视频和收件箱） */
  private takeInGame(now: number): Topic | null {
    const topic = this.takeLive(now);
    if (topic) return topic;
    if (now - this.turnEndedAt < GAME_WAKE_MS || this.attention.silentMs(now) < GAME_WAKE_MS) return null;
    return { kind: 'game', id: `g-${now}`, priority: 1, heat: this.attention.heat(now), createdAt: now };
  }

  /** 把一件事推进她的会话；推成了返回 true */
  private async deliver(topic: Topic, now: number, midTurn = false): Promise<boolean> {
    this.seq += 1;
    const focus = focusOf(topic);
    if (focus.length) this.stage.broadcast({ type: 'focus', userIds: focus });
    this.record({ type: 'topic', seq: this.seq, kind: topic.kind });
    const d = new Date(now);
    const text = topicText(topic, {
      viewerCard: (u: LiveUser) => this.memory.viewerCard(u, now),
      lastRecap: topic.kind === 'opening' && this.memoryStream ? this.memory.lastRecap() : undefined,
      today: topic.kind === 'opening' ? `${d.getMonth() + 1}月${d.getDate()}日` : undefined,
      board: topic.kind === 'opening' ? this.options.board?.() : undefined,
      inGame: !!this.game,
    });
    this.pushing = true;
    this.setBrain('thinking', topicLabel(topic));
    try {
      const ok = await this.hooks.push(this.brainSession!, text, midTurn);
      if (!ok) {
        // 她的会话不在线（DSH 重启过、会话被关了）：要紧的事放回去，等控制台重新开播
        if (topic.kind === 'opening' || topic.kind === 'ending' || topic.kind === 'owner') this.priority.unshift(topic);
        this.setBrain('away', '她的会话不在线');
        return false;
      }
      this.turnRunning = true;
      this.turnSince = Date.now();
      if (topic.kind === 'ending') this.endingPushed = true;
      return true;
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
    this.turnEndedAt = Date.now();
    if (this.onAir && this.speaking === 0) this.setBrain('listening');
  }

  private take(now: number): Topic | null {
    const body = this.priority.shift();
    if (body) return { ...body, id: `p-${now}`, priority: 200, heat: this.attention.heat(now), createdAt: now };
    const topic = this.attention.next(now);
    // 弹幕、礼物这些照常先回；没别的事时，先说收件箱，再说在放的视频（不用她找话说）
    if (topic && topic.kind !== 'idle') return topic;
    if (this.inbox.length) {
      const lines = this.inbox.splice(0, 5);
      return { kind: 'inbox', lines, id: `i-${now}`, priority: 2, heat: this.attention.heat(now), createdAt: now };
    }
    if (this.player.current) return this.watching(now);
    return topic;
  }

  /** 边看边聊：她安静一会儿了，视频又往下放了一段，这段有人说话或者原视频有弹幕，就告诉她 */
  private watching(now: number): Topic | null {
    const video = this.player.current;
    const watch = this.watch;
    const at = this.player.position(now);
    if (!video || !watch || watch.id !== video.id || at === null) return null;
    if (this.attention.silentMs(now) < WATCH_GAP_MS || now - watch.toldAt < WATCH_GAP_MS) return null;
    const from = Math.max(watch.seenSec, at - WATCH_WINDOW_SEC);
    if (at - from < WATCH_MIN_SEC) return null;
    const moment = watch.notes.between(from, at);
    watch.seenSec = at;
    watch.toldAt = now;
    if (!moment.lines.length && !moment.danmaku.length) return null;
    return {
      kind: 'watching', title: video.title, fromSec: from, toSec: at,
      lines: moment.lines.map((l) => ({ from: l.from, text: l.text })),
      source: moment.kind, ...(moment.engine ? { engine: moment.engine } : {}),
      danmaku: moment.danmaku.map((d) => d.text),
      id: `w-${now}`, priority: 1, heat: this.attention.heat(now), createdAt: now,
    };
  }

  /** 正在放的视频不放了（how：ended 放完、error 放不出来、stopped 她让停的、replaced 换别的了、off 下播） */
  private endWatch(how: string, playedSec?: number): void {
    this.watch?.notes.stop();
    this.watch = null;
    const playing = this.playing;
    this.playing = null;
    if (!playing) return;
    const video = this.player.current;
    const played = playedSec ?? (video && video.id === playing.id ? (this.player.position() ?? video.fromSec) - video.fromSec : 0);
    try {
      playing.done({ how, playedSec: Math.round(played), said: this.herLines.slice(playing.saidFrom) });
    } catch (err) {
      this.hooks.log?.('warn', `视频放完的记录出错：${(err as Error).message}`);
    }
  }

  /** 念她写的话：合成语音、交给舞台、等念完 */
  async say(raw: string, mood: string, signal: AbortSignal): Promise<string> {
    const text = speakable(raw);
    if (!text) return '';
    this.queued += 1;
    return this.stage.withMic(async () => {
      this.speaking += 1;
      this.attention.speechStarted();
      this.setBrain('speaking');
      const start = Date.now();
      try {
        let speech: { audio: Uint8Array; timeline: Array<{ chars: number; atMs: number }> } | null = null;
        // 合成一段平时不到 2 秒：一次最多等 SYNTH_TIMEOUT_MS，卡住了马上再试一次（实测豆包偶尔一个请求一直不回，等满两分钟直播就冷场了）
        for (let attempt = 1; attempt <= 2 && !speech && !signal.aborted; attempt++) {
          try {
            speech = await this.hooks.synthesize(text, AbortSignal.any([signal, AbortSignal.timeout(SYNTH_TIMEOUT_MS)]));
          } catch (err) {
            this.hooks.log?.('warn', `语音合成失败（第 ${attempt} 次）：${(err as Error).message}`);
          }
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
        this.queued -= 1;
        this.attention.speechEnded(Date.now());
        this.lines = [...this.lines, { text, mood, at: start }].slice(-RECENT_LINES);
        this.herLines.push(text);
        this.spoken += [...text].length;
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

  /** 她用开播账号发了评论：记进这场的记录 */
  noteComment(text: string, where: string): void {
    this.record({ type: 'comment', where, text });
  }

  /** 直播间最近的弹幕（旧 → 新）：视频库记「点视频之前在聊什么」 */
  recentChat(limit = 10, withinMs = 5 * 60_000, now = Date.now()): Array<{ name: string; uid: string; text: string; at: number }> {
    return this.hub.recentEvents()
      .filter((e): e is Extract<typeof e, { kind: 'chat' }> => e.kind === 'chat' && now - e.ts <= withinMs)
      .slice(-limit)
      .map((e) => ({ name: e.user.name, uid: e.user.id, text: e.text, at: e.ts }));
  }

  /** 这一场真的推流到直播间了：记忆里算一场（彩排不算「上一场」） */
  markBroadcast(): void {
    if (this.memoryStream) this.memory.markBroadcast();
  }

  /** 这场直播的记录文件名（没在播为 null） */
  get logName(): string | null {
    return this.logFile ? basename(this.logFile) : null;
  }

  /** 她用开播账号发了动态：记进这场的记录 */
  noteDynamic(text: string): void {
    this.record({ type: 'dynamic', text });
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

  /** 停下正在放的视频（她让停的、下播），不再听写后面的 */
  stopVideo(how = 'stopped') {
    this.endWatch(how);
    return this.player.stop();
  }

  /**
   * 在舞台上放一个视频（换掉正在放的）；记进这场的记录。notes：这段视频里有什么（边看边聊用）；
   * done：不放了的时候（放完、停下、换掉、下播）告诉调用的人放了多久、这期间她说了什么
   */
  playVideo(request: PlayRequest, notes?: VideoNotes, done?: (end: VideoEnd) => void) {
    const replaced = this.player.current;
    this.endWatch('replaced');
    const video = this.player.play(request);
    if (notes) this.watch = { id: video.id, notes, seenSec: request.fromSec, toldAt: Date.now() };
    if (done) this.playing = { id: video.id, saidFrom: this.herLines.length, done };
    this.record({ type: 'play', bvid: request.bvid, title: request.title, from: request.fromSec, until: request.untilSec });
    return { video, replaced };
  }

  /**
   * 她调用了一个工具：舞台终端里记一行（观众看得出画面上的视频、私信是她自己动手做的），
   * doing 写在提示符上（她正在干什么）
   */
  toolCall(name: string, detail: string, doing?: string): void {
    if (!this.onAir) return;
    this.brain = 'thinking';
    this.stage.broadcast({ type: 'tool', name, detail, doing });
  }

  /** 开播账号收到了新东西：没别的事要回时告诉她 */
  notifyInbox(lines: string[]): void {
    if (this.onAir && !this.ending) this.inbox.push(...lines);
  }

  /** 终端里记一行身体自己在做的事（后台听写视频之类）：不是她调的工具，不改她的状态 */
  note(tag: string, text: string): void {
    if (this.onAir) this.stage.broadcast({ type: 'note', tag, text });
  }

  /**
   * 她在直播里玩的游戏的画面上舞台、撤下（dsh-game 经 liveBody.showGame 给；null：这局结束了）。
   * 在玩的时候导演换一套做法：直播间的事照推，不另找话题（见 docs/game-live-contract.md）
   */
  showGame(source: GameSource | null): void {
    if (JSON.stringify(source) === JSON.stringify(this.game)) return;
    this.game = source;
    this.gamePushedAt = 0;
    this.stage.broadcast({ type: 'game', source });
    this.record({ type: 'game', source });
    this.persistLive();
    this.hooks.onGame?.(source);
  }

  get gameSource(): GameSource | null {
    return this.game;
  }

  /** 直播间有事推给她时 resolve（liveBody.attention：game_continue 和游戏自己的等待一起 race）；signal 取消就不管了 */
  waitAttention(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return;
      const wake = () => {
        this.attentionWaiters.delete(wake);
        signal.removeEventListener('abort', drop);
        resolve();
      };
      const drop = () => this.attentionWaiters.delete(wake);
      this.attentionWaiters.add(wake);
      signal.addEventListener('abort', drop, { once: true });
    });
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

  /** 插件停了（多半是 DSH 重启、更新）：在播的这一场不收尾，存好，起来以后接着播 */
  dispose(): void {
    if (this.onAir && !this.ending) {
      this.persistLive();
      this.record({ type: 'suspend' });
      this.player.stop();
    } else {
      this.finish();
    }
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
  video: '视频放完了', watching: '在看视频', inbox: '在看私信和评论', resumed: '在接着播', game: '在玩游戏',
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

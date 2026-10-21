/**
 * 舞台上放视频：同一时间只放一个。身体告诉舞台放什么、从哪到哪（media 事件），舞台放完回执；
 * 舞台页没开着（或回执丢了）就按时长兜底，放完照样告诉她。
 *
 * 视频地址是 B 站 CDN 的：舞台页不直接连，走舞台服务器转一道（/video?id=…，带上 B 站要的 Referer）。
 */

import { randomUUID } from 'node:crypto';
import type { Stage } from './stage';

export interface PlayRequest {
  bvid: string;
  title: string;
  up: string;
  /** B 站 CDN 上的 MP4 */
  url: string;
  fromSec: number;
  untilSec: number;
}

export interface Playing extends PlayRequest {
  id: string;
  startedAt: number;
}

export type PlayEnd = 'ended' | 'error';

/** 舞台开始放了以后多等这么久还没回执「放完」才算它放完 */
const GRACE_MS = 8_000;
/** 舞台一直没回执开始放（加载不出来）最多等多久 */
const LOAD_MS = 25_000;

export class Player {
  private playing: Playing | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly stage: Stage, private readonly onEnd: (video: Playing, how: PlayEnd, playedSec: number) => void) {}

  get current(): Playing | null {
    return this.playing;
  }

  /** 换成这个视频（正在放的直接换掉，不算放完） */
  play(request: PlayRequest): Playing {
    this.clear();
    const video: Playing = { ...request, id: randomUUID(), startedAt: Date.now() };
    this.playing = video;
    this.stage.broadcast({ type: 'media', action: 'play', id: video.id, title: video.title, up: video.up, src: `/video?id=${video.id}`, from: video.fromSec, until: video.untilSec });
    // 舞台页开着：等它回执开始放；没开着（彩排时）按时长放完
    if (this.stage.watchers) this.arm(LOAD_MS, 'error');
    else this.arm((video.untilSec - video.fromSec) * 1000, 'ended');
    return video;
  }

  /** 她让停的：停下、舞台换回聊天布局，不再告诉她放完 */
  stop(): { video: Playing; playedSec: number } | null {
    const video = this.playing;
    if (!video) return null;
    this.clear();
    return { video, playedSec: this.played(video) };
  }

  /** 舞台的回执：开始放了（按实际位置重新算兜底）、放完了、放不出来 */
  report(id: string, state: 'playing' | PlayEnd, positionSec?: number): void {
    const video = this.playing;
    if (!video || video.id !== id) return;
    if (state === 'playing') {
      const at = Number.isFinite(positionSec) ? positionSec! : video.fromSec;
      this.arm(Math.max(0, video.untilSec - at) * 1000 + GRACE_MS, 'ended');
      return;
    }
    this.finish(state);
  }

  /** 舞台服务器转发视频时问：这个 id 现在对应哪个地址 */
  source(id: string): string | null {
    return this.playing?.id === id ? this.playing.url : null;
  }

  private finish(how: PlayEnd): void {
    const video = this.playing;
    if (!video) return;
    const playedSec = how === 'ended' ? video.untilSec - video.fromSec : this.played(video);
    this.clear();
    this.onEnd(video, how, playedSec);
  }

  private played(video: Playing): number {
    return Math.min(video.untilSec - video.fromSec, Math.max(0, (Date.now() - video.startedAt) / 1000));
  }

  private arm(ms: number, how: PlayEnd): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish(how), ms);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.playing) this.stage.broadcast({ type: 'media', action: 'stop', id: this.playing.id });
    this.playing = null;
  }
}

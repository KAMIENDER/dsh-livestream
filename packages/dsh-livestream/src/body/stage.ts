/**
 * 舞台广播：身体往舞台页推事件（SSE 订阅者），舞台念完一句回执 said。
 * 只有一张嘴：说话一句一句排队（withMic），前一句念完下一句才开始。
 */

import type { StageEvent } from '../stage/protocol';

type Listener = (event: StageEvent) => void;

/** 不带 v/at 的事件，broadcast 时补上 */
type StageEventInput = StageEvent extends infer E ? E extends StageEvent ? Omit<E, 'v' | 'at'> : never : never;

export class Stage {
  private listeners = new Set<Listener>();
  /** 出声的舞台页（OBS 的浏览器源）；预览页静音、不回执 */
  private speakers = new Set<Listener>();
  private pending = new Map<string, () => void>();
  /** 状态类事件的最新一条：舞台页中途连上（OBS 刷新）时先补给它，不用等下一次变化 */
  private latest = new Map<string, StageEvent>();

  /** 有几个出声的舞台页开着 */
  get watchers(): number {
    return this.speakers.size;
  }

  /** speaker：这个页面出声、念完回执（OBS 的浏览器源）；控制台里的预览传 false */
  subscribe(listener: Listener, speaker = true): () => void {
    this.listeners.add(listener);
    if (speaker) this.speakers.add(listener);
    for (const event of this.latest.values()) listener(event);
    return () => {
      this.listeners.delete(listener);
      this.speakers.delete(listener);
    };
  }

  broadcast(event: StageEventInput): void {
    const full = { v: 1, at: Date.now(), ...event } as StageEvent;
    if (full.type === 'room' || full.type === 'brain' || full.type === 'usage' || full.type === 'media' || full.type === 'board' || full.type === 'orders' || full.type === 'game' || full.type === 'gameStatus' || full.type === 'notice') this.latest.set(full.type, full);
    for (const listen of this.listeners) {
      try {
        listen(full);
      } catch {
        // 一个舞台页断了不影响别的
      }
    }
  }

  /**
   * 等舞台把这句念完（回执 said）。没有出声的舞台页开着时按估计时长等，节奏照样自然。
   * timeoutMs 是兜底：舞台卡住也不会一直等。
   */
  waitSaid(id: string, estimateMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        this.pending.delete(id);
        resolve();
      };
      const timer = setTimeout(finish, this.watchers ? estimateMs + 15_000 : estimateMs);
      signal.addEventListener('abort', finish, { once: true });
      this.pending.set(id, finish);
    });
  }

  said(id: string): void {
    this.pending.get(id)?.();
  }

  /** 一句一句说：谁先要谁先说 */
  /** priority 大的先念（同样大的按先后）：游戏线说的是游戏里此刻的事，排在直播线回观众的话前面 */
  withMic<T>(play: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.micQueue.push({ priority, run: () => Promise.resolve().then(play).then(resolve, reject) });
      this.nextOnMic();
    });
  }

  private micQueue: Array<{ priority: number; run: () => Promise<void> }> = [];
  private micBusy = false;

  private nextOnMic(): void {
    if (this.micBusy || !this.micQueue.length) return;
    let k = 0;
    for (let i = 1; i < this.micQueue.length; i++) if (this.micQueue[i].priority > this.micQueue[k].priority) k = i;
    const [turn] = this.micQueue.splice(k, 1);
    this.micBusy = true;
    void turn.run().finally(() => {
      this.micBusy = false;
      this.nextOnMic();
    });
  }
}

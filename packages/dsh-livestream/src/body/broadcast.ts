/**
 * 推流到 B 站：开播拿推流码 → OBS 推流 → 下播。和「彩排」分开：只有主人开了「推流到 B 站」才走这里。
 *
 *   start()   账号没有直播间就开通 → 开播（直播姬签名）→ 要人脸认证就停在 face，等主人用 B 站 App 扫码 →
 *             认证过了自动再开播 → 拿到推流码交给 OBS（专用配置、舞台页当浏览器源）→ 确认推上了
 *   stop()    OBS 停推 → B 站下播
 *
 * 状态给控制台看：哪一步、二维码、OBS 的码率和丢帧。
 */

import { BiliRoom, type Stream } from './biliRoom';
import { connectObs, prepareObs, startStreaming, stopStreaming, streamHealth, type Obs, type StreamHealth } from './obs';

export type BroadcastPhase = 'idle' | 'preparing' | 'face' | 'streaming' | 'stopping' | 'error';

export interface BroadcastStatus {
  phase: BroadcastPhase;
  /** 这一步在干什么（控制台显示） */
  step: string;
  roomId: number | null;
  /** 人脸认证的二维码链接（phase = face） */
  faceQr: string | null;
  error: string | null;
  health: StreamHealth | null;
  startedAt: number | null;
  /** 这次用的推流协议 */
  protocol?: 'rtmp' | 'srt';
}

export interface BroadcastOptions {
  cookie(): Promise<string>;
  stageUrl(): string;
  /** 开播用的分区（子分区 id）；不给就用 B 站给这个账号准备的默认分区 */
  areaId(): number | null;
  title(): string | null;
  /** 推流协议：srt（有就用，跨境更稳）还是 rtmp */
  protocol(): 'srt' | 'rtmp';
  /** 推流码率（kbps） */
  kbps(): number;
  /** 开通了直播间：记下房间号（身体连弹幕、标成自己的直播间） */
  onRoom(roomId: number): void;
  log?(level: 'info' | 'warn', message: string): void;
}

const FACE_TIMEOUT_MS = 5 * 60_000;

export class Broadcast {
  private state: BroadcastStatus = { phase: 'idle', step: '', roomId: null, faceQr: null, error: null, health: null, startedAt: null };
  private obs: Obs | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private cancelled = false;

  constructor(private readonly options: BroadcastOptions) {}

  status(): BroadcastStatus {
    return { ...this.state };
  }

  get streaming(): boolean {
    return this.state.phase === 'streaming';
  }

  private set(patch: Partial<BroadcastStatus>): void {
    this.state = { ...this.state, ...patch };
    if (patch.step) this.options.log?.('info', `推流：${patch.step}`);
  }

  /** 开播并推流；在后台跑，进度看 status()。已经在跑就什么也不做 */
  start(): void {
    if (this.state.phase === 'preparing' || this.state.phase === 'face' || this.state.phase === 'streaming') return;
    this.cancelled = false;
    this.set({ phase: 'preparing', step: '检查 B 站登录', faceQr: null, error: null, health: null });
    void this.run().catch((err) => {
      this.set({ phase: 'error', step: '', faceQr: null, error: (err as Error).message });
      this.options.log?.('warn', `推流失败：${(err as Error).message}`);
    });
  }

  private async run(): Promise<void> {
    const cookie = await this.options.cookie();
    if (!cookie) throw new Error('还没有 B 站 Cookie：在设置里填上开播账号的 Cookie');
    const room = new BiliRoom(cookie);
    const me = await room.whoami();
    if (!me.loggedIn) throw new Error('B 站 Cookie 失效了：重新登录 B 站，复制新的 Cookie 填到设置里');

    this.set({ step: '准备直播间' });
    const roomId = await room.ensureRoom();
    this.set({ roomId });
    this.options.onRoom(roomId);

    const pre = await room.preLive();
    const areaId = this.options.areaId() ?? pre.areaId;
    if (!areaId) throw new Error('还没选直播分区');
    const title = this.options.title();
    if (title) await room.update(roomId, { title });

    this.set({ step: '向 B 站申请开播' });
    let stream: Stream | null = null;
    const deadline = Date.now() + FACE_TIMEOUT_MS;
    while (!stream) {
      if (this.cancelled) return;
      const result = await room.start(roomId, areaId);
      if (result.kind === 'live') stream = this.options.protocol() === 'srt' && result.srt ? result.srt : result.stream;
      else if (result.kind === 'verify') throw new Error(`B 站要求先过一次风控验证（${result.message}）：用官方直播姬或 B 站 App 开播一次，之后这里就能开了`);
      else {
        // 人脸认证：等主人用 B 站 App 扫码，认证过了再开播一次
        this.set({ phase: 'face', step: '等你用 B 站 App 扫码做人脸认证', faceQr: result.qr });
        while (!(await room.faceVerified(roomId))) {
          if (this.cancelled) return;
          if (Date.now() > deadline) throw new Error('人脸认证等了 5 分钟还没完成，重新点开播再试');
          await new Promise((r) => setTimeout(r, 2000));
        }
        this.set({ phase: 'preparing', step: '认证通过，再申请开播', faceQr: null });
      }
    }

    this.set({ step: '打开 OBS、设好画质' });
    this.obs = await connectObs(true);
    await prepareObs(this.obs, this.options.stageUrl(), this.options.kbps());
    this.set({ step: `开始推流（${stream.protocol.toUpperCase()}，${this.options.kbps()} kbps）`, protocol: stream.protocol });
    await startStreaming(this.obs, stream.addr, stream.code);
    this.set({ phase: 'streaming', step: '推流中', startedAt: Date.now() });
    this.healthTimer = setInterval(() => void this.poll(), 2000);
  }

  private async poll(): Promise<void> {
    if (!this.obs) return;
    try {
      const health = await streamHealth(this.obs);
      this.set({ health });
      if (!health.active && this.state.phase === 'streaming') this.set({ phase: 'error', error: 'OBS 停止推流了（看 OBS 的日志）' });
    } catch (err) {
      this.set({ error: `读不到 OBS 状态：${(err as Error).message}` });
    }
  }

  /** 停推、下播 */
  async stop(): Promise<void> {
    this.cancelled = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    const roomId = this.state.roomId;
    this.set({ phase: 'stopping', step: '停止推流、下播', faceQr: null });
    const errors: string[] = [];
    try {
      const obs = this.obs ?? await connectObs(false);
      await stopStreaming(obs);
      obs.close();
    } catch (err) {
      errors.push(`OBS：${(err as Error).message}`);
    }
    this.obs = null;
    if (roomId) {
      try {
        const cookie = await this.options.cookie();
        await new BiliRoom(cookie).stop(roomId);
      } catch (err) {
        errors.push(`B 站：${(err as Error).message}`);
      }
    }
    this.set({ phase: errors.length ? 'error' : 'idle', step: '', error: errors.length ? `下播时出错：${errors.join('；')}` : null, health: null, startedAt: null });
  }
}

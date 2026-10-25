/**
 * 插件的共享状态：宿主根插件（index.ts）和 agent 子插件（agent.ts）用同一份（同一个进程，同一个模块实例）。
 *
 *   - show：这一场直播的身体
 *   - server：舞台服务器（OBS 打开的那个地址）
 *   - settings：房间号、角色、模板……存在 DSH_HOME/dsh-livestream/settings.json（控制台里改）
 *   - 机密（B 站 Cookie、豆包密钥）不在这里：走 DSH 的凭据服务，按名字取
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveShow, type LiveSnapshot } from '../body/show';
import { Whisper } from '../body/asr';
import { BiliAccount } from '../body/biliAccount';
import { BiliVideos } from '../body/biliVideo';
import { BiliSocial } from '../body/biliSocial';
import { VideoLibrary } from '../body/videoLibrary';
import { SocialManager } from '../body/social';
import { Broadcast } from '../body/broadcast';
import { DmManager } from '../body/dm';
import { Packs } from '../body/packs';
import { StageServer } from '../body/server';
import { canSpeak, subtitleTimeline, synthesize, type TtsAuth } from '../body/tts';
import { DEFAULT_VOICE } from '../body/voices';
import type { DistillLlm } from '../core/memory/distill';
import type { CharacterManifest, GameSource } from '../stage/protocol';
import { gameRect } from '../stage/layout';
import { connectObs, showGameSources } from '../body/obs';

export interface Settings {
  roomId: number | null;
  character: string;
  template: string;
  /** 空串用角色包的默认音色 */
  voice: string;
  stagePort: number;
  stageToken: string;
  /** 下播提炼观众记忆用的模型（provider/model） */
  distillModel: string;
  /** 没话题多少秒后自己找话说 */
  idleAfterSec: number;
  /** 主人说是自己的直播间（记住常来的观众）；别的房间只旁观、不建档 */
  ownRooms: number[];
  /** 开播时真的推流到 B 站（默认关：只在本地彩排） */
  broadcast: boolean;
  /** 开播用的分区（子分区 id）；null 用 B 站给账号准备的默认分区 */
  areaId: number | null;
  /** 开播前改成这个标题；空串不改 */
  liveTitle: string;
  /** 推流协议：srt（B 站给了就用，跨境、丢包的网络上比 rtmp 稳）或 rtmp */
  pushProtocol: 'srt' | 'rtmp';
  /** 推流码率（kbps） */
  streamKbps: number;
  /** 直播间封面图片的路径（本机文件）；空串不换 */
  liveCover: string;
  /** 装了 faster-whisper 的 Python（视频没字幕时听写用）；空串不听写 */
  asrPython: string;
  /** whisper 模型：large-v3-turbo（有显卡）、small（只有 CPU）…… */
  asrModel: string;
  /** 告示板：主人想让观众知道的。空行分页，每页第一行是标题；空串不显示告示板 */
  boardText: string;
}

/** 告示板默认写的：观众怎么跟她玩 */
export const DEFAULT_BOARD = [
  '想看什么，跟大肥鱼说',
  '说个大概：「想看猫猫」',
  '她自己去 B 站搜、挑来放',
  '找错了告诉她，她再找',
  '',
  '还可以这样玩',
  '让她「看看我的主页」',
  '常来的观众她会记住',
  '她靠字幕听，也会看一眼画面',
].join('\n');

/** 机密的名字（DSH 凭据）。豆包的和 dsh-game 共用 */
export const SECRETS = {
  cookie: 'BILIBILI_COOKIE',
  ttsApiKey: 'DOUBAO_TTS_API_KEY',
  ttsAppId: 'DOUBAO_TTS_APP_ID',
  ttsAccessKey: 'DOUBAO_TTS_ACCESS_KEY',
} as const;

export const PRESET_ID = 'dsh-livestream';

export const dataDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-livestream');

/** 插件包目录（构建产物在 lib/ 或 lib/chunks/，往上找 package.json） */
export function packageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const file = join(dir, 'package.json');
    if (existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')) as { name?: string }).name === 'dsh-livestream') return dir;
    dir = dirname(dir);
  }
  throw new Error('dsh-livestream: 找不到插件包目录');
}

const SETTINGS_FILE = join(dataDir, 'settings.json');

function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<Settings>;
  } catch {
    // 第一次用
  }
  const settings: Settings = {
    roomId: null,
    character: 'dafeiyu',
    template: 'default',
    voice: '',
    stagePort: 7390,
    stageToken: '',
    distillModel: 'deepseek-official/deepseek-flash',
    idleAfterSec: 45,
    ownRooms: [],
    broadcast: false,
    areaId: null,
    liveTitle: '',
    pushProtocol: 'srt',
    streamKbps: 4500,
    liveCover: '',
    asrPython: '',
    asrModel: 'large-v3-turbo',
    boardText: DEFAULT_BOARD,
    ...saved,
  };
  if (!settings.stageToken) {
    settings.stageToken = randomBytes(12).toString('base64url');
    saveSettings(settings);
  }
  return settings;
}

function saveSettings(next: Settings): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

export const settings: Settings = loadSettings();

export function updateSettings(patch: Partial<Settings>): Settings {
  Object.assign(settings, patch);
  saveSettings(settings);
  return settings;
}

/** agent 子插件接上 DSH 的服务后填这里：读机密、调模型 */
export const hooks: {
  secret: (name: string) => Promise<string>;
  /** 存一个机密（扫码登录拿到的 Cookie）；没有凭据服务时抛错 */
  setSecret: (name: string, value: string) => Promise<void>;
  push: (sessionId: string, text: string) => Promise<boolean>;
  complete: ((model: string, system: string, user: string) => Promise<string>) | null;
  log: (level: 'info' | 'warn', message: string) => void;
} = {
  secret: async (name) => process.env[name] ?? '',
  setSecret: async () => { throw new Error('这个 DSH 没有凭据服务，存不了'); },
  push: async () => false,
  complete: null,
  log: (level, message) => (level === 'warn' ? console.warn : console.log)(`[dsh-livestream] ${message}`),
};

async function ttsAuth(voice: string): Promise<TtsAuth | null> {
  const [apiKey, appId, accessKey] = await Promise.all([hooks.secret(SECRETS.ttsApiKey), hooks.secret(SECRETS.ttsAppId), hooks.secret(SECRETS.ttsAccessKey)]);
  const auth = { apiKey, appId, accessKey };
  return canSpeak(auth, voice) ? auth : null;
}

export const packs = new Packs(packageDir(), dataDir);

export function currentCharacter(): CharacterManifest | null {
  return packs.character(settings.character);
}

export function currentVoice(): string {
  return settings.voice || currentCharacter()?.voice || DEFAULT_VOICE;
}

/** 她能用的表情：角色包里有的 */
export function currentMoods(): string[] {
  const c = currentCharacter();
  const moods = c?.clips?.moods ?? c?.image?.moods ?? {};
  return ['talk', ...Object.keys(moods)];
}

const distill: DistillLlm = async (system, user) => {
  if (!hooks.complete) throw new Error('DSH 的模型服务还没接上');
  return hooks.complete(settings.distillModel, system, user);
};

export const show = new LiveShow(
  {
    push: (sessionId, text) => hooks.push(sessionId, text),
    synthesize: (text, signal) => {
      const ready = prepared.get(`${currentVoice()}|${text}`);
      if (ready) {
        prepared.delete(`${currentVoice()}|${text}`);
        return ready.catch(() => speech(text, signal));
      }
      return speech(text, signal);
    },
    distill,
    log: (level, message) => hooks.log(level, message),
    persist: (snapshot) => saveLive(snapshot),
    onGame: (source) => placeGame(source),
  },
  { dataDir, names: currentCharacter()?.names ?? [], idleAfterMs: settings.idleAfterSec * 1000, board: () => settings.boardText },
);

/**
 * 游戏画面上 OBS：窗口画面（Minecraft 摄像机客户端）由 OBS 抓，摆在舞台的游戏位上、垫在舞台下面；
 * 网页画面舞台自己放，OBS 里不用加东西。连不上 OBS（没开、只在本机预览）就算了
 */
export function placeGame(source: GameSource | null): void {
  const template = packs.template(settings.template);
  const windowSource = source && 'window' in source ? source : null;
  void (async () => {
    let obs: Awaited<ReturnType<typeof connectObs>> | null = null;
    try {
      obs = await connectObs(false);
      await showGameSources(obs, windowSource, template ? gameRect(template) : { x: 0, y: 0, w: 1920, h: 1080 });
      hooks.log('info', windowSource ? `游戏画面上舞台：${windowSource.window}` : '游戏画面撤下');
    } catch (err) {
      hooks.log('warn', `游戏画面没能放进 OBS：${(err as Error).message}`);
    } finally {
      obs?.close();
    }
  })();
}

/** 告示板换了：舞台马上换（之后连上的舞台页也拿到最新的） */
export function publishBoard(): void {
  show.stage.broadcast({ type: 'board', text: settings.boardText });
}
publishBoard();

async function speech(text: string, signal: AbortSignal): Promise<{ audio: Uint8Array; timeline: Array<{ chars: number; atMs: number }> } | null> {
  const voice = currentVoice();
  const auth = await ttsAuth(voice);
  if (!auth) return null;
  const { audio, words } = await synthesize(auth, voice, text, signal);
  return { audio, timeline: subtitleTimeline(text, words) };
}

/** 提前合成好的句子（念稿时先合成、念的时候直接用，句和句之间不空等）：音色|文字 → 语音 */
const prepared = new Map<string, Promise<Awaited<ReturnType<typeof speech>>>>();

/** 提前合成一句（text 是 speakable 处理过的那段）；最多留 40 句，用掉就删 */
export function prepareSpeech(text: string): void {
  const key = `${currentVoice()}|${text}`;
  if (!text || prepared.has(key)) return;
  prepared.set(key, speech(text, AbortSignal.timeout(60_000)));
  while (prepared.size > 40) prepared.delete(prepared.keys().next().value!);
}

export const server = new StageServer({
  port: settings.stagePort,
  token: settings.stageToken,
  packageDir: packageDir(),
  packs,
  stage: show.stage,
  current: () => ({ character: settings.character, template: settings.template }),
  media: {
    source: (id) => show.player.source(id),
    report: (id, state, positionSec, detail) => show.player.report(id, state, positionSec, detail),
  },
  log: (level, message) => hooks.log(level, message),
});

export async function cookie(): Promise<string> {
  return hooks.secret(SECRETS.cookie);
}

/** 推流到 B 站：开播拿推流码、OBS 推流、下播 */
export const broadcast = new Broadcast({
  cookie,
  stageUrl: () => server.url,
  areaId: () => settings.areaId,
  title: () => settings.liveTitle.trim() || null,
  protocol: () => settings.pushProtocol,
  kbps: () => settings.streamKbps,
  cover: () => {
    const file = settings.liveCover.trim();
    if (!file || !existsSync(file)) return null;
    const ext = extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { data: new Uint8Array(readFileSync(file)), mime };
  },
  // 开播账号的直播间：记下来、标成自己的直播间（记住观众），连上它的弹幕
  onRoom: (roomId) => {
    updateSettings({ roomId, ownRooms: [...new Set([...settings.ownRooms, roomId])] });
    const status = show.status();
    if (status.roomId !== roomId || status.live.state === 'idle' || status.live.state === 'error') {
      void cookie().then((c) => show.connect(roomId, c, true));
    } else {
      show.rememberViewers = true;
    }
  },
  onStreaming: () => show.markBroadcast(),
  log: (level, message) => hooks.log(level, message),
});

/** 她给观众发私信（开播账号）：B 站「对方没关注只能发一条」等规矩在这里管 */
export const dm = new DmManager(new BiliAccount(cookie), join(dataDir, 'dm.json'));

// ── 断点续播：在播的这一场存在磁盘上，插件（DSH）重启后接着播 ──

const LIVE_FILE = join(dataDir, 'live.json');

function saveLive(snapshot: LiveSnapshot | null): void {
  try {
    if (!snapshot) rmSync(LIVE_FILE, { force: true });
    else writeFileSync(LIVE_FILE, JSON.stringify({ ...snapshot, broadcasting: broadcast.streaming }));
  } catch (err) {
    hooks.log('warn', `存不了直播状态：${(err as Error).message}`);
  }
}

/** 上次停下时还在播的那一场（没有返回 null）；读了就删，接上以后会重新存 */
/** agent 子插件（她的会话）起来、装好推消息的钩子了没有 */
let agentAttached = false;
export const agentReady = (): boolean => agentAttached;
export function markAgentReady(): void {
  agentAttached = true;
}

export function takeLive(): (LiveSnapshot & { broadcasting: boolean }) | null {
  try {
    const saved = JSON.parse(readFileSync(LIVE_FILE, 'utf8')) as LiveSnapshot & { broadcasting: boolean };
    rmSync(LIVE_FILE, { force: true });
    return saved?.sessionId ? saved : null;
  } catch {
    return null;
  }
}

/** 她点赞、看评论、发评论、看收件箱（开播账号） */
export const social = new SocialManager(new BiliSocial(cookie));

/** 直播时每隔一会儿看一眼收件箱：开播以后新来的私信、回复、@，没别的事时告诉她 */
const INBOX_EVERY_MS = 90_000;
setInterval(() => {
  if (!show.isOnAir) return;
  void social.newSince().then((lines) => { if (lines.length) show.notifyInbox(lines); }).catch(() => {});
}, INBOX_EVERY_MS).unref?.();

/** 她搜视频、看视频、在舞台上放视频（开播账号的 Cookie：AI 字幕要登录才给） */
export const videos = new BiliVideos(cookie);

/** 视频没字幕时听写（本机的 faster-whisper） */
export const asr = new Whisper({
  python: () => settings.asrPython,
  model: () => settings.asrModel.trim() || 'large-v3-turbo',
  script: join(packageDir(), 'assets', 'asr', 'whisper_worker.py'),
  dataDir,
  log: (level, message) => hooks.log(level, message),
});

/** 视频库：她看过、放过的视频（详情、字幕、原视频弹幕、每次看的记录），存在 <dataDir>/videos */
export const library = new VideoLibrary(join(dataDir, 'videos'), (message) => hooks.log('warn', message));

/**
 * 插件的共享状态：宿主根插件（index.ts）和 agent 子插件（agent.ts）用同一份（同一个进程，同一个模块实例）。
 *
 *   - show：这一场直播的身体
 *   - server：舞台服务器（OBS 打开的那个地址）
 *   - settings：房间号、角色、模板……存在 DSH_HOME/dsh-livestream/settings.json（控制台里改）
 *   - 机密（B 站 Cookie、豆包密钥）不在这里：走 DSH 的凭据服务，按名字取
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveShow } from '../body/show';
import { BiliAccount } from '../body/biliAccount';
import { BiliVideos } from '../body/biliVideo';
import { Broadcast } from '../body/broadcast';
import { DmManager } from '../body/dm';
import { Packs } from '../body/packs';
import { StageServer } from '../body/server';
import { canSpeak, subtitleTimeline, synthesize, type TtsAuth } from '../body/tts';
import { DEFAULT_VOICE } from '../body/voices';
import type { DistillLlm } from '../core/memory/distill';
import type { CharacterManifest } from '../stage/protocol';

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
}

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
  push: (sessionId: string, text: string) => Promise<boolean>;
  complete: ((model: string, system: string, user: string) => Promise<string>) | null;
  log: (level: 'info' | 'warn', message: string) => void;
} = {
  secret: async (name) => process.env[name] ?? '',
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
    synthesize: async (text, signal) => {
      const voice = currentVoice();
      const auth = await ttsAuth(voice);
      if (!auth) return null;
      const { audio, words } = await synthesize(auth, voice, text, signal);
      return { audio, timeline: subtitleTimeline(text, words) };
    },
    distill,
    log: (level, message) => hooks.log(level, message),
  },
  { dataDir, names: currentCharacter()?.names ?? [], idleAfterMs: settings.idleAfterSec * 1000 },
);

export const server = new StageServer({
  port: settings.stagePort,
  token: settings.stageToken,
  packageDir: packageDir(),
  packs,
  stage: show.stage,
  current: () => ({ character: settings.character, template: settings.template }),
  media: {
    source: (id) => show.player.source(id),
    report: (id, state, positionSec) => show.player.report(id, state, positionSec),
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
  log: (level, message) => hooks.log(level, message),
});

/** 她给观众发私信（开播账号）：B 站「对方没关注只能发一条」等规矩在这里管 */
export const dm = new DmManager(new BiliAccount(cookie), join(dataDir, 'dm.json'));

/** 她搜视频、看视频、在舞台上放视频（开播账号的 Cookie：AI 字幕要登录才给） */
export const videos = new BiliVideos(cookie);

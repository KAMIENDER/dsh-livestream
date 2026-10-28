/** OBS 的本机差异集中在这里：配置目录、安装位置、启动方式和编码器。 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_STREAM_KBPS = 4500;

export function obsConfigDir(): string {
  const override = process.env.DSH_LIVESTREAM_OBS_CONFIG?.trim();
  if (override) return override;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'obs-studio');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'obs-studio');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'obs-studio');
}

/** DSH_LIVESTREAM_OBS 可以是可执行文件；macOS 也接受 OBS.app 目录。 */
export function findObsExe(): string | null {
  const candidates: string[] = [];
  const override = process.env.DSH_LIVESTREAM_OBS?.trim().replace(/\/$/, '');
  if (override) {
    candidates.push(process.platform === 'darwin' && override.endsWith('.app') ? join(override, 'Contents', 'MacOS', 'OBS') : override);
  }
  if (process.platform === 'darwin') {
    candidates.push('/Applications/OBS.app/Contents/MacOS/OBS', join(homedir(), 'Applications', 'OBS.app', 'Contents', 'MacOS', 'OBS'));
  } else if (process.platform === 'win32') {
    for (const key of ['HKLM\\SOFTWARE\\OBS Studio', 'HKLM\\SOFTWARE\\WOW6432Node\\OBS Studio', 'HKCU\\SOFTWARE\\OBS Studio']) {
      try {
        const out = execFileSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const dir = /REG_SZ\s+(.+)/.exec(out)?.[1]?.trim();
        if (dir) candidates.push(join(dir, 'bin', '64bit', 'obs64.exe'));
      } catch {
        // 没有这个键，继续找常见安装位置。
      }
    }
    candidates.push(
      'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
      'D:\\Software\\obs-studio\\bin\\64bit\\obs64.exe',
      'D:\\obs-studio\\bin\\64bit\\obs64.exe',
    );
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function launchObs(exe: string): Promise<void> {
  const app = process.platform === 'darwin' && exe.endsWith('/Contents/MacOS/OBS') ? dirname(dirname(dirname(exe))) : null;
  const flags = ['--disable-shutdown-check', '--disable-updater'];
  // 通过 LaunchServices 打开 .app，保留 OBS 的应用身份和系统授权，并复用已启动的实例。
  const command = app ? '/usr/bin/open' : exe;
  const args = app ? ['-a', app, '--args', ...flags] : flags;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: dirname(exe), detached: !app, stdio: 'ignore' });
    child.once('error', (err) => reject(new Error(`无法启动 OBS：${err.message}`)));
    if (app) {
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`打开 OBS.app 失败（退出码 ${code}），请手动打开 OBS`)));
    } else {
      child.once('spawn', () => { child.unref(); resolve(); });
    }
  });
}

export interface StreamEncoder {
  id: string;
  settings: Record<string, string | number | boolean>;
}

/** 每种编码器只接收自己的参数，不能把 NVENC 的 preset2 / multipass 写给 VideoToolbox。 */
export function streamEncoder(kbps: number): StreamEncoder {
  // OBS 的 VideoToolbox CBR 只支持 Apple Silicon + macOS 13（Darwin 22）以上。
  // Intel / Rosetta 的 Node 默认用 x264；不凭机器型号猜 OBS 当前加载了哪种硬件编码器。
  const appleCbr = process.platform === 'darwin' && process.arch === 'arm64' && Number.parseInt(release(), 10) >= 22;
  const fallback = process.platform === 'win32' ? 'nvenc' : appleCbr ? 'videotoolbox' : 'x264';
  const choice = process.env.DSH_LIVESTREAM_ENCODER?.trim().toLowerCase() || 'auto';
  const selected = choice === 'auto' ? fallback : choice;
  const common = { rate_control: 'CBR', bitrate: kbps, keyint_sec: 2, profile: 'high' };
  if (selected === 'videotoolbox') {
    if (!appleCbr) throw new Error('VideoToolbox CBR 需要 macOS 13+ 和原生 arm64 Node；请使用 DSH_LIVESTREAM_ENCODER=x264');
    return { id: 'com.apple.videotoolbox.videoencoder.ave.avc', settings: { ...common, bframes: true } };
  }
  if (selected === 'x264') return { id: 'obs_x264', settings: { ...common, preset: 'veryfast' } };
  if (selected === 'nvenc') {
    if (process.platform === 'darwin') throw new Error('macOS 不支持 NVENC；请使用 DSH_LIVESTREAM_ENCODER=auto 或 x264');
    return {
      id: 'obs_nvenc_h264_tex',
      settings: { ...common, preset2: 'p6', tune: 'hq', multipass: 'qres', bf: 2, lookahead: false, adaptive_quantization: true, psycho_aq: true },
    };
  }
  throw new Error('DSH_LIVESTREAM_ENCODER 只支持 auto、videotoolbox、x264、nvenc');
}

/**
 * OBS（WebSocket v5，OBS 28+ 自带）：专用的配置文件和场景集合「dsh-livestream」，舞台页当浏览器源，推流到 B 站。
 *
 * 画面清不清楚全看编码设置（以前 OBS 简单模式 x264 veryfast 1.4Mbps 糊过）：
 *   - 画布和输出都是 1920×1080，不缩放；舞台页本来就是 1080p
 *   - 按平台选 H.264 编码器（见 obsPlatform.ts），CBR，默认 4500 kbps，关键帧 2 秒
 *   - RTMP 开「动态码率」：网络堵的时候降码率，不丢帧（实测日本推到 B 站的 RTMP 只有 3 Mbps 左右，丢了三分之二的帧）
 *   - Windows 保留 NVENC P6 / HQ / 两遍编码；macOS 使用 VideoToolbox 或 x264 的独立参数
 *   - 30 帧：舞台大部分是静的，同样码率 30 帧比 60 帧清楚
 *   - 声音只要舞台页自己的（浏览器源交给 OBS 控制音频），不要麦克风和桌面音频
 * 只动自己这套配置和场景集合，不碰用户别的 OBS 配置。WebSocket 密码从 OBS 自己的配置里读，不打印。
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_STREAM_KBPS, findObsExe, launchObs, obsConfigDir, streamEncoder } from './obsPlatform';

export { findObsExe } from './obsPlatform';

export const OBS_NAME = 'dsh-livestream';
const SCENE = '直播';
const STAGE_SOURCE = '舞台';

type Call = <T = any>(requestType: string, requestData?: Record<string, unknown>) => Promise<T>;

export interface Obs {
  call: Call;
  close(): void;
}

function websocketConfig(): { port: number; password: string; enabled: boolean } {
  const file = join(obsConfigDir(), 'plugin_config', 'obs-websocket', 'config.json');
  if (!existsSync(file)) return { port: 4455, password: '', enabled: false };
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as { server_port?: number; server_password?: string; server_enabled?: boolean; auth_required?: boolean };
  return { port: cfg.server_port ?? 4455, password: cfg.auth_required === false ? '' : cfg.server_password ?? '', enabled: cfg.server_enabled !== false };
}

function connectOnce(): Promise<Obs> {
  const { port, password } = websocketConfig();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map<string, { res: (v: any) => void; rej: (e: Error) => void; requestType: string }>();
    const timer = setTimeout(() => { ws.close(); reject(new Error('连 OBS 超时')); }, 5000);
    ws.onerror = () => { clearTimeout(timer); reject(new Error('连不上 OBS')); };
    ws.onmessage = (msg) => {
      const { op, d } = JSON.parse(String(msg.data));
      if (op === 0) {
        const identify: Record<string, unknown> = { rpcVersion: 1 };
        if (d.authentication) {
          const secret = createHash('sha256').update(password + d.authentication.salt).digest('base64');
          identify.authentication = createHash('sha256').update(secret + d.authentication.challenge).digest('base64');
        }
        ws.send(JSON.stringify({ op: 1, d: identify }));
      } else if (op === 2) {
        clearTimeout(timer);
        resolve({
          call: (requestType, requestData = {}) => {
            const requestId = randomUUID();
            ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
            return new Promise((res, rej) => pending.set(requestId, { res, rej, requestType }));
          },
          close: () => ws.close(),
        });
      } else if (op === 7) {
        const p = pending.get(d.requestId);
        if (!p) return;
        pending.delete(d.requestId);
        if (d.requestStatus.result) p.res(d.responseData ?? {});
        else p.rej(new Error(`OBS ${p.requestType} 失败：${d.requestStatus.code} ${d.requestStatus.comment ?? ''}`));
      }
    };
  });
}

/** 连上 OBS；没开就帮忙打开（WebSocket 服务器要在 OBS 里启用过） */
export async function connectObs(launch = true): Promise<Obs> {
  try {
    return await connectOnce();
  } catch (err) {
    if (!launch) throw err;
    if (!websocketConfig().enabled) throw new Error('OBS 的 WebSocket 服务器没启用：OBS → 工具 → WebSocket 服务器设置 → 启用');
    const exe = findObsExe();
    if (!exe) throw new Error('没找到 OBS：先安装 OBS；自定义位置可设置 DSH_LIVESTREAM_OBS（可执行文件的完整路径，macOS 也可填 OBS.app）');
    await launchObs(exe);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        return await connectOnce();
      } catch {
        // OBS 还在启动
      }
    }
    throw new Error('打开了 OBS，但 30 秒内连不上它的 WebSocket');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 配置文件的目录：OBS 按名字生成目录名（会去掉「-」之类的字符，dsh-livestream → dshlivestream），
 * 所以按 basic.ini 里的 Name= 找，不猜目录名
 */
function profileDir(name: string): string | null {
  const root = join(obsConfigDir(), 'basic', 'profiles');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const ini = join(root, dir, 'basic.ini');
    if (existsSync(ini) && /^Name=(.*)$/m.exec(readFileSync(ini, 'utf8').replace(/^\uFEFF/, ''))?.[1]?.trim() === name) return join(root, dir);
  }
  return null;
}

/** 切到自己的配置文件和场景集合，设好画质；舞台页当浏览器源 */
export async function prepareObs(obs: Obs, stageUrl: string, kbps = DEFAULT_STREAM_KBPS): Promise<void> {
  const encoder = streamEncoder(kbps);
  // 配置文件：画质、声音
  const { profiles, currentProfileName } = await obs.call<{ profiles: string[]; currentProfileName: string }>('GetProfileList');
  if (!profiles.includes(OBS_NAME)) await obs.call('CreateProfile', { profileName: OBS_NAME });
  else if (currentProfileName !== OBS_NAME) await obs.call('SetCurrentProfile', { profileName: OBS_NAME });
  await sleep(800);
  const params: Array<[string, string, string]> = [
    ['Output', 'Mode', 'Advanced'],
    ['AdvOut', 'Encoder', encoder.id],
    ['AdvOut', 'UseRescale', 'false'],
    ['AdvOut', 'TrackIndex', '1'],
    ['AdvOut', 'Track1Bitrate', '192'],
    ['AdvOut', 'ApplyServiceSettings', 'true'],
    ['Audio', 'SampleRate', '48000'],
    ['Audio', 'ChannelSetup', 'Stereo'],
    ['Output', 'Reconnect', 'true'],
    ['Output', 'RetryDelay', '2'],
    ['Output', 'MaxRetries', '25'],
    // 网络堵的时候降码率而不是丢帧（只对 RTMP 生效）
    ['Output', 'DynamicBitrate', 'true'],
  ];
  for (const [parameterCategory, parameterName, parameterValue] of params) {
    await obs.call('SetProfileParameter', { parameterCategory, parameterName, parameterValue });
  }
  await obs.call('SetVideoSettings', { fpsNumerator: 30, fpsDenominator: 1, baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080 });
  // 编码器参数在配置文件目录的 streamEncoder.json 里：写好后切走再切回来，让 OBS 重新读
  const dir = profileDir(OBS_NAME);
  if (!dir) throw new Error('找不到 OBS 的 dsh-livestream 配置文件目录');
  const file = join(dir, 'streamEncoder.json');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const wanted = JSON.stringify(encoder.settings, null, 1);
  if (current.trim() !== wanted.trim()) {
    writeFileSync(file, wanted);
    const other = profiles.find((p) => p !== OBS_NAME);
    // 只有这一套配置时也要真正切换，才能让 VideoToolbox / x264 回退参数在本次生效。
    // 临时配置使用唯一名字，只清理本次创建的那一套。
    const temporary = other ? null : `${OBS_NAME}-reload-${randomUUID()}`;
    if (other) {
      await obs.call('SetCurrentProfile', { profileName: other });
    } else {
      await obs.call('CreateProfile', { profileName: temporary });
    }
    await sleep(800);
    await obs.call('SetCurrentProfile', { profileName: OBS_NAME });
    await sleep(800);
    if (temporary) await obs.call('RemoveProfile', { profileName: temporary });
  }

  // 场景集合：一个场景，只有舞台页
  const { sceneCollections, currentSceneCollectionName } = await obs.call<{ sceneCollections: string[]; currentSceneCollectionName: string }>('GetSceneCollectionList');
  if (!sceneCollections.includes(OBS_NAME)) await obs.call('CreateSceneCollection', { sceneCollectionName: OBS_NAME });
  else if (currentSceneCollectionName !== OBS_NAME) await obs.call('SetCurrentSceneCollection', { sceneCollectionName: OBS_NAME });
  await sleep(1500);
  const { scenes } = await obs.call<{ scenes: Array<{ sceneName: string }> }>('GetSceneList');
  if (!scenes.some((s) => s.sceneName === SCENE)) await obs.call('CreateScene', { sceneName: SCENE });
  await obs.call('SetCurrentProgramScene', { sceneName: SCENE });
  // 声音只要舞台页的：去掉全局的麦克风和桌面音频
  const special = await obs.call<Record<string, string | null>>('GetSpecialInputs');
  for (const key of ['desktop1', 'desktop2', 'mic1', 'mic2', 'mic3', 'mic4']) {
    if (special[key]) await obs.call('RemoveInput', { inputName: special[key] });
  }
  const stage = {
    url: stageUrl,
    width: 1920,
    height: 1080,
    fps_custom: false,
    reroute_audio: true,
    shutdown: false,
    restart_when_active: false,
    css: 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }',
  };
  const { inputs } = await obs.call<{ inputs: Array<{ inputName: string }> }>('GetInputList');
  if (!inputs.some((i) => i.inputName === STAGE_SOURCE)) {
    await obs.call('CreateInput', { sceneName: SCENE, inputName: STAGE_SOURCE, inputKind: 'browser_source', inputSettings: stage });
  } else {
    await obs.call('SetInputSettings', { inputName: STAGE_SOURCE, inputSettings: stage });
  }
  // 舞台铺满画布、声音不回放到本机（不然主人这边会听到两遍）
  const { sceneItemId } = await obs.call<{ sceneItemId: number }>('GetSceneItemId', { sceneName: SCENE, sourceName: STAGE_SOURCE });
  await obs.call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId, sceneItemTransform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, boundsType: 'OBS_BOUNDS_NONE' } });
  await obs.call('SetInputAudioMonitorType', { inputName: STAGE_SOURCE, monitorType: 'OBS_MONITORING_TYPE_NONE' });
}

const GAME_WINDOW = '游戏窗口';
const GAME_HUD = '游戏 HUD';
const GAME_AUDIO = '游戏声音';
/** 游戏声音压低一点：她说话、视频声音在前面 */
const GAME_AUDIO_DB = -14;

/** ScreenCaptureKit 的 window 参数是动态的数字 ID，不能直接写入 Windows 的窗口描述字符串。 */
async function macWindowId(obs: Obs, target: string): Promise<number> {
  const { propertyItems } = await obs.call<{
    propertyItems: Array<{ itemName: string; itemValue: number | string; itemEnabled: boolean }>;
  }>('GetInputPropertiesListPropertyItems', { inputName: GAME_WINDOW, propertyName: 'window' });
  const windows = propertyItems.filter((item) => item.itemEnabled !== false && Number.isSafeInteger(Number(item.itemValue)) && Number(item.itemValue) > 0);
  const query = target.trim();
  let matches = windows.filter((item) => String(item.itemValue) === query || item.itemName === query);
  if (!matches.length && query) {
    // OBS 的完整显示名是「[应用] 窗口标题」；也接受唯一的完整标题，不做模糊匹配。
    matches = windows.filter((item) => item.itemName.replace(/^\[[^\]]*\]\s*/, '') === query);
  }
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? '有多个同名游戏窗口，请使用 OBS 窗口列表里的完整名称（[应用] 窗口标题）或数字窗口 ID'
      : '未找到游戏窗口：请打开目标窗口并授予 OBS 屏幕与系统音频录制权限，再使用窗口完整名称或数字窗口 ID');
  }
  return Number(matches[0].itemValue);
}

/**
 * 她在直播里玩的游戏（窗口画面）上舞台：窗口捕获摆在舞台的游戏位上（rect，画布坐标），
 * HUD 网页（透明背景、和窗口一样大）叠在它上面、一样摆；Windows 用应用音频捕获，macOS 用 ScreenCaptureKit 自带音频。
 * 窗口和 HUD 垫在舞台下面：舞台在游戏位把背景挖空，礼物提醒、特效、字幕照样浮在游戏画面上。null：三个源都拿掉
 */
export async function showGameSources(obs: Obs, game: { window: string; overlay?: string } | null, rect: { x: number; y: number; w: number; h: number }): Promise<void> {
  const { inputs } = await obs.call<{ inputs: Array<{ inputName: string; inputKind: string; unversionedInputKind?: string }> }>('GetInputList');
  const kinds = new Map(inputs.map((input) => [input.inputName, input.unversionedInputKind ?? input.inputKind]));
  const has = (name: string) => kinds.has(name);
  const remove = async (name: string) => {
    if (has(name)) await obs.call('RemoveInput', { inputName: name });
    kinds.delete(name);
  };
  if (!game) {
    for (const name of [GAME_HUD, GAME_WINDOW, GAME_AUDIO]) await remove(name);
    return;
  }
  const put = async (name: string, kind: string, settings: Record<string, unknown>, enabled = true) => {
    // 从别的平台导入的场景可能有同名但不同类型的源；OBS 不能靠 SetInputSettings 更换源类型。
    if (has(name) && kinds.get(name) !== kind) await remove(name);
    if (has(name)) {
      const { sceneItemId } = await obs.call<{ sceneItemId: number }>('GetSceneItemId', { sceneName: SCENE, sourceName: name });
      await obs.call('SetSceneItemEnabled', { sceneName: SCENE, sceneItemId, sceneItemEnabled: enabled });
      await obs.call('SetInputSettings', { inputName: name, inputSettings: settings });
    } else {
      await obs.call('CreateInput', { sceneName: SCENE, inputName: name, inputKind: kind, inputSettings: settings, sceneItemEnabled: enabled });
      kinds.set(name, kind);
    }
    const { sceneItemId } = await obs.call<{ sceneItemId: number }>('GetSceneItemId', { sceneName: SCENE, sourceName: name });
    return sceneItemId;
  };
  const mac = process.platform === 'darwin';
  let windowItem: number;
  if (mac) {
    const { inputKinds } = await obs.call<{ inputKinds: string[] }>('GetInputKindList', { unversioned: true });
    if (!inputKinds.includes('screen_capture')) throw new Error('OBS 没有 macOS 屏幕捕获源，请安装官方 OBS，并使用 macOS 13+');
    await remove(GAME_AUDIO);
    await remove(GAME_HUD);
    // 先建禁用的窗口源再查询列表；匹配失败时不启用，避免误播别的窗口或默认整个桌面。
    windowItem = await put(GAME_WINDOW, 'screen_capture', { type: 1, window: 0, show_cursor: false, show_empty_names: false, show_hidden_windows: false }, false);
    const window = await macWindowId(obs, game.window);
    await obs.call('SetInputSettings', { inputName: GAME_WINDOW, inputSettings: { type: 1, window } });
  } else if (process.platform === 'win32') {
    // method 2 = Windows Graphics Capture：窗口被挡住也抓得到；只抓客户区、不要鼠标
    windowItem = await put(GAME_WINDOW, 'window_capture', { window: game.window, method: 2, client_area: true, cursor: false, compatibility: false });
  } else {
    throw new Error('游戏窗口捕获目前只支持 Windows 和 macOS；其他系统可以使用网页游戏画面');
  }
  const place = {
    positionX: rect.x, positionY: rect.y, alignment: 5,
    boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: rect.w, boundsHeight: rect.h, boundsAlignment: 0,
  };
  await obs.call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: windowItem, sceneItemTransform: place });
  await obs.call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: windowItem, sceneItemIndex: 0 });
  if (mac) {
    // 已确认目标后才显示；先设音量再启用，HUD 的尺寸采样也需要窗口源开始渲染。
    await obs.call('SetInputVolume', { inputName: GAME_WINDOW, inputVolumeDb: GAME_AUDIO_DB });
    await obs.call('SetInputAudioMonitorType', { inputName: GAME_WINDOW, monitorType: 'OBS_MONITORING_TYPE_NONE' });
    await obs.call('SetSceneItemEnabled', { sceneName: SCENE, sceneItemId: windowItem, sceneItemEnabled: true });
  }
  if (game.overlay) {
    // HUD 网页要和窗口一样大才叠得准：等窗口抓到画面，拿它的原始大小
    let size = { w: 1280, h: 720 };
    for (let i = 0; i < 10; i++) {
      const t = await obs.call<{ sceneItemTransform: { sourceWidth: number; sourceHeight: number } }>('GetSceneItemTransform', { sceneName: SCENE, sceneItemId: windowItem });
      if (t.sceneItemTransform.sourceWidth > 0) {
        size = { w: t.sceneItemTransform.sourceWidth, h: t.sceneItemTransform.sourceHeight };
        break;
      }
      await sleep(500);
    }
    const hudItem = await put(GAME_HUD, 'browser_source', {
      url: game.overlay, width: size.w, height: size.h, fps_custom: false, reroute_audio: false, shutdown: false,
      css: 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }',
    });
    await obs.call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: hudItem, sceneItemTransform: place });
    await obs.call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: hudItem, sceneItemIndex: 1 });
  } else {
    await remove(GAME_HUD);
  }
  // macOS 13+ 的 ScreenCaptureKit 源已包含窗口所属应用的音频，不再创建 Windows WASAPI 源。
  if (!mac) {
    await put(GAME_AUDIO, 'wasapi_process_output_capture', { window: game.window, priority: 2 });
    await obs.call('SetInputVolume', { inputName: GAME_AUDIO, inputVolumeDb: GAME_AUDIO_DB });
    await obs.call('SetInputAudioMonitorType', { inputName: GAME_AUDIO, monitorType: 'OBS_MONITORING_TYPE_NONE' });
  }
}

/** 推流到 B 站：写入推流地址和推流码，开始推流，确认真的推上了 */
export async function startStreaming(obs: Obs, addr: string, code: string): Promise<void> {
  await obs.call('SetStreamServiceSettings', {
    streamServiceType: 'rtmp_custom',
    streamServiceSettings: { server: addr, key: code, use_auth: false, bwtest: false },
  });
  const status = await obs.call<{ outputActive: boolean }>('GetStreamStatus');
  if (!status.outputActive) await obs.call('StartStream');
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if ((await obs.call<{ outputActive: boolean }>('GetStreamStatus')).outputActive) return;
  }
  throw new Error('OBS 没能开始推流（看 OBS 的日志）');
}

/** 检查 OBS：设好配置和场景，返回节目画面的一帧（PNG data URL）和当前设置；不推流 */
export async function checkObs(obs: Obs, stageUrl: string, kbps?: number): Promise<{ image: string; video: unknown; profile: string; collection: string }> {
  await prepareObs(obs, stageUrl, kbps);
  // 等舞台页加载出来
  await sleep(4000);
  const video = await obs.call('GetVideoSettings');
  const { currentProfileName } = await obs.call<{ currentProfileName: string }>('GetProfileList');
  const { currentSceneCollectionName } = await obs.call<{ currentSceneCollectionName: string }>('GetSceneCollectionList');
  const shot = await obs.call<{ imageData: string }>('GetSourceScreenshot', { sourceName: SCENE, imageFormat: 'jpg', imageWidth: 960, imageHeight: 540, imageCompressionQuality: 85 });
  return { image: shot.imageData, video, profile: currentProfileName, collection: currentSceneCollectionName };
}

export async function stopStreaming(obs: Obs): Promise<void> {
  const status = await obs.call<{ outputActive: boolean }>('GetStreamStatus');
  if (status.outputActive) await obs.call('StopStream');
}

export interface StreamHealth {
  active: boolean;
  /** 推了多久 */
  timecode: string;
  /** 丢帧（网络） */
  skipped: number;
  total: number;
  /** 渲染延迟、编码延迟的帧 */
  renderSkipped: number;
  outputSkipped: number;
  kbps: number;
}

let lastBytes: { bytes: number; at: number } | null = null;

export async function streamHealth(obs: Obs): Promise<StreamHealth> {
  const s = await obs.call<{ outputActive: boolean; outputTimecode: string; outputSkippedFrames: number; outputTotalFrames: number; outputBytes: number }>('GetStreamStatus');
  const stats = await obs.call<{ renderSkippedFrames: number; outputSkippedFrames: number }>('GetStats');
  const now = Date.now();
  const kbps = lastBytes && s.outputBytes >= lastBytes.bytes ? Math.round(((s.outputBytes - lastBytes.bytes) * 8) / Math.max(1, now - lastBytes.at)) : 0;
  lastBytes = { bytes: s.outputBytes, at: now };
  return { active: s.outputActive, timecode: s.outputTimecode, skipped: s.outputSkippedFrames, total: s.outputTotalFrames, renderSkipped: stats.renderSkippedFrames, outputSkipped: stats.outputSkippedFrames, kbps };
}

/** 直播画面现在的样子（OBS 里「直播」场景，观众看到的同一张）：JPEG */
export async function screenshot(width = 1280, height = 720): Promise<Uint8Array> {
  const obs = await connectObs(false);
  try {
    const shot = await obs.call<{ imageData: string }>('GetSourceScreenshot', { sourceName: SCENE, imageFormat: 'jpg', imageWidth: width, imageHeight: height, imageCompressionQuality: 80 });
    return new Uint8Array(Buffer.from(shot.imageData.slice(shot.imageData.indexOf(',') + 1), 'base64'));
  } finally {
    obs.close();
  }
}

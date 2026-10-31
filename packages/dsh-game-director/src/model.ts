export const ID = /^[a-z][a-z0-9-]{0,47}$/;
export type TaskState = 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Game {
  id: string;
  title: string;
  description: string;
  source: 'sample' | 'candidate' | 'developer-report';
  createdAt: string;
  latestDevelopment?: string;
}
export interface Choice { gameId: string; reason: string; goal: string; at: string }
export interface DevelopmentInput {
  references?: string;
  sourcePath?: string;
  repository?: string;
  artifactPath?: string;
}
export interface Inspection {
  method: 'source' | 'rea' | 'mixed' | 'unavailable';
  evidence: string[];
  entrypoints: string[];
  limitations: string[];
}
export interface DevelopmentReport {
  outcome: 'source-ready' | 'blocked';
  summary: string;
  files: string[];
  blockers: string[];
  /** Optional only for records saved before the source/REA investigation workflow. */
  inspection?: Inspection;
}
export interface Task {
  id: string;
  owner: string;
  gameId: string;
  kind: 'develop' | 'play';
  state: TaskState;
  preset: string;
  controlService?: string;
  cwd: string;
  directory?: string;
  investigation?: DevelopmentInput;
  modelRoute?: { provider: string; model: string };
  childId?: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  diagnostic?: string;
  stopReason?: string;
  report?: DevelopmentReport;
}
export interface State {
  version: 1;
  games: Game[];
  choices: Record<string, Choice>;
  tasks: Task[];
}
export interface Binding { gameId: string; preset: string; controlService: string; prompt: string }
export interface Settings {
  playBindings: string;
  maxDevelopmentAttempts: number;
  developerProvider: string;
  developerModel: string;
  reaCommand: string;
}
export const DEFAULT_BINDINGS = JSON.stringify([{
  gameId: 'stardew', preset: 'dsh-stardew', controlService: 'stardewControl',
  prompt: '用 game_start 的 stardew 接管已加载的单人存档。默认经营一天；仅当主人指定连续经营天数且工具声明支持 days 时传入该天数，否则保持一天。按实际 catalog 确认扩展接口，存在时读取本存档 memory、任务和资源信息，再安排计划；未安装的钓鱼、战斗或菜单接口不能编造。每天核对正常睡眠和次日可操作状态；只有返回结果允许时用 next_day 继续。完成本次预算后先读取可用的 report，再用 game_stop 释放控制并总结。不要自行延长任务，也不把原子接口可调用当作完整玩法已验证。',
}]);
export const ongoing = (task: Task) => ['starting', 'running', 'stopping'].includes(task.state);
export const now = () => new Date().toISOString();

export function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}不能为空，且不能超过 ${max} 个字符。`);
  return value.trim();
}
export function gameId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('游戏 ID 用小写字母开头，最多 48 位，只含字母、数字和连字符。');
  return value;
}
export function developmentInput(raw: DevelopmentInput): DevelopmentInput {
  const result: DevelopmentInput = {};
  for (const key of ['references', 'sourcePath', 'repository', 'artifactPath'] as const) {
    const value = raw[key];
    if (value === undefined || value === '') continue;
    result[key] = requiredText(value, key, key === 'references' ? 6000 : 4096);
    if (result[key]!.includes('\0')) throw new Error(`${key} 包含无效字符。`);
  }
  if (result.repository) {
    let url: URL;
    try { url = new URL(result.repository); } catch { throw new Error('源码仓库需要完整的 HTTPS 地址。'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('源码仓库需要不含登录信息的 HTTPS 地址。');
  }
  return result;
}
export function bindings(settings: Settings): Binding[] {
  let rows: unknown;
  try { rows = JSON.parse(settings.playBindings); } catch { throw new Error('插件设置 playBindings 必须是 JSON 数组。'); }
  if (!Array.isArray(rows) || rows.length > 64) throw new Error('playBindings 最多包含 64 个游戏。');
  const ids = new Set<string>();
  return rows.map(row => {
    const id = gameId(row?.gameId);
    if (ids.has(id)) throw new Error(`playBindings 中的 ${id} 重复了。`);
    ids.add(id);
    const preset = requiredText(row.preset, '预设 ID', 160);
    if (['dsh-game-director', 'dsh-game-developer'].includes(preset)) throw new Error('游玩预设不能指回导演或开发预设。');
    return { gameId: id, preset, controlService: requiredText(row.controlService, '控制服务名', 160), prompt: requiredText(row.prompt, '开局目标', 4000) };
  });
}

/** JSON validity is evidence of a report, never evidence that generated code actually works. */
export function developmentReport(raw: unknown): DevelopmentReport | undefined {
  if (!raw || typeof raw !== 'object') return;
  const r = raw as Partial<DevelopmentReport>;
  if (!['source-ready', 'blocked'].includes(String(r.outcome)) || typeof r.summary !== 'string'
    || !Array.isArray(r.files) || !Array.isArray(r.blockers)
    || !r.files.every(f => typeof f === 'string') || !r.blockers.every(b => typeof b === 'string')) return;
  let inspection: Inspection | undefined;
  if (r.inspection !== undefined) {
    const i = r.inspection;
    if (!i || !['source', 'rea', 'mixed', 'unavailable'].includes(i.method)
      || ![i.evidence, i.entrypoints, i.limitations].every(rows => Array.isArray(rows) && rows.every(row => typeof row === 'string'))) return;
    inspection = {
      method: i.method,
      evidence: i.evidence.slice(0, 32).map(row => row.slice(0, 2000)),
      entrypoints: i.entrypoints.slice(0, 32).map(row => row.slice(0, 2000)),
      limitations: i.limitations.slice(0, 32).map(row => row.slice(0, 1000)),
    };
  }
  return {
    outcome: r.outcome!, summary: r.summary.slice(0, 8000),
    files: r.files.slice(0, 64).map(f => f.slice(0, 500)),
    blockers: r.blockers.slice(0, 32).map(b => b.slice(0, 1000)),
    ...(inspection ? { inspection } : {}),
  };
}

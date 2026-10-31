import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FarmIdentity } from './extension.js';
import { runOptions, type RunOptions } from './run-options.js';
import type { NightReport } from './night-observation.js';

export interface GameDate { year: number; season: string; dayOfMonth: number }
export interface Snapshot {
  date: GameDate; timeOfDay: number;
  player: { canMove: boolean; energy: number; maxEnergy: number; health: number; maxHealth: number; money: string; position: { locationId: string; x: number; y: number } };
  ui: { menuOpen: boolean; menuType: string }; weather: { kind: string };
}
export interface DayReport {
  day: number; planByModel: string;
  observed: { start: Snapshot; afterSleep: Snapshot; submittedActions: number; sleepConfirmed: true; dayAdvanced: true;
    beforeSleep?: Snapshot; night?: NightReport; nightUnavailable?: 'invalid_snapshot_or_receipt' };
}
export interface ModelNote { at: string; gameDate: string; text: string }
export interface RunCheckpoint {
  version: 1; runId: string; identity: FarmIdentity; options: Readonly<RunOptions>;
  initial: Snapshot; dayStart: Snapshot; latest: Snapshot; expectedDay: number;
  betweenDays: boolean; days: DayReport[]; notes: ModelNote[]; plan: string; writes: number;
  status: 'running' | 'stopped' | 'halted' | 'completed'; reason: string;
  pendingAction: { name: string; submittedAt: string } | null; savedAt: string;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function dayNumber(date: GameDate): number {
  const season = ['spring', 'summer', 'fall', 'winter'].indexOf(date?.season);
  if (season < 0 || !Number.isInteger(date?.year) || date.year < 1 || !Number.isInteger(date.dayOfMonth) || date.dayOfMonth < 1 || date.dayOfMonth > 28) throw new Error('游戏日期格式不受支持。');
  return date.year * 112 + season * 28 + date.dayOfMonth;
}

export class PersistenceError extends Error {}

function readJson(path: string): unknown {
  try {
    const source = readFileSync(path, 'utf8');
    if (Buffer.byteLength(source) > 2_000_000) throw new Error();
    return JSON.parse(source);
  } catch {
    // Native filesystem/JSON errors may embed host paths or a raw memory text fragment.
    throw new PersistenceError('经营记录无法读取、过大或格式损坏；未自动覆盖或重放。');
  }
}

/** Atomic replacement; a failed write never leaves a half-written checkpoint that appears resumable. */
export function atomicJson(path: string, data: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch { throw new PersistenceError('无法保存经营记录，未确认持久化。'); }
  finally { try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* Keep the old atomic file; a leftover temp is never loaded. */ } }
}

export function checkpointPath(root: string, runId: string): string {
  if (!uuid.test(runId)) throw new Error('runId 必须是报告返回的 UUID。');
  return join(root, 'checkpoints', `${runId}.json`);
}

/** Read historical state without granting a new control connection or claiming live consistency. */
export function inspectCheckpoint(root: string, runId: string): RunCheckpoint {
  const data = readJson(checkpointPath(root, runId)) as RunCheckpoint;
  if (!data || data.version !== 1 || data.runId !== runId || !/^[a-f0-9]{64}$/.test(data.identity?.saveId ?? '')
    || !uuid.test(data.identity?.gameBuildId ?? '') || !/^\d+(?:\.\d+){1,3}$/.test(data.identity?.gameAssemblyVersion ?? '')
    || !/^[a-f0-9]{64}$/.test(data.identity?.controlDigest ?? '') || !data.initial?.date || !data.dayStart?.date || !data.latest?.date
    || !Array.isArray(data.days) || !Array.isArray(data.notes) || data.notes.length > 64 || !Number.isInteger(data.writes) || data.writes < 0
    || !Number.isInteger(data.expectedDay) || typeof data.betweenDays !== 'boolean' || typeof data.plan !== 'string'
    || !['running', 'stopped', 'halted', 'completed'].includes(data.status)) throw new Error('经营检查点格式无效，未自动恢复。');
  data.options = runOptions(data.options);
  const firstDay = dayNumber(data.initial.date);
  if (data.days.length > data.options.days || data.days.some((day, index) => day.day !== index + 1 || day.observed?.sleepConfirmed !== true || day.observed?.dayAdvanced !== true)) throw new Error('经营检查点天数证据不一致。');
  if (data.expectedDay !== firstDay + data.days.length || (data.status !== 'halted' && dayNumber(data.latest.date) !== data.expectedDay)
    || dayNumber(data.dayStart.date) !== data.expectedDay - (data.betweenDays || data.status === 'completed' ? 1 : 0)
    || (data.betweenDays && data.days.length === 0)
    || (data.status === 'completed' && (data.days.length !== data.options.days || data.betweenDays))
    || data.days.some((day, index) => dayNumber(day.observed.start.date) !== firstDay + index || dayNumber(day.observed.afterSleep.date) !== firstDay + index + 1)) throw new Error('检查点日期与已确认天数不一致，未恢复。');
  return data;
}

export function readCheckpoint(root: string, runId: string): RunCheckpoint {
  const data = inspectCheckpoint(root, runId);
  if (data.status === 'completed' || data.status === 'halted' || data.days.length >= data.options.days) throw new Error('这次经营已结束或停止于异常状态，不能恢复来延长预算。');
  if (data.pendingAction) throw new Error(`崩溃前 ${data.pendingAction.name} 的结果未确认。不能恢复或重放；先核对游戏现场。`);
  return data;
}

export function saveCheckpoint(root: string, checkpoint: RunCheckpoint): void {
  atomicJson(checkpointPath(root, checkpoint.runId), checkpoint);
}

interface FarmTask {
  id: string; text: string; priority: number; status: 'todo' | 'done' | 'blocked';
  dependsOn: string[]; goldBudget: number | null; energyBudget: number | null; dueDay?: number;
  updatedAt: string; source: 'model'; evidenceByModel?: string;
}
interface FarmMemory {
  version: 1; saveId: string; tasks: FarmTask[]; notes: ModelNote[];
  observations: { at: string; tool: string; args: Record<string, unknown>; output: unknown }[];
}

export class FarmMemoryStore {
  private file: string;
  private data: FarmMemory;
  constructor(root: string, saveId: string) {
    if (!/^[a-f0-9]{64}$/.test(saveId)) throw new Error('无法隔离农场记忆。');
    this.file = join(root, 'farms', saveId, 'memory.json');
    this.data = existsSync(this.file) ? readJson(this.file) as FarmMemory : { version: 1, saveId, tasks: [], notes: [], observations: [] };
    if (this.data?.version !== 1 || this.data.saveId !== saveId || !Array.isArray(this.data.tasks) || this.data.tasks.length > 64
      || !Array.isArray(this.data.notes) || this.data.notes.length > 128 || this.data.notes.some(note => typeof note?.text !== 'string' || note.text.length > 2000)
      || !Array.isArray(this.data.observations) || this.data.observations.length > 12) throw new Error('农场记忆文件格式不一致，未覆盖旧文件。');
    this.data.tasks.forEach(task => this.validateTask(task));
    this.validateGraph(this.data.tasks);
  }
  private save(): void { atomicJson(this.file, this.data); }
  read(source = '{}'): string {
    const request = JSON.parse(source);
    const section = request.section ?? 'summary', offset = request.offset ?? 0, limit = request.limit ?? 8;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('记忆分页 offset >= 0，limit 为 1–20。');
    const rows = section === 'tasks' ? this.data.tasks : section === 'notes' ? this.data.notes : section === 'observations' ? this.data.observations : null;
    if (!rows && section !== 'summary') throw new Error('记忆 section 可用 summary/tasks/notes/observations。');
    return JSON.stringify({ version: 1, saveId: this.data.saveId, section, counts: { tasks: this.data.tasks.length, notes: this.data.notes.length, observations: this.data.observations.length },
      ...(rows ? { offset, items: rows.slice(offset, offset + limit), nextOffset: offset + limit < rows.length ? offset + limit : null }
        : { openTasks: this.data.tasks.filter(task => task.status === 'todo').slice(0, 8), recentNotes: this.data.notes.slice(-4), observations: this.data.observations.map(({ at, tool, args }) => ({ at, tool, args })) }),
      note: '历史观察不是当前状态；计划、待办、完成标记及笔记均为模型记录，执行前重新查游戏事实。' });
  }
  remember(note: ModelNote): void { this.data.notes = [...this.data.notes.slice(-127), note]; this.save(); }
  observe(tool: string, args: Record<string, unknown>, output: unknown): void {
    if (Buffer.byteLength(JSON.stringify(output)) > 24_000) return;
    // Only selected companion facts are retained. Never retain old MCP item/UI refs as actionable handles.
    this.data.observations = [...this.data.observations.slice(-11), { at: new Date().toISOString(), tool, args, output }];
    this.save();
  }
  task(source: string): string {
    const input = JSON.parse(source);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('task 需要 JSON 对象。');
    const id = input.id ?? randomUUID();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('任务 ID 必须是 1–64 位字母、数字、下划线或短横线。');
    const old = this.data.tasks.find(task => task.id === id);
    if (input.remove === true) {
      if (this.data.tasks.some(task => task.dependsOn.includes(id))) throw new Error('先移除依赖关系，再删除这个任务。');
      this.data.tasks = this.data.tasks.filter(task => task.id !== id); this.save(); return `已删除模型任务 ${id}。`;
    }
    const value: FarmTask = {
      id, text: input.text ?? old?.text ?? '', priority: input.priority ?? old?.priority ?? 3,
      status: input.status ?? old?.status ?? 'todo', dependsOn: input.dependsOn ?? old?.dependsOn ?? [],
      goldBudget: input.goldBudget ?? old?.goldBudget ?? null, energyBudget: input.energyBudget ?? old?.energyBudget ?? null,
      dueDay: input.dueDay ?? old?.dueDay, updatedAt: new Date().toISOString(), source: 'model',
      evidenceByModel: typeof input.evidence === 'string' ? input.evidence.slice(0, 2000) : old?.evidenceByModel,
    };
    this.validateTask(value);
    const next = [...this.data.tasks.filter(task => task.id !== id), value];
    if (next.length > 64) throw new Error('最多保留 64 个农场任务。');
    this.validateGraph(next);
    this.data.tasks = next; this.save();
    return JSON.stringify({ task: value, note: '状态和证据文字由模型填写，不等于游戏自动核验。' });
  }

  private validateTask(value: FarmTask): void {
    if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 2000
      || !Number.isInteger(value.priority) || value.priority < 1 || value.priority > 5 || value.source !== 'model'
      || !['todo', 'done', 'blocked'].includes(value.status) || !Array.isArray(value.dependsOn) || value.dependsOn.length > 16 || value.dependsOn.some(id => typeof id !== 'string')
      || (value.goldBudget !== null && (!Number.isFinite(value.goldBudget) || value.goldBudget < 0)) || (value.energyBudget !== null && (!Number.isFinite(value.energyBudget) || value.energyBudget < 0))
      || (value.dueDay !== undefined && (!Number.isInteger(value.dueDay) || value.dueDay < 0))) throw new Error('任务文字、优先级、依赖或预算无效。');
  }

  private validateGraph(tasks: FarmTask[]): void {
    const map = new Map(tasks.map(task => [task.id, task]));
    if (map.size !== tasks.length) throw new Error('任务 ID 重复。');
    const visited = new Set<string>(), visiting = new Set<string>();
    const walk = (id: string): void => {
      if (visiting.has(id)) throw new Error('任务依赖不能形成循环。');
      if (visited.has(id)) return;
      const task = map.get(id);
      if (!task || !Array.isArray(task.dependsOn)) throw new Error('任务依赖指向不存在的任务。');
      visiting.add(id); task.dependsOn.forEach(walk); visiting.delete(id); visited.add(id);
    };
    tasks.forEach(task => walk(task.id));
  }

  schedule(snapshot: Snapshot, day: number): string {
    let gold = Number(snapshot.player.money), energy = Math.max(0, snapshot.player.energy - 30);
    if (!Number.isFinite(gold)) throw new Error('金币状态无效，未计算预算。');
    const available: FarmTask[] = [], excluded: { id: string; reason: string }[] = [];
    const done = new Set(this.data.tasks.filter(task => task.status === 'done').map(task => task.id));
    for (const task of [...this.data.tasks].filter(task => task.status === 'todo').sort((a, b) => (a.dueDay ?? Infinity) - (b.dueDay ?? Infinity) || a.priority - b.priority || a.id.localeCompare(b.id))) {
      const reason = task.dependsOn.some(id => !done.has(id)) ? '模型记录的依赖尚未完成'
        : snapshot.timeOfDay >= 2100 || snapshot.player.health < 30 ? '优先返回安全地点'
          : task.goldBudget === null || task.energyBudget === null ? '尚未估算金币或体力预算，不能默认为零'
            : task.goldBudget > gold || task.energyBudget > energy ? '超过当前金币或预留体力后的预算' : '';
      if (reason) excluded.push({ id: task.id, reason });
      else { gold -= task.goldBudget!; energy -= task.energyBudget!; available.push(task); }
    }
    return JSON.stringify({ available, excluded, currentDay: day, remainingGold: gold, remainingEnergyAfterReserve: energy,
      note: '这是依赖和模型估算预算的筛选，不是经过游戏验证的执行计划。重新核对天气、季节、营业时间、路径、任务条件和实际材料价格。' });
  }
}

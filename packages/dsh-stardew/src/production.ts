import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FarmIdentity } from './extension.js';
import { atomicJson, PersistenceError } from './persistence.js';
import type { Position } from './workflow-context.js';

export interface MachineInput {
  itemId: string; quality: number; maxInputCount: number;
  materialBudgets: { itemId: string; maxCount: number }[];
}
export interface MachineJob {
  version: 1; id: string; saveId: string; gameBuildId: string; createdRunId: string; lastRunId: string;
  position: Position; machineItemId: string; requestedInput: MachineInput | null;
  allowHopperReload: boolean;
  phase: 'prepared' | 'loading' | 'waiting' | 'collecting' | 'completed' | 'uncertain' | 'stopped';
  createdAt: string; updatedAt: string; contentsKey?: string;
  lastObserved?: { state: string; minutesUntilReady: number; output: unknown; observedAt: string };
  receipt?: unknown; reason?: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;

/** One durable record per native production cycle. Never persist actionable MCP/UI refs. */
export class MachineJobs {
  private directory: string;
  constructor(root: string, private identity: Readonly<FarmIdentity>) {
    if (!digest.test(identity.saveId) || !uuid.test(identity.gameBuildId)) throw new PersistenceError('缺少已核对的生产存档/构建身份。');
    this.directory = join(root, 'farms', identity.saveId, 'production');
  }
  private read(path: string): unknown {
    try {
      const text = readFileSync(path, 'utf8');
      if (Buffer.byteLength(text) > 64000) throw new Error();
      return JSON.parse(text);
    } catch { throw new PersistenceError('生产记录无法读取或已损坏，没有自动覆盖或重放。'); }
  }
  private active(): string[] {
    const path = join(this.directory, 'active.json');
    if (!existsSync(path)) return [];
    const data = this.read(path) as { version?: number; saveId?: string; ids?: unknown };
    if (data?.version !== 1 || data.saveId !== this.identity.saveId || !Array.isArray(data.ids) || data.ids.length > 256
      || data.ids.some(id => typeof id !== 'string' || !uuid.test(id)) || new Set(data.ids).size !== data.ids.length) throw new PersistenceError('生产索引格式无效，未重领或覆盖记录。');
    return data.ids;
  }
  get(id: string): MachineJob {
    if (!uuid.test(id)) throw new Error('jobId必须来自production或workflow返回的真实UUID。');
    const path = join(this.directory, `${id}.json`);
    if (!existsSync(path)) {
      if (this.active().includes(id)) throw new PersistenceError('生产索引指向的记录丢失，停止变更，未覆盖或重领。');
      throw new Error('当前存档没有这个jobId；没有读取其他存档的文件。');
    }
    const job = this.read(path) as MachineJob;
    if (!job || job.version !== 1 || job.id !== id || job.saveId !== this.identity.saveId || !uuid.test(job.gameBuildId)
      || !uuid.test(job.createdRunId) || !uuid.test(job.lastRunId) || !job.position || typeof job.position.locationId !== 'string'
      || !Number.isInteger(job.position.x) || !Number.isInteger(job.position.y) || job.position.x < 0 || job.position.y < 0
      || typeof job.machineItemId !== 'string' || typeof job.allowHopperReload !== 'boolean' || !['prepared', 'loading', 'waiting', 'collecting', 'completed', 'uncertain', 'stopped'].includes(job.phase)
      || job.contentsKey !== undefined && !digest.test(job.contentsKey)
      || ['waiting', 'collecting', 'completed'].includes(job.phase) && !digest.test(job.contentsKey ?? '')) throw new PersistenceError('生产记录身份或状态格式无效，没有自动执行。');
    return job;
  }
  create(position: Position, machineItemId: string, requestedInput: MachineInput | null, runId: string, allowHopperReload = false): MachineJob {
    const ids = this.active();
    for (const id of ids) {
      const old = this.get(id);
      if (!['completed', 'stopped'].includes(old.phase) && old.position.locationId === position.locationId && old.position.x === position.x && old.position.y === position.y) throw new Error(`该机器已有未结束的生产记录${old.id}；先查production，不能重复投料或跳过未知结果。`);
    }
    if (ids.length >= 256) throw new Error('未结束生产记录达到256项，请先处理已有记录；未删除历史或重复开工。');
    const job: MachineJob = { version: 1, id: randomUUID(), saveId: this.identity.saveId, gameBuildId: this.identity.gameBuildId,
      createdRunId: runId, lastRunId: runId, position, machineItemId, requestedInput, allowHopperReload, phase: 'prepared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.put(job);
    return job;
  }
  put(job: MachineJob): void {
    if (!uuid.test(job.id) || job.saveId !== this.identity.saveId || job.gameBuildId !== this.identity.gameBuildId) throw new PersistenceError('不能跨存档或构建保存生产状态。');
    const ids = this.active();
    job.updatedAt = new Date().toISOString();
    if (Buffer.byteLength(JSON.stringify(job)) > 64000) throw new PersistenceError('生产记录过大，未截断证据或继续操作。');
    atomicJson(join(this.directory, `${job.id}.json`), job);
    const terminal = ['completed', 'stopped'].includes(job.phase);
    const next = terminal ? ids.filter(id => id !== job.id) : ids.includes(job.id) ? ids : [...ids, job.id];
    atomicJson(join(this.directory, 'active.json'), { version: 1, saveId: this.identity.saveId, ids: next });
  }
  assertBuild(job: MachineJob): void {
    if (job.gameBuildId !== this.identity.gameBuildId) throw new Error('这个生产记录来自另一游戏构建，不能未经核对继续。');
  }
  list(source = '{}'): string {
    const request = JSON.parse(source);
    const offset = request?.offset ?? 0, limit = request?.limit ?? 8;
    if (!request || typeof request !== 'object' || Array.isArray(request) || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('production分页需要offset>=0、limit=1–20。');
    const ids = this.active();
    return JSON.stringify({ saveId: this.identity.saveId, count: ids.length, offset,
      items: ids.slice(offset, offset + limit).map(id => this.get(id)), nextOffset: offset + limit < ids.length ? offset + limit : null,
      note: '持久生产历史，不是当前现场。requestedInput是请求预算，lastObserved/receipt来自后端观察；等待不等于完成，loading/collecting/uncertain不能自动重放。完成的单独记录仍保留，可通过已返回jobId查询。' });
  }
}

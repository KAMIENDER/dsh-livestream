import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from './config.js';
import type { GameDriver } from './game.js';
import { StardewRun } from './stardew.js';
import { runOptions, type RunOptions } from './run-options.js';
import { inspectCheckpoint, readCheckpoint } from './persistence.js';
import { ExperienceLedger } from './experiences.js';

let readSettings: () => Settings = () => ({ mcpCommand: '', modConfig: '', captureWindow: '' });
let readCharacterMemory: () => {
  bindingFor?(sessionId: string): { profile: { id: string } } | null;
  recordGameExperience?(characterId: string, event: unknown): 'recorded' | 'forgotten';
} | undefined = () => undefined;
export const settings = () => readSettings();
export function bindSettings(read: () => Settings): void { readSettings = read; }
export function bindCharacterMemory(read: typeof readCharacterMemory): void { readCharacterMemory = read; }

let driver: GameDriver | null = null;
let owner: string | null = null;
let busy = false;
let generation = 0;
let stopping: Promise<string> | null = null;
const completedOwners = new Set<string>();
const stateDir = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-stardew');
// The livestream host may ask an old session to game_start after a restart. Never grant it a new run budget.
const claimPath = (ownerId: string) => join(stateDir(), 'sessions', `${createHash('sha256').update(ownerId).digest('hex')}.json`);
interface SessionClaim { startedAt: string; game: 'stardew'; runId?: string; options?: Readonly<RunOptions> }
function readClaim(ownerId: string): SessionClaim | null {
  const path = claimPath(ownerId);
  if (!existsSync(path)) return null;
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { throw new Error('接管记录无法读取；未自动覆盖或重领预算。'); }
  if (Buffer.byteLength(text) > 16000) throw new Error('会话接管记录异常，未重置原有预算。');
  let claim: SessionClaim;
  try { claim = JSON.parse(text); } catch { throw new Error('接管记录无法解析；未自动覆盖或重领预算。'); }
  if (!claim || claim.game !== 'stardew' || typeof claim.startedAt !== 'string'
    || !Number.isFinite(Date.parse(claim.startedAt))
    || claim.runId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(claim.runId)) throw new Error('会话接管记录格式无效；未自动覆盖、删除或重领预算。');
  if (claim.options) claim.options = runOptions(claim.options);
  return claim;
}
export function current(): GameDriver | null { return driver; }
export function currentOwner(): string | null { return owner; }

/** Offline history belongs to this actual session's saved claim, never a supplied save/run ID. */
export function historyFor(ownerId: string, recoverDays: boolean, offset = 0, limit = 6): string {
  if (typeof recoverDays !== 'boolean' || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('历史查询需要offset>=0、limit=1–20和可选recoverDays。');
  if (recoverDays && (driver || busy)) throw new Error('补记日终仅在控制连接停止后进行；先game_stop，避免两份经历账本同时写入。未停止或操作游戏。');
  const claim = readClaim(ownerId);
  if (!claim?.runId) return JSON.stringify({ available: false, note: '本会话没有可定位的已保存runId，未读取其他会话或重领预算。' });
  const saved = inspectCheckpoint(stateDir(), claim.runId);
  const ledger = new ExperienceLedger(stateDir(), saved.identity);
  if (recoverDays) {
    // Also works for a completed run: no resume, connection, old Ref, or game input.
    // Missing original character bindings remain unbound instead of being guessed.
    for (const day of saved.days) ledger.recordDay(saved.runId, day, null);
  }
  return ledger.list(JSON.stringify({ offset, limit }));
}

/** Read only this actual DSH session's claim, even after the live transport has gone away. */
export function recoveryFor(ownerId: string): string {
  const claim = readClaim(ownerId);
  if (!claim) return JSON.stringify({ claimed: false, note: '本会话没有已保存的接管记录；没有连接、安装或操作游戏。' });
  const base = { claimed: true, runId: claim.runId ?? null, startedAt: claim.startedAt, options: claim.options ?? null,
    connection: driver ? owner === ownerId ? 'attached' : 'another_session_attached' : 'detached' };
  if (!claim.runId) return JSON.stringify({ ...base, checkpointEligible: false, reason: '旧版接管记录没有可恢复runId；保留原记录，不自动重领预算。' });
  try {
    const saved = inspectCheckpoint(stateDir(), claim.runId);
    if (claim.options && (claim.options.days !== saved.options.days || claim.options.goal !== saved.options.goal)) throw new Error('会话原预算与检查点不一致，不具备恢复条件。');
    // readCheckpoint is the same eligibility check used for an actual resume. Passing it
    // establishes disk eligibility only; the live save/build/control digest is checked later.
    let reason = '';
    try { readCheckpoint(stateDir(), claim.runId); } catch (error) { reason = error instanceof Error ? error.message : '检查点不可恢复。'; }
    return JSON.stringify({ ...base, checkpointEligible: !reason, reason: reason || undefined,
      checkpoint: { status: saved.status, savedAt: saved.savedAt, completedDays: saved.days.length, dayLimit: saved.options.days,
        submittedActionsToday: saved.writes, pendingAction: saved.pendingAction, stoppedBecause: saved.reason || undefined,
        gameVersion: saved.identity.gameVersion, gameAssemblyVersion: saved.identity.gameAssemblyVersion, gameBuildId: saved.identity.gameBuildId },
      note: '只是磁盘上的本会话历史，不是当前游戏现场。先停止旧连接，再显式game_resume；真实存档、构建、日期、控制摘要和原预算必须继续通过校验，敏感直播恢复仍需主人批准。没有自动重放。' });
  } catch (error) {
    return JSON.stringify({ ...base, checkpointEligible: false, reason: error instanceof Error ? error.message : '无法读取检查点。', note: '仅返回本会话已保存的runId；未读取其他会话的接管记录或自动重启任务。' });
  }
}

/** One game owner, one command in flight. Reject parallel tool calls instead of queuing stale actions. */
export async function useGame(ownerId: string, work: (game: GameDriver) => Promise<string>): Promise<string> {
  if (!driver) return '还没有接管游戏。请先调用 game_start(game="stardew")。';
  if (owner !== ownerId) return '星露谷正在由另一个 DSH 会话接管。请先在原会话停止。';
  if (busy) return '已有游戏操作正在执行，请等它返回结果后再决定下一步。';
  busy = true;
  const ticket = generation;
  try { return await work(driver); }
  finally { if (ticket === generation) busy = false; }
}

export async function startGame(ownerId: string, signal: AbortSignal, request: Partial<RunOptions> = {}, resumeRunId?: string): Promise<string> {
  if (completedOwners.has(ownerId)) return '这个会话已完成本次经营。请总结并结束；要开始新任务，由主人新建一个对话。';
  if (driver) {
    if (resumeRunId) return '当前已有游戏连接。先停止原连接，再显式恢复检查点。';
    return useGame(ownerId, game => game.observe(signal));
  }
  if (busy) return '正在连接游戏，请等当前调用结束。';
  const claim = claimPath(ownerId);
  const previous = readClaim(ownerId);
  if (previous && !resumeRunId) return `这个会话已有接管记录；只能显式恢复，不重置预算。\n${recoveryFor(ownerId)}`;
  if (previous && previous.runId !== resumeRunId) return '该会话领取过另一项经营任务；不能换一个runId绕过原来的预算。';
  const resume = resumeRunId ? readCheckpoint(stateDir(), resumeRunId) : undefined;
  if (previous?.options && resume && (previous.options.days !== resume.options.days || previous.options.goal !== resume.options.goal)) throw new Error('会话原预算与检查点不一致，未恢复或重新领取预算。');
  const options = resume?.options ?? runOptions(request);
  busy = true;
  const ticket = ++generation;
  const created = new StardewRun(settings(), join(stateDir(), 'runs'), options, resume, {
    character: () => {
      const memory = readCharacterMemory();
      // Only the actual game session's durable character binding supplies attribution.
      // Non-character/legacy sessions stay unbound; never adopt today's global default.
      return memory?.recordGameExperience ? memory.bindingFor?.(ownerId)?.profile.id ?? null : null;
    },
    publish: event => {
      const memory = readCharacterMemory();
      if (!memory?.recordGameExperience || !event.characterId) return 'unavailable';
      return memory.recordGameExperience(event.characterId, event);
    },
  });
  driver = created;
  owner = ownerId;
  try {
    const result = await created.start(signal);
    signal.throwIfAborted();
    if (driver !== created || ticket !== generation) throw new Error('本次连接已取消。');
    // Persist before returning control to the model, so a crash cannot reset the captured run budget.
    try {
      mkdirSync(join(stateDir(), 'sessions'), { recursive: true });
      if (!existsSync(claim)) writeFileSync(claim, JSON.stringify({
        startedAt: new Date().toISOString(), game: 'stardew', runId: created.runId, options,
      }), { flag: 'wx', mode: 0o600 });
    } catch {
      throw new Error('无法保存本次接管记录，未开始操作。请检查 DSH 数据目录，或核对旧会话记录后新建对话。');
    }
    return result;
  } catch (error) {
    if (driver === created) { driver = null; owner = null; }
    await created.stop();
    throw error;
  } finally { if (ticket === generation) busy = false; }
}

export async function stopGame(ownerId?: string): Promise<string> {
  if (ownerId && owner && ownerId !== owner) return '只能由接管这局游戏的会话停止。';
  if (stopping) return stopping;
  const previous = driver;
  if (previous?.finished && owner) completedOwners.add(owner);
  busy = true;
  const ticket = ++generation;
  stopping = (async () => {
    try {
      await previous?.stop();
      return '已关闭 AI 控制连接。游戏窗口仍然保留；停止接管不会暂停游戏时间。';
    } finally {
      if (ticket === generation) { driver = null; owner = null; busy = false; }
      stopping = null;
    }
  })();
  return stopping;
}

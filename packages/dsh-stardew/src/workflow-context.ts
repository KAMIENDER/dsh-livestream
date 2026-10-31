import type { ToolOutcome } from './mcp.js';
import type { Snapshot } from './persistence.js';
import type { MachineJobs } from './production.js';

export type ObjectValue = Record<string, any>;
export interface Position { locationId: string; x: number; y: number }
export interface WorkflowPort {
  readonly runId: string;
  readonly jobs?: MachineJobs;
  readonly previousWorkflow?: WorkflowReport;
  available(name: string): boolean;
  current(): Snapshot;
  remainingActions?(): number;
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  persistenceFailed?(): Promise<void>;
  uncertain?(reason: string): Promise<void>;
}
export interface WorkflowReport {
  id: string; workflow: string; startedAt: string; endedAt?: string;
  status: 'completed' | 'waiting' | 'stopped'; reason?: string;
  continuation?: { jobId: string; workflow: string; minutesUntilReady: number; position: Position };
  social?: { npcName: string; operation: 'talk' | 'gift' | 'deliver'; receipt: ObjectValue; dialogueSteps: number; originWorkflowId?: string };
  quest?: { operation: 'accepted' | 'money_claimed'; targetKey: string; receipt: ObjectValue };
  observed: { step: string; at: string; data: unknown }[];
  note: string;
}
export function requireFact(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export function object(value: unknown): value is ObjectValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** V1 InventorySlot.item is optional: the installed Python projection omits it for
 * empty slots. Only a complete, explicitly indexed capture can establish emptiness;
 * never fill missing slots or turn an incomplete inventory into an empty one. */
export function completeInventory(value: unknown): ObjectValue {
  requireFact(object(value) && /^[a-f0-9]{64}$/.test(value.inventoryRevision) && Number.isSafeInteger(value.slotCount)
    && value.slotCount >= 0 && value.slotCount <= 16384 && Array.isArray(value.slots) && value.slots.length === value.slotCount, '库存完整槽位/数量/版本不明确。');
  const seen = new Set<number>();
  const slots = value.slots.map((slot: unknown) => {
    requireFact(object(slot) && Number.isSafeInteger(slot.index) && slot.index >= 0 && slot.index < value.slotCount && !seen.has(slot.index), '库存槽位索引缺失、重复或越界。');
    seen.add(slot.index);
    requireFact(slot.item === undefined || slot.item === null || object(slot.item), '库存物品字段无效。');
    return { ...slot, item: slot.item ?? null };
  }).sort((a: ObjectValue, b: ObjectValue) => a.index - b.index);
  return { ...value, slots };
}
export function positionOf(value: unknown): Position {
  requireFact(object(value) && typeof value.locationId === 'string' && value.locationId.length > 0 && value.locationId.length <= 128
    && !value.locationId.includes('\0') && Number.isInteger(value.x) && Number.isInteger(value.y)
    && value.x >= 0 && value.y >= 0 && value.x <= 10000 && value.y <= 10000, '位置必须来自实际地图查询。');
  return { locationId: value.locationId, x: value.x, y: value.y };
}
export function samePosition(left: Position | undefined, right: Position): boolean {
  return left?.locationId === right.locationId && left?.x === right.x && left?.y === right.y;
}
export function record(report: WorkflowReport, step: string, data: unknown): void {
  report.observed.push({ step, at: new Date().toISOString(), data });
}
export class WorkflowStepError extends Error {
  constructor(readonly tool: string, readonly result: ToolOutcome) {
    super(`${tool}未完成：${result.error?.code ?? result.status}。${result.error?.message ?? ''}没有自动重放。`);
  }
}

/** Only a port supplied by StardewRun can submit a step; no scripts or caller-selected tools. */
export class WorkflowIO {
  constructor(readonly port: WorkflowPort, readonly report: WorkflowReport) {}
  observed(step: string, data: unknown): void { record(this.report, step, data); }
  async uncertain(message: string): Promise<never> {
    await this.port.uncertain?.(message);
    throw new Error(`${message} 已停止后续变更，不重放。`);
  }
  needs(names: readonly string[]): void {
    const missing = names.filter(name => !this.port.available(name));
    requireFact(!missing.length, `缺少流程接口：${missing.join('、')}。没有执行本流程游戏变更。`);
  }
  ready(locationId?: string): void {
    const current = this.port.current();
    requireFact(current.player.canMove && !current.ui.menuOpen, '当前有菜单、事件或主角不可操作，流程停止。');
    requireFact(!locationId || current.player.position.locationId === locationId, '主角已不在目标地点，未追随旧坐标。');
    requireFact(current.timeOfDay < 2200 && current.player.energy >= 30 && current.player.health >= 20, '已到收尾条件，停止新的工作并准备睡觉。');
  }
  async call(name: string, args: Record<string, unknown>): Promise<ObjectValue> {
    const result = await this.port.call(name, args);
    if (result.status !== 'succeeded' || !object(result.output)) {
      this.observed('step_not_confirmed', { tool: name, status: result.status, error: result.error, reason: result.output?.reason });
      throw new WorkflowStepError(name, result);
    }
    return result.output;
  }
  async inventory(): Promise<ObjectValue> {
    const snapshot = (await this.call('stardew_query_inventory', { playerInventory: {}, includeEmptySlots: true })).snapshot;
    return completeInventory(snapshot);
  }
  count(inventory: ObjectValue, id: string, quality?: number): number {
    return inventory.slots.reduce((sum: number, slot: ObjectValue) => {
      if (slot.item?.qualifiedItemId !== id || quality !== undefined && slot.item.quality !== quality) return sum;
      requireFact(Number.isSafeInteger(slot.item.stack) && slot.item.stack >= 0, '物品数量未知。');
      return sum + slot.item.stack;
    }, 0);
  }
}

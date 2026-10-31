import { object, requireFact, type ObjectValue } from '../workflow-context.js';

const whole = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const countKey = (id: string, quality: number) => JSON.stringify([id, quality]);
export function inventoryTotals(inventory: ObjectValue): Map<string, number> {
  requireFact(Array.isArray(inventory.slots), '背包缺少完整槽位。');
  const result = new Map<string, number>();
  for (const slot of inventory.slots) {
    if (slot.item === undefined || slot.item === null) continue;
    const item = slot.item;
    requireFact(object(item) && typeof item.qualifiedItemId === 'string' && whole(item.stack, 0, 10000) && whole(item.quality ?? 0, 0, 4), '物品数量/品质不明确。');
    const key = countKey(item.qualifiedItemId, item.quality ?? 0);
    result.set(key, (result.get(key) ?? 0) + item.stack);
  }
  return result;
}
/** Independently compare the native ID/quality quantity capture with the complete
 * MCP inventory; no refs, missing rows or display names substitute for quantities. */
export function verifyNativeInventory(inventory: ObjectValue, rows: unknown): void {
  requireFact(Array.isArray(rows) && rows.length <= 16384, '缺少原生库存数量。');
  const native = new Map<string, number>();
  for (const row of rows) {
    requireFact(object(row) && typeof row.itemId === 'string' && /^\([A-Za-z]+\)[^\s\x00-\x1f]{1,128}$/.test(row.itemId)
      && whole(row.quality, 0, 4) && whole(row.amount, 0, 200000000), '原生数量字段无效。');
    const key = countKey(row.itemId, row.quality); requireFact(!native.has(key), '原生数量键重复。'); native.set(key, row.amount);
  }
  const mcp = inventoryTotals(inventory);
  requireFact([...new Set([...native.keys(), ...mcp.keys()])].every(key => (native.get(key) ?? 0) === (mcp.get(key) ?? 0)), 'Native数量与MCP完整库存不一致。');
}
export function inventoryDelta(before: ObjectValue, after: ObjectValue): Map<string, number> {
  const left = inventoryTotals(before), right = inventoryTotals(after), changes = new Map<string, number>();
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const amount = (right.get(key) ?? 0) - (left.get(key) ?? 0);
    if (amount) changes.set(key, amount);
  }
  return changes;
}
/** Compare every occupied MCP item/quality total against the separate native receipt. */
export function verifyInventoryChanges(before: ObjectValue, after: ObjectValue, changes: unknown): void {
  requireFact(Array.isArray(changes), '原生收据缺少背包增减。');
  const actual = inventoryDelta(before, after), expected = new Map<string, number>();
  for (const change of changes) {
    requireFact(object(change) && typeof change.itemId === 'string' && whole(change.quality, 0, 4) && Number.isSafeInteger(change.amount) && change.amount !== 0, '原生物品增减收据无效。');
    const key = countKey(change.itemId, change.quality);
    requireFact(!expected.has(key), '原生收据重复物品品质键。'); expected.set(key, change.amount);
  }
  requireFact(actual.size === expected.size && [...actual].every(([key, amount]) => expected.get(key) === amount), '独立MCP背包增减与原生收据不一致。');
}

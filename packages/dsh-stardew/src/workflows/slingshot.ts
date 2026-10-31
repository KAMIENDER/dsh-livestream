import { object, positionOf, requireFact, samePosition, type ObjectValue, type WorkflowIO } from '../workflow-context.js';
import { inventoryTotals, verifyInventoryChanges, verifyNativeInventory } from './inventory-receipt.js';

const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^\([A-Za-z]+\)[^\s\x00-\x1f]{1,128}$/.test(v);
const sameAmmo = (a: ObjectValue, b: ObjectValue) => a.itemId === b.itemId && a.quality === b.quality && a.stack === b.stack && a.itemKey === b.itemKey;
const ammo = (v: unknown): v is ObjectValue => object(v) && int(v.quality, 0, 4) && int(v.stack, 0, 10000)
  && (v.itemId === null ? v.stack === 0 && v.quality === 0 && v.itemKey === null && v.baseDamage === null
    : id(v.itemId) && v.stack > 0 && key(v.itemKey) && int(v.baseDamage, 1, 1000000))
  && v.explosive === (v.itemId === '(O)441');
export { ammo as validSlingshotAmmo, sameAmmo as sameSlingshotAmmo };
export const SLINGSHOT_AMMO_WORKFLOW = {
  name: 'slingshot_ammo', title: '原生弹弓装弹、合并、替换与整堆卸下', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_slingshot', 'dsh_slingshot_ammo', 'stardew_query_inventory'],
  parameters: { type: 'object', additionalProperties: false, required: ['operation', 'slingshotSlot', 'expectedSlingshotItemId', 'toolKey', 'expectedAmmo', 'inventorySlot', 'itemId', 'quality', 'maxCount'], properties: {
    operation: { type: 'string', enum: ['attach', 'detach'] }, slingshotSlot: { type: 'integer', minimum: 0, maximum: 255 }, expectedSlingshotItemId: { type: 'string' }, toolKey: { type: 'string' },
    expectedAmmo: { type: 'object', additionalProperties: false, required: ['itemId', 'quality', 'stack'], properties: {
      itemId: { type: ['string', 'null'] }, quality: { type: 'integer', minimum: 0, maximum: 4 }, stack: { type: 'integer', minimum: 0, maximum: 10000 },
    } },
    inventorySlot: { type: 'integer', minimum: 0, maximum: 255, description: 'attach的实际整堆来源；detach的真实空目的槽' },
    itemId: { type: 'string' }, quality: { type: 'integer', minimum: 0, maximum: 4 }, maxCount: { type: 'integer', minimum: 1, maximum: 10000 },
    allowExplosive: { type: 'boolean', default: false },
  } },
  scope: '一次实际拥有原生弹弓的装卸弹；源整堆不超过上限，过大先明确分拆。原生attach自行合并、留余量或替换，detach只卸整堆；不自行生成弹药，不在此处发射。未知/自定义/任务物品、全捕获超限、满包恢复空间不足或活动工具状态不提交。',
  postconditions: ['真实工具实例与原弹药ID/品质/数量匹配，新MCP背包和Native完整数量一致', '原生一次操作，实际装入/卸下数量和真实返回物归属确认，完整背包与全工具附件总量守恒', '其他工具附件不变，地点/资源与新快照核对；未知停止接管不重放', '只确认弹药移动，不冒充发射、命中、击杀或爆炸；仍需专用射击生命周期'],
};

interface Frame { query: ObjectValue; state: ObjectValue; sling: ObjectValue; inventory: ObjectValue; attached: ObjectValue[] }
function totals(f: Frame): Map<string, number> {
  const values = inventoryTotals(f.inventory);
  for (const a of f.attached) {
    if (a.itemId === null) continue;
    const k = JSON.stringify([a.itemId, a.quality]); values.set(k, (values.get(k) ?? 0) + a.stack);
  }
  return values;
}
export async function slingshotAmmo(args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  requireFact(object(args) && Object.keys(args).every(k => ['operation', 'slingshotSlot', 'expectedSlingshotItemId', 'toolKey', 'expectedAmmo', 'inventorySlot', 'itemId', 'quality', 'maxCount', 'allowExplosive'].includes(k))
    && ['attach', 'detach'].includes(args.operation) && int(args.slingshotSlot, 0, 255) && id(args.expectedSlingshotItemId) && key(args.toolKey)
    && int(args.inventorySlot, 0, 255) && args.inventorySlot !== args.slingshotSlot && id(args.itemId) && int(args.quality, 0, 4) && int(args.maxCount, 1, 10000)
    && (args.allowExplosive === undefined || typeof args.allowExplosive === 'boolean') && object(args.expectedAmmo)
    && Object.keys(args.expectedAmmo).every(k => ['itemId', 'quality', 'stack'].includes(k)) && int(args.expectedAmmo.quality, 0, 4)
    && (args.expectedAmmo.itemId === null ? args.expectedAmmo.quality === 0 && args.expectedAmmo.stack === 0 : id(args.expectedAmmo.itemId) && int(args.expectedAmmo.stack, 1, 10000)),
  'slingshot_ammo需要真实工具实例、现有弹药和准确来源/空目的槽、物品/品质/数量上限。');
  io.needs(SLINGSHOT_AMMO_WORKFLOW.requiredTools); io.ready();
  const start = io.port.current().player.position;
  const read = async (): Promise<Frame> => {
    const first = await io.call('dsh_query_slingshot', {}), inventory = await io.inventory(), q = await io.call('dsh_query_slingshot', {});
    requireFact(first.available === true && object(first.state) && q.available === true && q.complete === true && object(q.state)
      && first.state.locationKey === q.state.locationKey && first.state.inventoryDigest === q.state.inventoryDigest
      && first.attachmentSetDigest === q.attachmentSetDigest && sha(q.attachmentSetDigest) && sha(q.state.inventoryDigest)
      && q.state.canMove === true && q.state.menuType === null && q.state.eventUp === false && q.state.fading === false
      && q.usingSlingshot === false && q.usingTool === false && typeof q.legacyFiring === 'boolean'
      && Array.isArray(q.slingshots) && q.slingshots.length <= 256 && Array.isArray(q.attachments) && q.attachments.length <= 4096
      && Array.isArray(q.eligibleInventoryAmmo) && q.eligibleInventoryAmmo.length <= 256, '原生弹弓/完整附件/空闲状态不可用或在读取期间改变。');
    const s = q.state, player = io.port.current().player;
    requireFact(key(s.locationKey) && samePosition(player.position, start) && samePosition(positionOf(s.position), start)
      && player.health === s.health && Number.isFinite(s.energy) && Math.abs(player.energy - s.energy) <= 0.001
      && player.money === String(s.money) && int(s.money, 0, 2147483647), '独立主角资源或位置与原生读取不一致。');
    verifyNativeInventory(inventory, s.inventoryCounts);
    const attached = q.attachments as ObjectValue[];
    requireFact(attached.every(a => object(a) && int(a.toolSlot, 0, 255) && key(a.toolKey) && int(a.index, 0, 15) && int(a.quality, 0, 4)
      && (a.itemId === null ? a.stack === 0 && a.quality === 0 && a.itemKey === null : id(a.itemId) && int(a.stack, 1, 10000) && key(a.itemKey)))
      && new Set(attached.map(a => `${a.toolSlot}:${a.index}`)).size === attached.length, '完整工具附件行缺失、重复或数量无效。');
    const sling = q.slingshots.find((s: ObjectValue) => s.slot === args.slingshotSlot), item = inventory.slots.find((s: ObjectValue) => s.index === args.slingshotSlot)?.item;
    requireFact(object(sling) && sling.toolKey === args.toolKey && sling.itemId === args.expectedSlingshotItemId && sha(sling.gearDigest)
      && sling.attachmentSlots === 1 && sling.nativeEnchantmentsOnly === true && sling.canAutoFire === false && ammo(sling.ammo)
      && item?.qualifiedItemId === sling.itemId && item.tool === true
      && attached.some(a => a.toolSlot === args.slingshotSlot && a.toolKey === args.toolKey && a.index === 0
        && a.itemId === sling.ammo.itemId && a.quality === sling.ammo.quality && a.stack === sling.ammo.stack), '实际原生弹弓、单弹药槽或独立背包工具不同。');
    return { query: q, state: s, sling, inventory, attached };
  };
  const before = await read(), existing = before.sling.ammo, expected = args.expectedAmmo;
  requireFact(existing.itemId === expected.itemId && existing.quality === expected.quality && existing.stack === expected.stack, '现有弹药配置已变，未把批准套到另一配置。');
  const slot = before.inventory.slots.find((s: ObjectValue) => s.index === args.inventorySlot);
  requireFact(slot, '没有完整来源/目的槽。');
  let sourceKey: string | undefined;
  if (args.operation === 'attach') {
    const candidate = before.query.eligibleInventoryAmmo.find((a: ObjectValue) => a.inventorySlot === args.inventorySlot);
    requireFact(slot.item?.qualifiedItemId === args.itemId && slot.item.quality === args.quality && int(slot.item.stack, 1, args.maxCount)
      && object(candidate) && key(candidate.itemKey) && candidate.itemId === args.itemId && candidate.quality === args.quality && candidate.stack === slot.item.stack,
    '实际完整弹药来源不符或超过上限；先明确分拆，未自动消费别的堆叠。');
    sourceKey = candidate.itemKey;
    requireFact(args.itemId !== '(O)441' || args.allowExplosive === true, '装入爆炸弹需要明确许可。');
    requireFact(existing.itemId === null || before.inventory.slots.some((s: ObjectValue) => s.item === null), '替换/合并已有弹药前需保留真实空恢复槽。');
  } else requireFact(slot.item === null && existing.itemId === args.itemId && existing.quality === args.quality && int(existing.stack, 1, args.maxCount), '卸下必须是准确整堆及真实空目的槽。');
  io.observed('slingshot_ammo_preflight', { operation: args.operation, slingshotItemId: args.expectedSlingshotItemId, beforeAmmo: existing,
    itemId: args.itemId, quality: args.quality, maxCount: args.maxCount, allowExplosive: args.allowExplosive === true });
  const r = await io.call('dsh_slingshot_ammo', { operation: args.operation, slingshotSlot: args.slingshotSlot, expectedSlingshotItemId: args.expectedSlingshotItemId,
    toolKey: args.toolKey, gearDigest: before.sling.gearDigest, inventoryDigest: before.state.inventoryDigest, attachmentSetDigest: before.query.attachmentSetDigest,
    inventorySlot: args.inventorySlot, ...(sourceKey ? { sourceItemKey: sourceKey } : {}),
    expectedItemId: args.itemId, expectedQuality: args.quality, maxCount: args.maxCount, allowExplosive: args.allowExplosive === true });
  io.observed('slingshot_ammo_native_receipt', r);
  try {
    requireFact(r.nativeActionReturned === true && r.operation === args.operation && r.toolKey === args.toolKey && r.slingshotSlot === args.slingshotSlot
      && r.inventorySlot === args.inventorySlot && r.conservedQuantity === true && ammo(r.beforeAmmo) && ammo(r.afterAmmo) && sameAmmo(existing, r.beforeAmmo)
      && int(r.loadedCount, 0, args.maxCount) && int(r.detachedCount, 0, args.maxCount), '原生弹药转移和守恒收据不完整。');
    const after = await read(); io.ready(start.locationId);
    requireFact(after.state.locationKey === before.state.locationKey && r.after?.locationKey === before.state.locationKey
      && r.before?.inventoryDigest === before.state.inventoryDigest && r.after.inventoryDigest === after.state.inventoryDigest && sameAmmo(after.sling.ammo, r.afterAmmo)
      && after.state.money === before.state.money && r.before.money === before.state.money && r.after.money === after.state.money
      && r.after.health === after.state.health && Math.abs(r.after.energy - after.state.energy) <= 0.001, '独立位置/背包/弹药/资源未与原生结果匹配。');
    verifyInventoryChanges(before.inventory, after.inventory, r.inventoryChanges);
    const left = totals(before), right = totals(after);
    requireFact(left.size === right.size && [...left].every(([k, v]) => right.get(k) === v)
      && JSON.stringify(before.attached.filter(a => a.toolSlot !== args.slingshotSlot)) === JSON.stringify(after.attached.filter(a => a.toolSlot !== args.slingshotSlot)), '新MCP全背包与完整工具附件不守恒或其他附件改变。');
    if (r.completedWorkflow !== true) {
      requireFact(r.completionUncertain === false && sameAmmo(existing, after.sling.ammo) && r.loadedCount === 0 && r.detachedCount === 0, '没有确认成功，也未证明原生零变化。');
      io.observed('slingshot_ammo_unchanged', { operation: args.operation }); return 'waiting';
    }
    requireFact(r.completionUncertain === false && (args.operation === 'attach' ? r.loadedCount > 0 && r.detachedCount === 0
      && r.afterAmmo.itemId === args.itemId && r.afterAmmo.quality === args.quality : r.loadedCount === 0 && r.detachedCount === existing.stack && r.afterAmmo.itemId === null), '实际装入/卸下数量或最终配置不符合所请求操作。');
    if (args.operation === 'attach') {
      // Native attach merges into the old reference or moves the exact held
      // source reference. Quantity totals alone cannot prove that distinction,
      // especially for equal-ID/quality objects with different native metadata.
      requireFact(r.afterAmmo.itemKey === existing.itemKey ? r.loadedCount === r.afterAmmo.stack - existing.stack
        : r.afterAmmo.itemKey === sourceKey && r.loadedCount === slot.item.stack && r.afterAmmo.stack === slot.item.stack,
      '合并增量或原来源实例的完整移动没有同时确认。');
    } else {
      const destination = after.inventory.slots.find((s: ObjectValue) => s.index === args.inventorySlot)?.item;
      requireFact(destination?.qualifiedItemId === existing.itemId && destination.quality === existing.quality && destination.stack === existing.stack,
        '卸下整堆未在明确背包目的槽完整出现。');
    }
    io.observed('slingshot_ammo_verified', { operation: args.operation, slingshotItemId: args.expectedSlingshotItemId, itemId: args.itemId, quality: args.quality,
      loadedCount: r.loadedCount, detachedCount: r.detachedCount, beforeAmmo: r.beforeAmmo, afterAmmo: r.afterAmmo,
      conservedQuantity: true, ammunitionFired: false, hitOrKillProven: false });
    return 'completed';
  } catch { return io.uncertain('装卸弹已返回，但独立库存/附件/资源未完整确认；可能已移动物品，不重放。'); }
}

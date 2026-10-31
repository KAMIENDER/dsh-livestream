import { object, positionOf, requireFact, samePosition, WorkflowIO, type ObjectValue } from '../workflow-context.js';
import { inventoryTotals, verifyInventoryChanges, verifyNativeInventory } from './inventory-receipt.js';

const position = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: {
  locationId: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' },
} };
export const SHIPPING_WORKFLOW = {
  name: 'shipping_batch', title: '实际出货待结算放入、迷你箱取出与大箱最后批次取回', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_shipping', 'dsh_shipping', 'stardew_query_inventory', 'stardew_navigate'],
  parameters: { type: 'object', additionalProperties: false, required: ['position', 'targetKey', 'expectedKind', 'expectedTypeId', 'moves'], properties: {
    position, targetKey: { type: 'string' }, expectedKind: { type: 'string', enum: ['big_bin', 'mini_bin'] }, expectedTypeId: { type: 'string' },
    entry: { type: 'string', enum: ['current', 'position'], default: 'current' }, menuKey: { type: 'string', description: 'current入口必须固定当前真实Native菜单实例；重开/重载失效' },
    closeAfter: { type: 'boolean', default: true }, moves: { type: 'array', minItems: 1, maxItems: 16, items: {
      type: 'object', additionalProperties: false, required: ['operation', 'itemId', 'quality', 'quantity'], properties: {
        operation: { type: 'string', enum: ['deposit', 'withdraw', 'retrieve_last'] }, itemId: { type: 'string' }, quality: { type: 'integer', minimum: 0, maximum: 4 },
        quantity: { type: 'integer', minimum: 1, maximum: 10000 }, sourceSlot: { type: 'integer', minimum: 0, maximum: 16383 },
        expectedItemKey: { type: 'string', description: '可额外固定真实Native源物品实例，不替换旧key；不是MCP Ref' },
        expectedItemRef: { type: 'string', description: '仅deposit可额外固定MCP背包物品Ref；不能用于Native出货侧' },
      },
    } },
  } },
  scope: '准确已建原生大出货建筑/迷你出货箱；1–16步明确ID/品质/数量。整堆正常左键，部分每tick右键1份（≤999）且原生左Shift未按。大箱部分放入产生多个单份批次，只能取回整个实际最后批次；迷你箱按当前槽存取。只确认待结算移动，不当作金币到账/统计已结算。',
  postconditions: ['实际目标实例/类型/位置、真实回调/空游标/后备库存与菜单绑定，查询不创建个人钱包库存',
    '每步新完整MCP背包与Native待结算侧数量精确相反，金币不变；不是伪造MCP容器Ref',
    '迷你箱自身回调导致的菜单替换/槽压缩只跟踪原实例，大箱最后批次的数量/成员与取回后清空核对',
    '原日动作预留与正常关闭，未知/部分失败停止不重做；专用物品、全夜结算归因与持久恢复仍待适配'],
};
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const qualified = (v: unknown): v is string => typeof v === 'string' && /^\([A-Za-z]+\)[^\s\x00-\x1f]{1,128}$/.test(v);
const opaque = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\x00-\x1f]/.test(v);
function nativePending(value: unknown): ObjectValue {
  requireFact(object(value) && sha(value.digest) && typeof value.backingExists === 'boolean' && whole(value.slotCount, 0, 16384)
    && Array.isArray(value.slots) && value.slots.length === value.slotCount, '缺少完整Native待结算库存。');
  value.slots.forEach((slot: unknown, index: number) => requireFact(object(slot) && slot.index === index && (slot.item === null
    || object(slot.item) && key(slot.item.itemKey) && qualified(slot.item.qualifiedItemId) && whole(slot.item.quality, 0, 4) && whole(slot.item.stack, 1, 10000)
      && typeof slot.item.eligible === 'boolean'), 'Native待结算槽位/实例/数量不完整。'));
  if (value.backingExists) { requireFact(key(value.backingKey), '缺少实际后备库存实例。'); verifyNativeInventory(value, value.counts); }
  else requireFact(value.backingKey === null && value.counts === null && value.slots.every((s: ObjectValue) => s.item === null), '未创建的钱包不能冒充已读空库存。');
  return value;
}
interface Frame { query: ObjectValue; target: ObjectValue; pending: ObjectValue; inventory: ObjectValue }

export async function shippingBatch(args: unknown, io: WorkflowIO): Promise<'completed'> {
  requireFact(object(args) && Object.keys(args).every(k => ['position', 'targetKey', 'expectedKind', 'expectedTypeId', 'entry', 'menuKey', 'closeAfter', 'moves'].includes(k))
    && key(args.targetKey) && ['big_bin', 'mini_bin'].includes(args.expectedKind) && typeof args.expectedTypeId === 'string' && args.expectedTypeId.length > 0
    && args.expectedTypeId.length <= 160 && !/[\x00-\x1f]/.test(args.expectedTypeId), '需要实际出货目标、准确类型/数据ID与实例key。');
  const targetPosition = positionOf(args.position), entry = args.entry ?? 'current', closeAfter = args.closeAfter ?? true;
  requireFact(['current', 'position'].includes(entry) && typeof closeAfter === 'boolean' && (entry === 'current' ? key(args.menuKey) : args.menuKey === undefined)
    && Array.isArray(args.moves) && args.moves.length >= 1 && args.moves.length <= 16, '入口、准确菜单实例或批次数量无效。');
  const moves = args.moves.map((m: unknown) => {
    requireFact(object(m) && Object.keys(m).every(k => ['operation', 'itemId', 'quality', 'quantity', 'sourceSlot', 'expectedItemKey', 'expectedItemRef'].includes(k))
      && ['deposit', 'withdraw', 'retrieve_last'].includes(m.operation) && qualified(m.itemId) && whole(m.quality, 0, 4) && whole(m.quantity, 1, 10000)
      && (m.expectedItemKey === undefined || key(m.expectedItemKey)) && (m.expectedItemRef === undefined || m.operation === 'deposit' && opaque(m.expectedItemRef))
      && (m.operation === 'retrieve_last' ? args.expectedKind === 'big_bin' && m.sourceSlot === undefined : whole(m.sourceSlot, 0, 16383))
      && (m.operation !== 'withdraw' || args.expectedKind === 'mini_bin'), '每步需要准确操作/ID/品质/数量与来源；大箱不能任意取旧批次。');
    return m;
  });
  io.needs(SHIPPING_WORKFLOW.requiredTools);
  requireFact(io.port.current().player.position.locationId === targetPosition.locationId, '出货流程不跨地图追旧箱子。');
  const enough = (n: number) => requireFact(whole(io.port.remainingActions?.(), n, 128), '原日剩余动作不足以完成出货批次及关闭。');
  enough(moves.length + (closeAfter ? 1 : 0) + (entry === 'position' ? 2 : 0));
  let menuKey: string | undefined = entry === 'current' ? args.menuKey : undefined;
  const query = async (): Promise<{ query: ObjectValue; target: ObjectValue; pending: ObjectValue }> => {
    const q = await io.call('dsh_query_shipping', { position: targetPosition, offset: 0, limit: 1 });
    requireFact(q.supportedBuild === true && q.queuedOnlyNotSettled === true && sha(q.revision) && whole(q.gold, 0, 2147483647)
      && Array.isArray(q.items) && q.count === 1 && q.items.length === 1 && q.nextOffset === null, '目标/构建或真实出货事实不完整。');
    const t = q.items[0];
    requireFact(object(t) && t.targetKey === args.targetKey && samePosition(t.position, targetPosition) && t.kind === args.expectedKind && t.typeId === args.expectedTypeId
      && t.compatible === true && sha(t.targetDigest), '实际出货实例、位置/类型或已核对语义改变。');
    return { query: q, target: t, pending: nativePending(t.pending) };
  };
  const frame = async (expectedMenu = menuKey, world = false): Promise<Frame> => {
    const before = await query(), inventory = await io.inventory(), after = await query();
    requireFact(before.query.revision === after.query.revision && String(after.query.gold) === io.port.current().player.money, '读取出货/背包时现场改变或金币两路不一致。');
    verifyNativeInventory(inventory, after.query.player);
    if (!world) requireFact(after.pending.backingExists === true && object(after.query.current) && after.query.current.targetKey === args.targetKey
      && key(after.query.current.menuKey) && (!expectedMenu || after.query.current.menuKey === expectedMenu) && after.query.current.held === null
      && after.query.current.pendingBackingKey === after.pending.backingKey, '没有该箱子的准确空游标/回调/后备库存菜单。');
    return { ...after, inventory };
  };
  const nativeStep = async (operation: string, before: Frame, extra: ObjectValue = {}) => {
    const result = await io.call('dsh_shipping', { operation, position: targetPosition, targetKey: args.targetKey, targetDigest: before.target.targetDigest,
      revision: before.query.revision, ...(operation === 'open' ? {} : { menuKey }), ...extra });
    io.observed('shipping_native_receipt', result); return result;
  };
  if (entry === 'position') {
    io.ready(targetPosition.locationId); await io.call('stardew_navigate', { position: targetPosition, arrival: 'adjacent' }); io.ready(targetPosition.locationId);
    const before = await frame(undefined, true);
    requireFact(before.query.menuType === null && before.target.adjacent === true && before.target.clear === true, '目标不相邻/被阻挡或已有菜单。');
    const result = await nativeStep('open', before);
    try {
      requireFact(result.completedWorkflow === true && result.operation === 'open' && result.targetKey === args.targetKey && key(result.menuKey), '原生开出货箱未确认。');
      const after = await frame(result.menuKey); verifyInventoryChanges(before.inventory, after.inventory, []);
      if (before.pending.backingExists) requireFact(before.pending.digest === after.pending.digest, '打开改变了已存在待结算库存。');
      else requireFact(args.expectedKind === 'mini_bin' && result.createdBacking === true && inventoryTotals(after.pending).size === 0, '新个人钱包没有正常创建为空的证据。');
      requireFact(before.query.gold === after.query.gold, '开箱改变了金币。'); menuKey = result.menuKey;
    } catch { return io.uncertain('原生出货开箱、双侧数量或新钱包建立未确认。'); }
  }
  let latest = await frame();
  for (let index = 0; index < moves.length; index++) {
    enough(moves.length - index + (closeAfter ? 1 : 0));
    const m = moves[index], before = await frame(); let source: ObjectValue;
    if (m.operation === 'deposit') {
      const actual = before.inventory.slots[m.sourceSlot]?.item;
      const sources = before.query.playerSlots?.filter((s: ObjectValue) => s.index === m.sourceSlot);
      requireFact(object(actual) && actual.qualifiedItemId === m.itemId && actual.quality === m.quality && actual.tool !== true && whole(actual.stack, m.quantity, 10000)
        && (m.expectedItemRef === undefined || actual.ref?.value === m.expectedItemRef) && Array.isArray(sources) && sources.length === 1
        && object(sources[0].item) && sources[0].item.stack === actual.stack, '实际背包源槽、数量或指定MCP Ref改变。');
      source = sources[0].item;
    } else if (m.operation === 'withdraw') source = before.pending.slots[m.sourceSlot]?.item;
    else {
      source = before.pending.last;
      requireFact(whole(before.pending.lastSlot, 0, before.pending.slotCount - 1) && before.pending.slots[before.pending.lastSlot].item?.itemKey === source?.itemKey
        && source?.stack === m.quantity, '只能取回实际仍在本库存中的整个最后批次，不会递归取更早批次。');
    }
    requireFact(object(source) && source.qualifiedItemId === m.itemId && source.quality === m.quality && source.eligible === true && key(source.itemKey)
      && whole(source.stack, m.quantity, 10000) && (m.expectedItemKey === undefined || source.itemKey === m.expectedItemKey)
      && (m.quantity === source.stack || m.quantity <= 999), '准确可出货源、品质、实例或数量不符合批准；没有换另一堆物品。');
    const result = await nativeStep(m.operation, before, { ...(m.operation === 'retrieve_last' ? {} : { sourceSlot: m.sourceSlot }), itemKey: source.itemKey,
      expectedItemId: m.itemId, expectedQuality: m.quality, quantity: m.quantity });
    try {
      requireFact(result.completedWorkflow === true && result.operation === m.operation && result.targetKey === args.targetKey && result.kind === args.expectedKind
        && result.itemId === m.itemId && result.quality === m.quality && result.quantity === m.quantity && result.queuedOnlyNotSettled === true && key(result.menuKey), '原生出货移动收据不一致。');
      latest = await frame(result.menuKey);
      const sign = m.operation === 'deposit' ? -1 : 1, change = { itemId: m.itemId, quality: m.quality, amount: sign * m.quantity };
      verifyInventoryChanges(before.inventory, latest.inventory, [change]); verifyInventoryChanges(before.inventory, latest.inventory, result.inventoryChanges);
      verifyInventoryChanges(before.pending, latest.pending, [{ ...change, amount: -change.amount }]);
      requireFact(latest.pending.backingKey === before.pending.backingKey && result.pending?.digest === latest.pending.digest
        && result.beforeGold === before.query.gold && result.afterGold === latest.query.gold && latest.query.gold === before.query.gold, '出货后后备库存、待结算快照或金币不一致。');
      if (args.expectedKind === 'big_bin') {
        if (m.operation === 'retrieve_last') requireFact(latest.pending.last === null && latest.pending.lastSlot === null, '原生取回后没有清空最后批次引用。');
        else requireFact(latest.pending.last?.qualifiedItemId === m.itemId && latest.pending.last?.quality === m.quality
          && latest.pending.last?.stack === (m.quantity === source.stack ? m.quantity : 1)
          && whole(latest.pending.lastSlot, 0, latest.pending.slotCount - 1)
          && latest.pending.slots[latest.pending.lastSlot].item?.itemKey === latest.pending.last?.itemKey, '原生最后批次的实际数量/成员未确认。');
      }
      menuKey = result.menuKey;
      io.observed('shipping_movement_verified', { position: targetPosition, kind: args.expectedKind, operation: m.operation, itemId: m.itemId,
        quality: m.quality, quantity: m.quantity, lastBatchQuantity: args.expectedKind === 'big_bin' ? latest.pending.last?.stack ?? 0 : null,
        queuedOnlyNotSettled: true, moneyUnchanged: true });
    } catch { return io.uncertain('出货后的MCP背包、Native待结算侧/最后批次或金币未确认；可能已有部分移动，不重做。'); }
  }
  if (closeAfter) {
    const result = await nativeStep('close', latest);
    try {
      const after = await frame(undefined, true); verifyInventoryChanges(latest.inventory, after.inventory, []);
      requireFact(result.completedWorkflow === true && result.operation === 'close' && result.targetKey === args.targetKey && after.pending.digest === latest.pending.digest
        && after.query.gold === latest.query.gold && after.query.current === null && after.query.menuType === null && (args.expectedKind !== 'mini_bin' || after.target.lockHeld === false)
        && io.port.current().player.canMove && !io.port.current().ui.menuOpen,
        '关闭后的准确空闲世界、双侧库存或金币未确认。');
    } catch { return io.uncertain('出货关闭后的独立状态未确认，已完成移动不重做。'); }
  }
  io.observed('shipping_batch_completed', { position: targetPosition, kind: args.expectedKind, moves: moves.length, closed: closeAfter, queuedOnlyNotSettled: true });
  return 'completed';
}

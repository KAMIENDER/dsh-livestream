import { completeInventory, object, positionOf, requireFact, samePosition, WorkflowIO, type ObjectValue } from '../workflow-context.js';
import { inventoryDelta, verifyInventoryChanges, verifyNativeInventory as nativeCounts } from './inventory-receipt.js';

const position = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: {
  locationId: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' },
} };
export const STORAGE_WORKFLOW = {
  name: 'storage_transfer', title: '准确普通箱/大箱/主冰箱双侧守恒储物批次', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_storage', 'dsh_storage_ui', 'stardew_query_ui', 'stardew_query_inventory', 'stardew_transfer_inventory_item', 'stardew_navigate'],
  parameters: { type: 'object', additionalProperties: false, required: ['position', 'targetKey', 'expectedContainerKind', 'expectedContainerItemId', 'moves'], properties: {
    position, targetKey: { type: 'string', description: 'dsh_query_storage返回的当前存活箱子实例key，重载后失效；不是MCP containerRef' },
    expectedContainerKind: { type: 'string', enum: ['chest', 'big_chest', 'fridge'] }, expectedContainerItemId: { type: 'string' },
    entry: { type: 'string', enum: ['current', 'position'], default: 'current' }, closeAfter: { type: 'boolean', default: true },
    minimumFreePlayerSlots: { type: 'integer', minimum: 0, maximum: 36, default: 0 },
    moves: { type: 'array', minItems: 1, maxItems: 16, description: '按顺序执行，槽位含义是该步骤当前槽；不自动选择额外物品、换箱或交换。存工具需额外精确实例/等级确认。',
      items: { type: 'object', additionalProperties: false, required: ['direction', 'sourceSlot', 'itemId', 'quality', 'quantity'], properties: {
        direction: { type: 'string', enum: ['player_to_container', 'container_to_player'] }, sourceSlot: { type: 'integer', minimum: 0, maximum: 255 },
        itemId: { type: 'string' }, quality: { type: 'integer', minimum: 0, maximum: 4 }, quantity: { type: 'integer', minimum: 1, maximum: 10000 },
        expectedItemRef: { type: 'string', description: '可选额外绑定实际MCP物品Ref.value；工具必须提供，旧Ref不自动替换。' },
        allowTools: { type: 'boolean', default: false }, expectedToolLevel: { type: 'integer', minimum: 0, maximum: 1000 },
      } } },
  } },
  scope: '当前地点准确普通玩家箱、大箱或已解锁主冰箱；沿用原MCP完整双库存UI和守恒计划器。1–16个明确方向/源槽/ID/品质/数量的顺序移动，工具默认拒绝，未用丢弃/出货/自动补料代替储物。小冰箱、祝尼魔/共享、自动装填器、出货箱/家具和未知Mod另需适配。',
  postconditions: ['实际存活箱子实例、位置/类型/物品、菜单、锁和后备库存一致，不按外观名字或旧Ref猜',
    '每次转移准确数量，双方完整库存版本、全物品/品质增减及金币均核对，后端Native数量独立一致',
    '失败仅在新读取证明双方版本/内容未变时记录已拒绝；回滚未证实或未知停止，不重放，不擅自补偿',
    '保留原日动作及清理预算，按要求正常关闭/核对空槽目标；已确认移动是位置变化，不算新生产'],
};
const whole = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const qualified = (value: unknown): value is string => typeof value === 'string' && /^\([A-Za-z]+\)[^\s\x00-\x1f]{1,128}$/.test(value);
const ref = (value: unknown): value is ObjectValue => object(value) && typeof value.value === 'string' && value.value.length > 0 && value.value.length <= 512 && !/[\x00-\x1f]/.test(value.value);
interface Frame { native: ObjectValue; target: ObjectValue; ui: ObjectValue; player: ObjectValue; container: ObjectValue; containerRef: ObjectValue }

export async function storageTransfer(args: unknown, io: WorkflowIO): Promise<'completed'> {
  requireFact(object(args) && Object.keys(args).every(k => ['position', 'targetKey', 'expectedContainerKind', 'expectedContainerItemId', 'entry', 'closeAfter', 'minimumFreePlayerSlots', 'moves'].includes(k))
    && typeof args.targetKey === 'string' && /^[a-f0-9]{32}$/.test(args.targetKey) && ['chest', 'big_chest', 'fridge'].includes(args.expectedContainerKind)
    && qualified(args.expectedContainerItemId), '需要真实储物位置、存活实例key和准确类型/物品ID。');
  const targetPosition = positionOf(args.position), entry = args.entry ?? 'current', closeAfter = args.closeAfter ?? true, freeSlots = args.minimumFreePlayerSlots ?? 0;
  requireFact(['current', 'position'].includes(entry) && typeof closeAfter === 'boolean' && whole(freeSlots, 0, 36)
    && Array.isArray(args.moves) && args.moves.length >= 1 && args.moves.length <= 16, '储物入口、批次或空槽目标不符合声明。');
  const moves = args.moves.map((move: unknown) => {
    requireFact(object(move) && Object.keys(move).every(k => ['direction', 'sourceSlot', 'itemId', 'quality', 'quantity', 'expectedItemRef', 'allowTools', 'expectedToolLevel'].includes(k))
      && ['player_to_container', 'container_to_player'].includes(move.direction) && whole(move.sourceSlot, 0, 255) && qualified(move.itemId)
      && whole(move.quality, 0, 4) && whole(move.quantity, 1, 10000) && typeof (move.allowTools ?? false) === 'boolean'
      && (move.expectedItemRef === undefined || ref({ value: move.expectedItemRef })) && (move.expectedToolLevel === undefined || whole(move.expectedToolLevel, 0, 1000)), '每步必须明确方向、源槽、ID/品质和数量，额外Ref/工具约束不能伪造。');
    return move;
  });
  io.needs(STORAGE_WORKFLOW.requiredTools);
  requireFact(io.port.current().player.position.locationId === targetPosition.locationId, '本流程不跨地图追箱；先走到当前实际地点并重新查询。');
  const enough = (needed: number) => requireFact(whole(io.port.remainingActions?.(), needed, 128), '原日剩余动作不足以完成本批及清理，未提交下一步。');
  enough(moves.length + (closeAfter ? 1 : 0) + (entry === 'position' ? 2 : 0));
  const queryNative = async () => {
    const query = await io.call('dsh_query_storage', { position: targetPosition, offset: 0, limit: 1 });
    requireFact(query.supportedBuild === true && /^[a-f0-9]{64}$/.test(query.revision) && Array.isArray(query.items) && query.items.length === 1
      && query.count === 1 && query.nextOffset === null, '目标箱或构建没有完整实际事实。');
    const target = query.items[0];
    requireFact(target.targetKey === args.targetKey && samePosition(target.position, targetPosition) && target.kind === args.expectedContainerKind
      && target.itemId === args.expectedContainerItemId && target.compatibleWithAuditedMcp === true && /^[a-f0-9]{64}$/.test(target.targetDigest), '箱子实例/位置/类型改变，或不属于已核对普通储物形状。');
    return { query, target };
  };
  let menuId: string | undefined, sourceInventoryId: string | undefined, actualContainerRef: ObjectValue | undefined;
  const readFrame = async (): Promise<Frame> => {
    const { query, target } = await queryNative(), current = query.current;
    requireFact(object(current) && current.target?.targetKey === args.targetKey && current.held === null && current.lockHeld === true && current.backingMatches === true
      && typeof current.menuId === 'string' && typeof current.sourceInventoryId === 'string', '没有该箱子的准确空游标/锁定菜单和真实后备库存。');
    if (menuId !== undefined) requireFact(current.menuId === menuId && current.sourceInventoryId === sourceInventoryId, '储物菜单或后备库存实例改变，不能沿用旧授权/Ref。');
    const ui = (await io.call('stardew_query_ui', {})).snapshot;
    requireFact(object(ui) && ui.menuOpen === true && ui.menu?.menuType === 'ItemGrabMenu' && /^[a-f0-9]{64}$/.test(ui.uiRevision)
      && Array.isArray(ui.inventories) && ui.inventories.length === 2, 'MCP没有完整双库存储物投影，未把普通ItemGrabMenu都当箱子。');
    const playerLink = ui.inventories.find((link: ObjectValue) => link.side === 'player'), containerLink = ui.inventories.find((link: ObjectValue) => link.side === 'container');
    requireFact(playerLink && containerLink && ref(containerLink.containerRef) && !playerLink.containerRef, '库存链接的来源或容器Ref不完整。');
    if (actualContainerRef) requireFact(containerLink.containerRef.value === actualContainerRef.value, '当前MCP容器Ref不是本批原容器。');
    // Native keys and MCP refs identify separate protocols. Require the real menu
    // backing and its current links; never construct a containerRef from a tile/key.
    const player = await io.inventory(), container = completeInventory((await io.call('stardew_query_inventory', { containerRef: containerLink.containerRef, includeEmptySlots: true })).snapshot);
    requireFact(player.inventoryRevision === playerLink.inventoryRevision && container.inventoryRevision === containerLink.inventoryRevision
      && player.slotCount === playerLink.slotCount && container.slotCount === containerLink.slotCount && container.containerKind === args.expectedContainerKind
      && ref(container.containerRef) && container.containerRef.value === containerLink.containerRef.value, 'UI与双方完整库存版本/容量/来源不一致。');
    const latest = await queryNative();
    requireFact(latest.query.revision === query.revision && latest.query.current?.menuId === current.menuId, '读取双库存期间现场改变，未按旧快照变更。');
    nativeCounts(player, latest.query.player); nativeCounts(container, latest.target.contents);
    requireFact(String(latest.query.gold) === io.port.current().player.money, 'Native和MCP余额不一致。');
    menuId ??= current.menuId; sourceInventoryId ??= current.sourceInventoryId; actualContainerRef ??= containerLink.containerRef;
    return { native: latest.query, target: latest.target, ui, player, container, containerRef: containerLink.containerRef };
  };
  const close = async (before: Frame): Promise<void> => {
    const result = await io.call('dsh_storage_ui', { operation: 'close', position: targetPosition, targetKey: args.targetKey,
      targetDigest: before.target.targetDigest, revision: before.native.revision });
    io.observed('storage_ui_receipt', result);
    try {
      requireFact(result.completedWorkflow === true && result.operation === 'close' && result.targetKey === args.targetKey, '原生关闭未确认。');
      const player = await io.inventory(), container = completeInventory((await io.call('stardew_query_inventory', { containerRef: before.containerRef, includeEmptySlots: true })).snapshot);
      verifyInventoryChanges(before.player, player, []); verifyInventoryChanges(before.container, container, []);
      const after = await queryNative(); nativeCounts(player, after.query.player); nativeCounts(container, after.target.contents);
      requireFact(after.query.menuType === null && after.query.current === null && after.query.gold === before.native.gold
        && io.port.current().player.canMove && !io.port.current().ui.menuOpen, '没有回到正确空闲世界，或清理后金币/库存改变。');
    } catch { return io.uncertain('关闭储物后的双方库存或原生空闲未完整确认。'); }
  };
  if (entry === 'position') {
    io.ready(targetPosition.locationId);
    await io.call('stardew_navigate', { position: targetPosition, arrival: 'adjacent' }); io.ready(targetPosition.locationId);
    const beforePlayer = await io.inventory(), { query, target } = await queryNative(); nativeCounts(beforePlayer, query.player);
    requireFact(query.menuType === null && target.adjacent === true && target.actorBlocked === false, '目标不相邻/被角色挡住或已有菜单。');
    const result = await io.call('dsh_storage_ui', { operation: 'open', position: targetPosition, targetKey: args.targetKey, targetDigest: target.targetDigest, revision: query.revision });
    io.observed('storage_ui_receipt', result);
    try {
      requireFact(result.completedWorkflow === true && result.operation === 'open' && result.targetKey === args.targetKey, '原生打开未确认。');
      const opened = await readFrame(); verifyInventoryChanges(beforePlayer, opened.player, []); nativeCounts(opened.container, target.contents);
      requireFact(opened.native.gold === query.gold, '打开储物界面改变了金币。');
    } catch { return io.uncertain('打开储物没有确认准确箱子及零物品/金币变化。'); }
  }
  let latest = await readFrame();
  for (let index = 0; index < moves.length; index++) {
    enough(moves.length - index + (closeAfter ? 1 : 0));
    const move = moves[index], before = await readFrame(), fromPlayer = move.direction === 'player_to_container', source = fromPlayer ? before.player : before.container;
    const slot = source.slots[move.sourceSlot], item = slot?.item;
    requireFact(slot?.index === move.sourceSlot && object(item) && item.qualifiedItemId === move.itemId && item.quality === move.quality
      && whole(item.stack, move.quantity, 10000) && ref(item.ref) && (move.expectedItemRef === undefined || item.ref.value === move.expectedItemRef), '当前源槽/物品/品质/数量或指定Ref已变，未改选其他物品。');
    requireFact(item.tool !== true || move.allowTools === true && move.expectedToolLevel !== undefined && item.toolLevel === move.expectedToolLevel && move.expectedItemRef !== undefined,
      '工具移动需要明确允许、准确等级和当前实际物品Ref；没有默认存走工具。');
    const result = await io.port.call('stardew_transfer_inventory_item', { direction: move.direction, itemRef: item.ref, quantity: move.quantity,
      uiRevision: before.ui.uiRevision, playerInventoryRevision: before.player.inventoryRevision, containerInventoryRevision: before.container.inventoryRevision });
    io.observed('storage_mcp_receipt', { index: index + 1, status: result.status, output: result.output, error: result.error });
    if (result.status !== 'succeeded') {
      if (result.status === 'unknown') return io.uncertain('储物转移结果未知，没有重试同一物品。');
      let unchanged: Frame;
      try {
        // A failed native commit may also have failed to roll back. Only a new
        // complete two-sided capture can prove this rejection left no effect.
        unchanged = await readFrame();
        requireFact(unchanged.player.inventoryRevision === before.player.inventoryRevision && unchanged.container.inventoryRevision === before.container.inventoryRevision
          && unchanged.native.gold === before.native.gold && inventoryDelta(before.player, unchanged.player).size === 0 && inventoryDelta(before.container, unchanged.container).size === 0,
        '拒绝/回滚后的双方版本或状态改变。');
      } catch { return io.uncertain('MCP报转移失败，但未独立确认双方库存未变；不相信文字回滚承诺。'); }
      io.observed('storage_transfer_rejected_unchanged', { index: index + 1, code: result.error?.code, noInventoryChangeConfirmed: true });
      if (closeAfter) await close(unchanged);
      throw new Error(`第${index + 1}步被拒绝，已确认双方库存未变；保留之前完成的移动，不自动减少数量、交换或重复。`);
    }
    try {
      // MCP success alone cannot establish conservation or a current inventory.
      // Verification errors after submission halt the run, never just the batch.
      latest = await readFrame(); const receipt = result.output;
      requireFact(object(receipt) && receipt.transferredQuantity === move.quantity && receipt.sourceSlotIndex === move.sourceSlot && receipt.sourceRemainingQuantity === item.stack - move.quantity
        && receipt.playerInventoryRevision === latest.player.inventoryRevision && receipt.containerInventoryRevision === latest.container.inventoryRevision
        && latest.native.gold === before.native.gold, '转移数量、源槽剩余、双方版本或金币收据不一致。');
      const playerChange = { itemId: move.itemId, quality: move.quality, amount: fromPlayer ? -move.quantity : move.quantity };
      verifyInventoryChanges(before.player, latest.player, [playerChange]);
      verifyInventoryChanges(before.container, latest.container, [{ ...playerChange, amount: -playerChange.amount }]);
      io.observed('storage_transfer_verified', { position: targetPosition, containerKind: args.expectedContainerKind, containerItemId: args.expectedContainerItemId,
        direction: move.direction, itemId: move.itemId, quality: move.quality, quantity: move.quantity, sourceSlot: move.sourceSlot, index: index + 1,
        playerRevision: latest.player.inventoryRevision, containerRevision: latest.container.inventoryRevision, movementOnlyNotProduction: true });
    } catch { return io.uncertain('转移后的双库存、Native数量或收据未确认，停止且不重放。'); }
  }
  const empty = latest.player.slots.filter((slot: ObjectValue) => slot.item === null).length;
  if (closeAfter) await close(latest);
  requireFact(empty >= freeSlots, '指定移动已确认，但未达到要求的背包空槽数；不擅自增加存物或丢弃。');
  io.observed('storage_batch_completed', { position: targetPosition, containerKind: args.expectedContainerKind, moves: moves.length,
    freePlayerSlots: empty, closed: closeAfter, note: '只移动已批准的槽位/数量；没有全仓自动规划、交换、特殊容器或持久恢复。' });
  return 'completed';
}

import { object, positionOf, requireFact, samePosition, WorkflowIO, type ObjectValue, type Position } from '../workflow-context.js';

const positionSchema = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: { locationId: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } } };
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const hayId = '(O)178';
export const ANIMAL_FEED_WORKFLOW = {
  name: 'animal_feed_prepare', title: '用背包现有干草填好明确饲料槽', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_husbandry', 'stardew_query_inventory', 'stardew_navigate', 'dsh_husbandry'],
  parameters: { type: 'object', additionalProperties: false, required: ['positions'], properties: {
    positions: { type: 'array', minItems: 1, maxItems: 8, items: positionSchema },
    hayQuality: { type: 'integer', minimum: 0, maximum: 4, default: 0, description: '只消耗指定品质的现有(O)178干草，不暗中用更高品质' },
  } },
  scope: '当前已加载AnimalHouse的1–8个明确原生Trough；已填草槽跳过，其他占用停止。正常玩家交互每空槽消耗1份背包干草，筒仓不变；不调用豪华畜舍AutoFeed、不提取筒仓或设置动物饱食度。',
  postconditions: ['空槽变为1份相同品质干草，背包恰好减少1份', '原生动作未改筒仓，未触发其他菜单/事件', '填槽只表示备料；动物实际吃草与饱食度需按游戏时序另查'],
};
export const GROUND_COLLECT_WORKFLOW = {
  name: 'ground_collect', title: '收取明确蛋、松露等落地产物及被动采集物', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_husbandry', 'stardew_query_inventory', 'stardew_navigate', 'dsh_husbandry'],
  parameters: { type: 'object', additionalProperties: false, required: ['targets'], properties: {
    targets: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['position', 'itemId', 'quality', 'maxSourceCount'], properties: {
      position: positionSchema, itemId: { type: 'string' }, quality: { type: 'integer', minimum: 0, maximum: 4 }, maxSourceCount: { type: 'integer', minimum: 1, maximum: 1 },
    } } },
  } },
  scope: '当前地点明确位置/ID/原始品质/单件源；仅普通Object、原生spawned/grabbable、非任务/机器，且匹配实际动物产物目录或原生isForage。目录匹配不证明是哪只动物生产。原生决定最终品质和Gatherer增量，不预先求值RNG。原生getOne只复制1件，成堆源需另适配以避免丢失余量。',
  postconditions: ['原地点物品消失，新背包获得相同物品ID的实际品质/数量', '每个实际背包增量独立核对，原生品质/采集者奖励可变化', '容量按保守最大增量/可能品质检查，不丢弃或自动出货'],
};

function batch(positions: Position[], io: WorkflowIO): string {
  requireFact(positions.length >= 1 && positions.length <= 8 && new Set(positions.map(p => JSON.stringify(p))).size === positions.length, '需要1–8个不同的实际位置。');
  const location = positions[0].locationId; io.ready(location);
  requireFact(positions.every(p => p.locationId === location && Math.abs(p.x - io.port.current().player.position.x) + Math.abs(p.y - io.port.current().player.position.y) <= 24), '只操作当前地点24格内的局部批次；跨地点或远处请先导航并重新查询。');
  return location;
}
async function query(position: Position, section: 'house' | 'ground', io: WorkflowIO): Promise<{ state: ObjectValue; target: ObjectValue }> {
  const state = await io.call('dsh_query_husbandry', { section, position, offset: 0, limit: 1 });
  requireFact(state.locationId === position.locationId && Array.isArray(state.items) && state.items.length === 1 && /^[a-f0-9]{64}$/.test(state.inventoryDigest), '缺少当前地点精确目标与库存摘要。');
  const target = state.items[0];
  requireFact(object(target) && samePosition(target.position, position) && /^[a-f0-9]{64}$/.test(target.digest), '原生目标位置或摘要无效。');
  return { state, target };
}
async function approach(position: Position, io: WorkflowIO): Promise<void> {
  io.ready(position.locationId);
  const p = io.port.current().player.position;
  if (Math.abs(p.x - position.x) + Math.abs(p.y - position.y) > 1) await io.call('stardew_navigate', { position, arrival: 'adjacent' });
  io.ready(position.locationId);
  const standing = io.port.current().player.position;
  requireFact(Math.abs(standing.x - position.x) + Math.abs(standing.y - position.y) <= 1, '未到目标相邻格，不按旧位置交互。');
}

export async function animalFeedPrepare(args: unknown, io: WorkflowIO): Promise<void> {
  requireFact(object(args) && Object.keys(args).every(key => ['positions', 'hayQuality'].includes(key)) && Array.isArray(args.positions), 'animal_feed_prepare需要明确positions和可选hayQuality。');
  const quality = args.hayQuality ?? 0;
  requireFact(integer(quality, 0, 4), '干草品质无效。');
  io.needs(ANIMAL_FEED_WORKFLOW.requiredTools);
  const positions = args.positions.map(positionOf); const location = batch(positions, io);
  let needed = 0;
  for (const position of positions) {
    const { state, target } = await query(position, 'house', io);
    requireFact(state.house && target.trough === true && target.actorBlocked === false && (target.empty === true || target.occupiedItemId === hayId), '不是明确饲料槽、被动物/NPC阻挡或有其他占用；未自动清走物品。');
    if (target.empty) needed++;
    io.observed('feed_preflight', { target, house: state.house, siloStocks: state.siloStocks });
  }
  requireFact(io.count(await io.inventory(), hayId, quality) >= needed, '指定品质的背包干草不足；没有从筒仓凭空补草或调用自动喂食。');
  for (const position of positions) {
    io.ready(location);
    let fresh = await query(position, 'house', io);
    if (fresh.target.trough === true && fresh.target.occupiedItemId === hayId) { io.observed('feed_skipped_already_filled', fresh.target); continue; }
    await approach(position, io); fresh = await query(position, 'house', io);
    requireFact(fresh.target.trough === true && fresh.target.empty === true && fresh.target.actorBlocked === false, '饲料槽状态已变化，停止而不清空或重复投草。');
    const inventory = await io.inventory();
    const source = inventory.slots.find((s: ObjectValue) => s.item?.qualifiedItemId === hayId && s.item.quality === quality && s.item.stack > 0);
    requireFact(source && integer(source.index, 0, 255), '指定品质干草已不在实际背包槽。');
    const before = io.count(inventory, hayId, quality);
    const result = await io.call('dsh_husbandry', { operation: 'feed', position, expectedItemId: hayId, expectedQuality: quality,
      inventorySlot: source.index, targetDigest: fresh.target.digest, inventoryDigest: fresh.state.inventoryDigest });
    io.observed('feed_native_receipt', result);
    requireFact(result.completedWorkflow === true && result.filledTrough === true && result.hayConsumed === 1 && result.siloUnchanged === true, '填槽、单份耗草或筒仓收据未同时确认。');
    const after = await query(position, 'house', io), afterInventory = await io.inventory();
    requireFact(after.target.trough === true && after.target.occupiedItemId === hayId && after.target.occupiedCount === 1 && after.target.occupiedQuality === quality
      && before - io.count(afterInventory, hayId, quality) === 1, '新查询未同时确认单槽干草与背包减少1。');
    io.observed('feed_prepared', { target: after.target, note: '只确认备好干草；没有宣称动物已吃或饱食度已提高。' });
  }
}

export async function groundCollect(args: unknown, io: WorkflowIO): Promise<void> {
  requireFact(object(args) && Object.keys(args).every(key => key === 'targets') && Array.isArray(args.targets), 'ground_collect需要完整targets。');
  const targets = args.targets.map((t: unknown) => {
    requireFact(object(t) && Object.keys(t).every(key => ['position', 'itemId', 'quality', 'maxSourceCount'].includes(key)) && typeof t.itemId === 'string'
      && /^\(O\)[^\s\x00-\x1f]{1,128}$/.test(t.itemId) && integer(t.quality, 0, 4) && integer(t.maxSourceCount, 1, 1), '目标需要实际物体ID、原始品质与maxSourceCount=1；不在原生单件路径冒险取成堆物品。');
    return { position: positionOf(t.position), itemId: t.itemId, quality: t.quality, maxSourceCount: t.maxSourceCount };
  });
  io.needs(GROUND_COLLECT_WORKFLOW.requiredTools); batch(targets.map((t: ObjectValue) => t.position), io);
  const valid = (target: ObjectValue, planned: ObjectValue): void => requireFact(target.eligible === true && target.actorBlocked === false && target.inventoryCapacityForWorstCase === true
    && target.itemId === planned.itemId && target.quality === planned.quality && integer(target.count, 1, planned.maxSourceCount), '落地产物、来源数量/品质、被动可拾取性或保守容量未确认。');
  for (const t of targets) { const fresh = await query(t.position, 'ground', io); valid(fresh.target, t); io.observed('ground_preflight', fresh.target); }
  for (const t of targets) {
    await approach(t.position, io);
    const fresh = await query(t.position, 'ground', io); valid(fresh.target, t);
    const before = await io.inventory();
    const result = await io.call('dsh_husbandry', { operation: 'collect_ground', position: t.position, expectedItemId: t.itemId, expectedQuality: t.quality,
      maxSourceCount: t.maxSourceCount, targetDigest: fresh.target.digest, inventoryDigest: fresh.state.inventoryDigest });
    io.observed('ground_native_receipt', result);
    requireFact(result.completedWorkflow === true && result.siloUnchanged === true && Array.isArray(result.inventoryChanges) && result.inventoryChanges.length > 0, '原生拾取收据未完整确认；不重复交互猜结果。');
    const after = await io.inventory(), floor = await query(t.position, 'ground', io);
    requireFact(floor.target.itemId === null, '原地点仍有物品，不能宣称已取走。');
    for (const gain of result.inventoryChanges) requireFact(gain.itemId === t.itemId && integer(gain.quality, 0, 4) && Number.isSafeInteger(gain.amount) && gain.amount > 0
      && io.count(after, gain.itemId, gain.quality) - io.count(before, gain.itemId, gain.quality) === gain.amount, '新背包与原生拾取品质/增量不一致。');
    io.observed('ground_collected', { position: t.position, itemId: t.itemId, inventoryChanges: result.inventoryChanges,
      note: '原生决定实际品质和采集者奖励；物品目录匹配不证明是哪只动物生产。' });
  }
}

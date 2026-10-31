import { object, positionOf, requireFact, samePosition, WorkflowIO, type ObjectValue } from '../workflow-context.js';

const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const qualified = (value: unknown): value is string => typeof value === 'string' && /^\([A-Za-z]+\)[^\s\x00-\x1f]{1,128}$/.test(value);
const base = { rodSlot: { type: 'integer', minimum: 0, maximum: 255 }, expectedRodItemId: { type: 'string', description: 'dsh_query_fishing返回的实际钓竿完整ID' } };
const expectedGearSchema = { type: 'array', maxItems: 3, description: '实际查询的完整附件槽，包含空槽，按index排序。固定饵/鱼钩物品与品质，不固定会自然消耗的数量和磨损。',
  items: { type: 'object', additionalProperties: false, required: ['index', 'itemId', 'quality'], properties: { index: { type: 'integer', minimum: 0, maximum: 2 }, itemId: { type: ['string', 'null'] }, quality: { type: 'integer', minimum: 0, maximum: 4 } } } };
const positionSchema = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: { locationId: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } } };
export const FISHING_SETUP_WORKFLOW = {
  name: 'fishing_setup', title: '原生装卸鱼饵与最多双鱼钩', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_fishing', 'dsh_query_inventory', 'dsh_fishing_gear'],
  parameters: { type: 'object', additionalProperties: false, required: ['rodSlot', 'expectedRodItemId', 'attachments'], properties: {
    ...base, attachments: { type: 'array', maxItems: 3, description: '完整目标配置；未列出的槽清空。0为鱼饵、1/2为鱼钩；不能只装槽2而留空槽1。keep保留该槽现有物品。需足够空背包槽暂存旧附件。',
      items: { type: 'object', additionalProperties: false, required: ['index'], properties: {
        index: { type: 'integer', minimum: 0, maximum: 2 }, keep: { type: 'boolean', const: true },
        inventorySlot: { type: 'integer', minimum: 0, maximum: 255 }, itemId: { type: 'string' }, quality: { type: 'integer', minimum: 0, maximum: 4 }, maxCount: { type: 'integer', minimum: 1, maximum: 10000 },
      } },
    },
  } },
  scope: '背包已有钓竿、鱼饵和鱼钩；完整目标配置、逐次原生装卸、全物品与附件数量守恒。过大来源堆叠需先用已提供的守恒分拆接口准备；不购买、生成附件或修改磨损。',
  postconditions: ['旧附件按原生首个非空规则移入真实空背包槽', '原生装配实际槽位匹配，逐项数量守恒', '最终完整配置的物品/品质/数量/磨损与目标一致'],
};
export const FISHING_CAST_WORKFLOW = {
  name: 'fishing_cast', title: '单次抛竿、鱼条、宝箱与渔获入袋', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_fishing', 'stardew_navigate', 'dsh_fish', 'dsh_query_event', 'stardew_query_inventory'],
  parameters: { type: 'object', additionalProperties: false, required: ['position', 'rodSlot', 'expectedRodItemId', 'direction', 'expectedGear'], properties: {
    ...base, expectedGear: expectedGearSchema, position: positionSchema, direction: { type: 'integer', minimum: 0, maximum: 3, description: '上0右1下2左3；指向原生查询到的可钓水域' },
    durationMs: { type: 'integer', minimum: 1000, maximum: 90000, default: 90000 }, castPowerPercent: { type: 'integer', minimum: 10, maximum: 100, default: 75 },
    tryTreasure: { type: 'boolean', default: true }, maxBaitConsumed: { type: 'integer', minimum: 0, maximum: 1, default: 1 },
    maxTackleWear: { type: 'integer', minimum: 0, maximum: 1, default: 1, description: '每个已装备鱼钩槽的磨损上限' },
  } },
  scope: '同地点合法站位导航及一次原生尝试，支持普通鱼/垃圾、鱼条反馈、可选宝箱、当前钓竿来源的原生收取菜单。至少留1空槽；满包或不可见物品保留菜单并停止，不自动丢弃/出货。鱼种规则为原文，未把随机条件或节日特殊钓鱼当作已适配。',
  postconditions: ['真实站位、钓竿与附件/背包digest匹配后才抛竿', '原生结束回到可操作世界，没有遗留鱼条/宝箱动画/菜单', 'caught只在原生渔获与实际背包增量匹配时成立；escaped/invalid_cast不是钓到鱼', '饵消耗和每槽磨损有收据；结果未知停止且不重抛'],
};

async function readRod(io: WorkflowIO, slot: number, id: string): Promise<{ state: ObjectValue; rod: ObjectValue }> {
  const state = await io.call('dsh_query_fishing', {});
  requireFact(Array.isArray(state.rods) && /^[a-f0-9]{64}$/.test(state.inventoryDigest), '缺少真实钓竿和背包事实。');
  const rod = state.rods.find((candidate: ObjectValue) => candidate.slot === slot && candidate.itemId === id);
  requireFact(object(rod) && /^[a-f0-9]{64}$/.test(rod.gearDigest) && Array.isArray(rod.attachments) && rod.inUse === false && rod.showingTreasure === false, '目标钓竿已变化或仍在钓鱼。');
  return { state, rod };
}
function rodArgs(args: unknown): asserts args is ObjectValue {
  requireFact(object(args) && integer(args.rodSlot, 0, 255) && qualified(args.expectedRodItemId), '需要实际rodSlot与完整钓竿物品ID。');
}

export async function fishingSetup(args: unknown, io: WorkflowIO): Promise<void> {
  rodArgs(args);
  requireFact(Object.keys(args).every(key => ['rodSlot', 'expectedRodItemId', 'attachments'].includes(key)) && Array.isArray(args.attachments) && args.attachments.length <= 3, 'fishing_setup需要完整附件配置。');
  io.needs(FISHING_SETUP_WORKFLOW.requiredTools); io.ready();
  const slot = args.rodSlot, id = args.expectedRodItemId;
  const initial = await readRod(io, slot, id), inventory = await io.call('dsh_query_inventory', {});
  requireFact(Array.isArray(inventory.slots) && inventory.digest === initial.state.inventoryDigest && integer(initial.rod.attachmentSlots, 0, 3)
    && initial.rod.attachments.length <= 3 && Array.isArray(initial.rod.eligibleInventoryGear), '当前钓竿槽或背包快照不完整，未开始装卸。');
  const locationId = positionOf(initial.state.position).locationId;
  const targets = args.attachments.map((value: unknown) => {
    requireFact(object(value) && integer(value.index, 0, 2) && value.index < initial.rod.attachmentSlots, '目标附件槽不在实际钓竿可用范围。');
    if (value.keep === true) {
      requireFact(Object.keys(value).every(key => ['index', 'keep'].includes(key)), 'keep不能同时指定其他来源。');
      const old = initial.rod.attachments.find((a: ObjectValue) => a.index === value.index);
      requireFact(old && qualified(old.itemId) && integer(old.stack, 1, 10000), '要保留的附件不存在。');
      return { index: value.index, keep: true, inventorySlot: -1, itemId: old.itemId, quality: old.quality, stack: old.stack, uses: old.uses, maxCount: old.stack };
    }
    requireFact(Object.keys(value).every(key => ['index', 'inventorySlot', 'itemId', 'quality', 'maxCount'].includes(key))
      && integer(value.inventorySlot, 0, 255) && value.inventorySlot !== slot && qualified(value.itemId) && integer(value.quality, 0, 4) && integer(value.maxCount, 1, 10000), '附件来源需要实际背包槽、物品ID、品质与堆叠上限。');
    const source = initial.rod.eligibleInventoryGear.find((gear: ObjectValue) => gear.inventorySlot === value.inventorySlot && gear.itemId === value.itemId && gear.quality === value.quality);
    requireFact(source && integer(source.stack, 1, value.maxCount), '原生钓竿不接受该来源，或实际堆叠超过预算；先分拆或重新查询。');
    return { index: value.index, keep: false, inventorySlot: value.inventorySlot, itemId: value.itemId, quality: value.quality, stack: source.stack, uses: source.uses, maxCount: value.maxCount };
  }).sort((a: ObjectValue, b: ObjectValue) => a.index - b.index);
  requireFact(new Set(targets.map((t: ObjectValue) => t.index)).size === targets.length
    && new Set(targets.filter((t: ObjectValue) => !t.keep).map((t: ObjectValue) => t.inventorySlot)).size === targets.filter((t: ObjectValue) => !t.keep).length, '目标附件槽和来源不能重复。');
  requireFact(!targets.some((t: ObjectValue) => t.index === 2) || targets.some((t: ObjectValue) => t.index === 1), '原生装配先选首个可用槽，不能留空鱼钩1而只装鱼钩2。');
  const old = initial.rod.attachments.filter((fact: ObjectValue) => fact.itemId !== null);
  requireFact(inventory.slots.filter((s: ObjectValue) => s.item === null).length >= old.length, '空槽不足以暂存旧附件，未开始清空钓竿；不自动丢弃物品。');
  io.observed('fishing_setup_preflight', { rod: initial.rod, targets, temporarySlotsRequired: old.length });
  for (const previous of old) {
    io.ready(locationId);
    const fresh = await readRod(io, slot, id), inv = await io.call('dsh_query_inventory', {});
    const first = fresh.rod.attachments.find((a: ObjectValue) => a.itemId !== null), empty = inv.slots?.find((s: ObjectValue) => s.item === null);
    requireFact(first && first.index === previous.index && first.itemId === previous.itemId && first.stack === previous.stack && first.quality === previous.quality && first.uses === previous.uses
      && empty && inv.digest === fresh.state.inventoryDigest, '原附件或可用空槽已变化，停止且不重复移除。');
    const result = await io.call('dsh_fishing_gear', { operation: 'detach_first', rodSlot: slot, expectedRodItemId: id,
      inventoryDigest: inv.digest, gearDigest: fresh.rod.gearDigest, attachmentIndex: first.index, inventorySlot: empty.index,
      expectedItemId: first.itemId, expectedQuality: first.quality, maxCount: first.stack });
    io.observed('fishing_gear_detached', result);
    requireFact(result.completedWorkflow === true && result.conservedQuantity === true, '没有确认原生卸下及数量守恒。');
    const kept = targets.find((t: ObjectValue) => t.keep && t.index === first.index);
    if (kept) kept.inventorySlot = empty.index;
  }
  for (const target of targets) {
    io.ready(locationId);
    const fresh = await readRod(io, slot, id), inv = await io.call('dsh_query_inventory', {});
    const source = fresh.rod.eligibleInventoryGear.find((gear: ObjectValue) => gear.inventorySlot === target.inventorySlot && gear.itemId === target.itemId && gear.quality === target.quality);
    requireFact(source && source.stack === target.stack && source.uses === target.uses && inv.digest === fresh.state.inventoryDigest, '目标附件来源或磨损已变化，未装入其他物品。');
    const result = await io.call('dsh_fishing_gear', { operation: 'attach', rodSlot: slot, expectedRodItemId: id,
      inventoryDigest: inv.digest, gearDigest: fresh.rod.gearDigest, attachmentIndex: target.index, inventorySlot: target.inventorySlot,
      expectedItemId: target.itemId, expectedQuality: target.quality, maxCount: target.maxCount });
    io.observed('fishing_gear_attached', result);
    requireFact(result.completedWorkflow === true && result.conservedQuantity === true, '原生选择的附件槽或数量未确认，停止而不重放。');
  }
  const final = (await readRod(io, slot, id)).rod;
  requireFact(final.attachments.every((a: ObjectValue) => {
    const target = targets.find((t: ObjectValue) => t.index === a.index);
    return target ? a.itemId === target.itemId && a.quality === target.quality && a.stack === target.stack && a.uses === target.uses : a.itemId === null;
  }), '最终完整附件配置与目标不符，未宣称装备完成。');
  io.observed('fishing_setup_completed', { rod: final, note: '未选附件已移到背包；部分失败保留实际位置，没有回滚或凭空恢复。' });
}

export async function fishingCast(args: unknown, io: WorkflowIO): Promise<void> {
  rodArgs(args);
  requireFact(Object.keys(args).every(key => ['position', 'rodSlot', 'expectedRodItemId', 'expectedGear', 'direction', 'durationMs', 'castPowerPercent', 'tryTreasure', 'maxBaitConsumed', 'maxTackleWear'].includes(key))
    && integer(args.direction, 0, 3) && Array.isArray(args.expectedGear) && args.expectedGear.length <= 3
    && args.expectedGear.every((row: unknown, index: number) => object(row) && Object.keys(row).every(key => ['index', 'itemId', 'quality'].includes(key))
      && row.index === index && (row.itemId === null || qualified(row.itemId)) && integer(row.quality, 0, 4) && (row.itemId !== null || row.quality === 0)), 'fishing_cast需要明确站位、方向及完整附件身份。');
  const position = positionOf(args.position), durationMs = args.durationMs ?? 90000, power = args.castPowerPercent ?? 75,
    bait = args.maxBaitConsumed ?? 1, wear = args.maxTackleWear ?? 1, treasure = args.tryTreasure ?? true;
  requireFact(integer(durationMs, 1000, 90000) && integer(power, 10, 100) && integer(bait, 0, 1) && integer(wear, 0, 1) && typeof treasure === 'boolean', '钓鱼时长、抛竿力度或资源预算无效。');
  io.needs(FISHING_CAST_WORKFLOW.requiredTools); io.ready(position.locationId);
  if (!samePosition(io.port.current().player.position, position)) await io.call('stardew_navigate', { position, arrival: 'exact' });
  io.ready(position.locationId);
  const fresh = await readRod(io, args.rodSlot, args.expectedRodItemId);
  requireFact(fresh.rod.attachments.length === args.expectedGear.length && fresh.rod.attachments.every((row: ObjectValue, index: number) =>
    row.index === index && row.itemId === args.expectedGear[index].itemId && row.quality === args.expectedGear[index].quality), '实际饵/鱼钩与请求身份不同，未默默更换耗材。');
  requireFact(samePosition(positionOf(fresh.state.position), position) && fresh.state.canFishHere === true && Array.isArray(fresh.state.fishableRayTiles)
    && fresh.state.fishableRayTiles.some((tile: ObjectValue) => tile.direction === args.direction) && fresh.state.emptyInventorySlots >= 1, '站位、原生水域或至少一个空背包槽未确认；未抛竿。');
  const before = await io.inventory();
  io.observed('fishing_cast_preflight', { position, direction: args.direction, rod: fresh.rod, castPowerPercent: power, maxBaitConsumed: bait, maxTackleWear: wear, tryTreasure: treasure });
  const result = await io.call('dsh_fish', { position, rodSlot: args.rodSlot, expectedRodItemId: args.expectedRodItemId,
    inventoryDigest: fresh.state.inventoryDigest, gearDigest: fresh.rod.gearDigest, direction: args.direction, durationMs,
    expectedGear: args.expectedGear, castPowerPercent: power, tryTreasure: treasure, maxBaitConsumed: bait, maxTackleWear: wear });
  io.observed('fishing_native_receipt', result);
  requireFact(result.completedWorkflow === true && result.nativeIdle === true && ['caught', 'escaped', 'nothing_caught', 'invalid_cast'].includes(result.outcome)
    && Array.isArray(result.itemGains) && integer(result.baitConsumed, 0, bait) && Array.isArray(result.tackleWear)
    && result.tackleWear.every((entry: ObjectValue) => integer(entry.uses, 0, wear)), '单次原生结束、渔获或资源收据不完整，没有重新抛竿。');
  const afterRod = (await readRod(io, args.rodSlot, args.expectedRodItemId)).rod;
  const sameGear = (left: unknown, right: ObjectValue[]): boolean => Array.isArray(left) && left.length === right.length
    && left.every((row: ObjectValue, index: number) => object(row) && row.index === right[index].index && row.itemId === right[index].itemId
      && row.quality === right[index].quality && row.stack === right[index].stack && row.uses === right[index].uses);
  requireFact(object(result.fishing) && sameGear(result.fishing.beforeGear, fresh.rod.attachments) && sameGear(result.fishing.afterGear, afterRod.attachments), '原生前后耗材收据与独立渔具查询不一致，不能开始下一竿。');
  const after = await io.inventory(), event = await io.call('dsh_query_event', {}), current = io.port.current();
  requireFact(current.player.canMove && !current.ui.menuOpen && samePosition(current.player.position, position)
    && event.bobberBar === null && event.fishingRod?.isFishing === false && event.fishingRod?.isReeling === false && event.fishingRod?.showingTreasure === false, '新查询未确认回到同一站位的可操作世界，不能开始下一竿。');
  for (const gain of result.itemGains) {
    requireFact(qualified(gain.itemId) && integer(gain.quality, 0, 4) && Number.isSafeInteger(gain.amount) && gain.amount > 0
      && io.count(after, gain.itemId, gain.quality) - io.count(before, gain.itemId, gain.quality) === gain.amount, '原生渔获收据与新MCP背包增量不一致。');
  }
  requireFact(result.outcome !== 'caught' || result.itemGains.length > 0, '没有实际入袋物品，未宣称钓获。');
  io.observed('fishing_attempt_completed', { outcome: result.outcome, itemGains: result.itemGains, baitConsumed: result.baitConsumed, tackleWear: result.tackleWear,
    note: '仅该次尝试完成；escaped/nothing_caught/invalid_cast均非钓获，鱼种条件及特殊奖励另行适配。' });
}

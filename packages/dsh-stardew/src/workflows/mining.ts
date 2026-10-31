import { object, positionOf, requireFact, samePosition, type ObjectValue, type Position, type WorkflowIO } from '../workflow-context.js';
import { inventoryDelta, verifyNativeInventory } from './inventory-receipt.js';

const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const qualified = (v: unknown): v is string => typeof v === 'string' && /^\([A-Za-z]+\)[^\s\x00-\x1f]{1,128}$/.test(v);
const ref = (v: unknown): v is { value: string } => object(v) && typeof v.value === 'string' && v.value.length > 0 && v.value.length <= 512 && !v.value.includes('\0');
const near = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.001;
const positionSchema = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: {
  locationId: { type: 'string' }, x: { type: 'integer', minimum: 0, maximum: 255 }, y: { type: 'integer', minimum: 0, maximum: 255 },
} };
export const MINING_WORKFLOW = {
  name: 'mine_excavate', title: '普通矿石开采与敲石找现有出口', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_mine', 'stardew_query_world', 'stardew_query_inventory', 'stardew_navigate', 'stardew_equip', 'stardew_use_tool'],
  parameters: { type: 'object', additionalProperties: false, required: ['mode', 'fromLevel', 'pickaxeSlot', 'expectedPickaxeItemId', 'expectedUpgradeLevel', 'maxStones', 'maxSwings', 'maxEnergyLoss', 'energyReserve', 'healthFloor', 'maxHealthLoss'], properties: {
    mode: { type: 'string', enum: ['find_exit', 'break_targets'] }, fromLevel: { type: 'integer', minimum: 1, maximum: 1000000 },
    pickaxeSlot: { type: 'integer', minimum: 0, maximum: 255 }, expectedPickaxeItemId: { type: 'string' }, expectedUpgradeLevel: { type: 'integer', minimum: 0, maximum: 4 },
    maxStones: { type: 'integer', minimum: 1, maximum: 32 }, maxSwings: { type: 'integer', minimum: 1, maximum: 64 },
    maxEnergyLoss: { type: 'number', minimum: 0, maximum: 1000 }, energyReserve: { type: 'number', minimum: 30, maximum: 5000 },
    healthFloor: { type: 'integer', minimum: 20, maximum: 1000 }, maxHealthLoss: { type: 'integer', minimum: 0, maximum: 1000 },
    searchRadius: { type: 'integer', minimum: 1, maximum: 64, default: 24 }, waitForDrops: { type: 'boolean', default: true },
    targets: { type: 'array', minItems: 1, maxItems: 8, description: '仅break_targets；当前实际岩石实例，不接受旧地图重放', items: {
      type: 'object', additionalProperties: false, required: ['position', 'targetKey', 'itemId', 'quality'], properties: {
        position: positionSchema, targetKey: { type: 'string' }, itemId: { type: 'string' }, quality: { type: 'integer', minimum: 0, maximum: 4 },
      },
    } },
  } },
  scope: '当前同一原生矿层内的普通单格Stone，实际拥有的普通原生镐；找梯模式优先已有下梯/竖井，不自行下层。复用MCP原生单次零蓄力工具生命周期与实际OpaqueRef；耐久、碎石统计、完整背包、掉落实例和新出口分别核对。排除资源团/怪物伪装/自定义镐与附魔；不模拟RNG或制造掉落/矿梯。',
  postconditions: ['真实矿层/工具实例与最新Native岩石、MCP单格实体Ref对应，替换或受阻停止', '每次恰好一次原生挥镐，部分耐久下降与破碎消失/统计+1分开；生成矿层计数同步-1', '新MCP全背包与Native数量相符，只报告实际非负入袋变化，掉落消失不推断产物归因', '有目的的掉落等待有界；缺梯、需战斗、无可用目标或预算不足waiting，不冒充全部挖完/探完'],
};

interface Frame { query: ObjectValue; mining: ObjectValue; state: ObjectValue; tool: ObjectValue; inventory: ObjectValue; targetRef?: { value: string } }
export async function mineExcavate(args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  requireFact(object(args) && Object.keys(args).every(k => ['mode', 'fromLevel', 'pickaxeSlot', 'expectedPickaxeItemId', 'expectedUpgradeLevel', 'maxStones', 'maxSwings', 'maxEnergyLoss', 'energyReserve', 'healthFloor', 'maxHealthLoss', 'searchRadius', 'waitForDrops', 'targets'].includes(k))
    && ['find_exit', 'break_targets'].includes(args.mode) && int(args.fromLevel, 1, 1000000) && int(args.pickaxeSlot, 0, 255)
    && qualified(args.expectedPickaxeItemId) && int(args.expectedUpgradeLevel, 0, 4) && int(args.maxStones, 1, 32) && int(args.maxSwings, 1, 64)
    && Number.isFinite(args.maxEnergyLoss) && args.maxEnergyLoss >= 0 && args.maxEnergyLoss <= 1000 && Number.isFinite(args.energyReserve) && args.energyReserve >= 30 && args.energyReserve <= 5000
    && int(args.healthFloor, 20, 1000) && int(args.maxHealthLoss, 0, 1000) && (args.waitForDrops === undefined || typeof args.waitForDrops === 'boolean')
    && int(args.searchRadius ?? 24, 1, 64), 'mine_excavate需要明确模式/楼层/真实镐和有限石头、挥镐、体力/生命预算。');
  const targets = args.mode === 'break_targets' ? args.targets : [];
  requireFact(args.mode === 'find_exit' ? args.targets === undefined : Array.isArray(targets) && targets.length >= 1 && targets.length <= 8, 'break_targets必须指定1–8个实际岩石；找梯不接受额外目标。');
  const fixed: ObjectValue[] = (targets as unknown[]).map((t: unknown) => {
    requireFact(object(t) && Object.keys(t).every(k => ['position', 'targetKey', 'itemId', 'quality'].includes(k)) && key(t.targetKey) && qualified(t.itemId) && int(t.quality, 0, 4), '明确矿石目标必须带实际实例、ID和品质。');
    return { ...t, position: positionOf(t.position) };
  });
  requireFact(new Set(fixed.map((t: ObjectValue) => t.targetKey)).size === fixed.length, '不能重复矿石实例。');
  io.needs(MINING_WORKFLOW.requiredTools); io.ready();
  const initial = io.port.current(), location = initial.player.position.locationId;
  let lastHealth = initial.player.health, lastEnergy = initial.player.energy, healthUsed = 0, energyUsed = 0, swings = 0, broken = 0;
  let locationKey = '', gearDigest = '';
  const completed = new Set<string>();
  const account = () => {
    const s = io.port.current(); healthUsed += Math.max(0, lastHealth - s.player.health); energyUsed += Math.max(0, lastEnergy - s.player.energy);
    lastHealth = s.player.health; lastEnergy = s.player.energy;
    requireFact(s.player.position.locationId === location && s.player.health >= args.healthFloor && s.player.energy + 0.001 >= args.energyReserve
      && healthUsed <= args.maxHealthLoss && energyUsed <= args.maxEnergyLoss + 0.001, '同层位置、观察生命/体力预算或资源预留已触及；恢复不返额度。');
  };
  const read = async (position?: Position): Promise<Frame> => {
    const qargs = { miningRadius: args.searchRadius ?? 24, offset: 0, limit: 100, ...(position ? { position } : {}) };
    const first = await io.call('dsh_query_mine', qargs); account();
    const inventory = await io.inventory(); account();
    let entity: ObjectValue | undefined;
    if (position) {
      const world = (await io.call('stardew_query_world', { area: { ...position, width: 1, height: 1 }, includeEntities: true, includeCharacters: true, includeTiles: true, maxEntities: 64, maxCharacters: 64 })).snapshot;
      account();
      requireFact(object(world) && Array.isArray(world.entities) && world.entitiesTruncated === false && Array.isArray(world.characters) && world.charactersTruncated === false
        && !world.characters.some((c: ObjectValue) => samePosition(c.position, position)), '目标实体或角色占用不完整。');
      const matches = world.entities.filter((e: ObjectValue) => samePosition(e.position, position));
      requireFact(matches.length <= 1, '单格出现多目标/地形，不挥镐。'); entity = matches[0];
    }
    const query = await io.call('dsh_query_mine', qargs); account();
    const m = query.mining, s = m?.state, t = query.travel;
    requireFact(object(first.mining) && object(m) && m.available === true && m.complete === true && m.debrisComplete === true && object(s)
      && key(s.locationKey) && (!locationKey || s.locationKey === locationKey) && s.level === args.fromLevel && s.locationId === location
      && first.mining.state?.locationKey === s.locationKey && first.mining.rockSetDigest === m.rockSetDigest && sha(m.rockSetDigest)
      && first.mining.state?.inventoryDigest === s.inventoryDigest && sha(s.inventoryDigest) && m.usingTool === false
      && s.canMove === true && s.menuType === null && s.eventUp === false && s.fading === false
      && int(m.rockCount, 0, 16384) && int(m.rocksCrushed, 0, 4294967295) && int(m.miningExperience, 0, 2147483647)
      && int(m.stonesLeftOnLevel, 0, 1000000) && typeof m.generatedLevel === 'boolean' && typeof m.mustKillAllMonsters === 'boolean'
      && Array.isArray(m.items) && m.items.length <= 100 && Array.isArray(m.pickaxes) && Array.isArray(m.debris) && m.debris.length <= 2048
      && t?.available === true && t.complete === true && t.state?.locationKey === s.locationKey && Array.isArray(t.exits), '矿层/石头/工具/掉落的完整原生观察不一致或不受支持。');
    requireFact(near(io.port.current().player.energy, s.energy) && io.port.current().player.health === s.health && io.port.current().player.money === String(s.money), 'MCP主角资源与Native观察不一致。');
    verifyNativeInventory(inventory, s.inventoryCounts);
    const tool = m.pickaxes.find((p: ObjectValue) => p.slot === args.pickaxeSlot);
    const slot = inventory.slots.find((p: ObjectValue) => p.index === args.pickaxeSlot)?.item;
    requireFact(object(tool) && key(tool.toolKey) && sha(tool.gearDigest) && (!gearDigest || tool.gearDigest === gearDigest) && tool.nativeEnchantmentsOnly === true
      && tool.itemId === args.expectedPickaxeItemId && tool.upgradeLevel === args.expectedUpgradeLevel && int(tool.damagePerSwing, 1, 69)
      && Number.isFinite(tool.energyReservePerSwing) && tool.energyReservePerSwing >= 0 && tool.energyReservePerSwing <= 2
      && slot?.qualifiedItemId === tool.itemId && slot.tool === true && slot.toolKind === 'pickaxe' && slot.toolLevel === tool.upgradeLevel && ref(slot.ref), '实际原生镐、附魔、功率或独立MCP工具槽/Ref变化。');
    for (const d of m.debris) requireFact(object(d) && key(d.key) && int(d.chunks, 0, 2048) && typeof d.collectible === 'boolean', '原生掉落实例或完整数量未知。');
    const rock = m.target?.rock;
    if (position && rock) requireFact(entity && ref(entity.ref) && entity.kind === 'resource_node' && entity.resourceNode?.requiredTool === 'pickaxe'
      && entity.resourceNode.hitsToDestroy === rock.durability, '真实矿石与MCP原生资源节点Ref/耐久不一致，未合成Ref。');
    locationKey ||= s.locationKey; gearDigest ||= tool.gearDigest;
    return { query, mining: m, state: s, tool, inventory, targetRef: position && rock && entity ? entity.ref : undefined };
  };
  const rockValid = (r: any) => object(r) && key(r.targetKey) && sha(r.digest) && qualified(r.itemId) && int(r.quality, 0, 4) && int(r.durability, 0, 1000000)
    && typeof r.blocked === 'boolean' && r.locationId === location && int(r.x, 0, 255) && int(r.y, 0, 255);
  const exitFound = (f: Frame) => f.query.travel.exits.some((e: ObjectValue) => ['descend', 'shaft'].includes(e.kind) && e.blocked === false);
  const gains = (before: Frame, after: Frame) => {
    const changes = [...inventoryDelta(before.inventory, after.inventory)].map(([k, amount]) => { const [itemId, quality] = JSON.parse(k); return { itemId, quality, amount }; });
    requireFact(changes.every(c => c.amount >= 0) && after.state.money >= before.state.money, '开采/等待中出现未批准的物品或金币减少。');
    return changes;
  };
  let latest = await read();
  io.observed('mining_preflight', { mode: args.mode, fromLevel: args.fromLevel, maxStones: args.maxStones, maxSwings: args.maxSwings, healthFloor: args.healthFloor, maxHealthLoss: args.maxHealthLoss, energyReserve: args.energyReserve, maxEnergyLoss: args.maxEnergyLoss });
  const waiting = (reason: string) => { io.observed('mining_waiting', { reason, swings, broken, healthUsed, energyUsed, explorationCompleted: false }); return 'waiting' as const; };
  while (swings < args.maxSwings && broken < args.maxStones) {
    io.ready(location); account();
    if (args.mode === 'find_exit' && exitFound(latest)) { io.observed('mining_exit_observed', { level: args.fromLevel, swings, broken, alreadyExistedBeforeMining: swings === 0, traversed: false }); return 'completed'; }
    if (args.mode === 'find_exit' && latest.mining.mustKillAllMonsters) return waiting('native_monster_clearance_required');
    if (args.mode === 'break_targets' && completed.size === fixed.length) return 'completed';
    if ((io.port.remainingActions?.() ?? 0) < 5) return waiting('reserve_navigation_swing_equip_and_exit_actions');
    if (energyUsed + latest.tool.energyReservePerSwing > args.maxEnergyLoss + 0.001 || lastEnergy - latest.tool.energyReservePerSwing + 0.001 < args.energyReserve) return waiting('next_swing_energy_reserve');
    let target: ObjectValue;
    if (args.mode === 'break_targets') {
      const requested = fixed.find((t: ObjectValue) => !completed.has(t.targetKey))!;
      const f = await read(requested.position), r = f.mining.target?.rock;
      requireFact(rockValid(r) && r.targetKey === requested.targetKey && r.itemId === requested.itemId && r.quality === requested.quality && r.blocked === false, '明确原岩石已消失/替换或受阻，不能把缺失当本次开采成功。'); target = r;
    } else {
      const eligible = latest.mining.items.filter((r: any) => rockValid(r) && r.blocked === false);
      if (!eligible.length) return waiting(latest.mining.nextOffset === null ? 'no_eligible_stone_in_radius' : 'candidate_page_requires_fresh_planning');
      target = eligible[0];
    }
    const position = positionOf(target);
    if (Math.abs(io.port.current().player.position.x - position.x) + Math.abs(io.port.current().player.position.y - position.y) !== 1) {
      await io.call('stardew_navigate', { position, arrival: 'adjacent' }); account();
    }
    let before = await read(position); io.ready(location);
    requireFact(rockValid(before.mining.target?.rock) && before.mining.target.rock.targetKey === target.targetKey && before.mining.target.rock.digest === target.digest, '导航后的原石头或耐久/受阻状态变化。');
    if (before.mining.selectedSlot !== args.pickaxeSlot) {
      const slot = before.inventory.slots.find((s: ObjectValue) => s.index === args.pickaxeSlot).item;
      await io.call('stardew_equip', { itemRef: slot.ref, inventoryRevision: before.inventory.inventoryRevision }); account(); before = await read(position);
    }
    requireFact(before.mining.selectedSlot === args.pickaxeSlot && before.mining.target?.rock?.targetKey === target.targetKey && before.mining.target.rock.digest === target.digest
      && ref(before.targetRef) && (io.port.remainingActions?.() ?? 0) >= 3, '装备后目标/镐/Ref或原日退出预留不一致。');
    if (energyUsed + before.tool.energyReservePerSwing > args.maxEnergyLoss + 0.001 || lastEnergy - before.tool.energyReservePerSwing + 0.001 < args.energyReserve) return waiting('next_swing_energy_reserve');
    // The audited upstream revalidates this actual opaque entity identity before
    // submitting one charge-zero BeginUsingTool. Any failure may be after impact.
    const outcome = await io.port.call('stardew_use_tool', { targetRef: before.targetRef, chargeLevel: 0 }); swings++;
    io.observed('mining_tool_receipt', { status: outcome.status, output: outcome.output, error: outcome.error });
    if (outcome.status !== 'succeeded') return io.uncertain('单次挥镐未完整返回，可能已经命中，不重放该次攻击。');
    try {
      account();
      const result = outcome.output;
      requireFact(object(result) && result.toolQualifiedItemId === args.expectedPickaxeItemId && result.chargeLevel === 0 && samePosition(result.target, position)
        && result.execution?.completionReason === 'tool_action_settled' && object(result.energy) && near(result.energy.after - result.energy.before, result.energy.delta)
        && Math.max(0, -result.energy.delta) <= before.tool.energyReservePerSwing + 0.001, '单次原生工具收据/零蓄力或能量消耗不一致。');
      let after = await read(position);
      const r = before.mining.target.rock, remaining = r.durability - before.tool.damagePerSwing, next = after.mining.target?.rock;
      const crushed = after.mining.target?.empty === true;
      requireFact(after.mining.miningExperience >= before.mining.miningExperience && (crushed
        ? remaining <= 0 && after.mining.rocksCrushed === before.mining.rocksCrushed + 1 && after.mining.rockCount === before.mining.rockCount - 1
          && after.mining.stonesLeftOnLevel === before.mining.stonesLeftOnLevel - (before.mining.generatedLevel ? 1 : 0)
        : rockValid(next) && next.targetKey === r.targetKey && next.itemId === r.itemId && next.quality === r.quality && remaining > 0 && next.durability === remaining
          && after.mining.rocksCrushed === before.mining.rocksCrushed && after.mining.rockCount === before.mining.rockCount && after.mining.stonesLeftOnLevel === before.mining.stonesLeftOnLevel), '原岩石耐久变化/准确破碎消失或统计/矿层计数未确认。');
      const observedGains = gains(before, after);
      io.observed('mining_strike_verified', { position, itemId: r.itemId, quality: r.quality, beforeDurability: r.durability, afterDurability: crushed ? null : next.durability,
        crushed, miningExperienceBefore: before.mining.miningExperience, miningExperienceAfter: after.mining.miningExperience,
        inventoryGains: observedGains, goldGain: after.state.money - before.state.money, pickupAttributionVerified: false, healthUsed, energyUsed });
      if (crushed) { broken++; completed.add(r.targetKey); }
      const old = new Set(before.mining.debris.map((d: ObjectValue) => d.key));
      const pending = new Set<string>(after.mining.debris.filter((d: ObjectValue) => d.collectible && d.chunks > 0 && !old.has(d.key)).map((d: ObjectValue) => d.key));
      requireFact(pending.size <= 64, '新掉落实例过多，不能假装完整等待。');
      if (args.waitForDrops !== false && pending.size) {
        for (let attempt = 0; attempt < 8 && pending.size; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 200)); // Bounded native pickup settling, no collection call or game write.
          const observed = await read(position), gained = gains(after, observed);
          if (gained.length || observed.state.money !== after.state.money) io.observed('mining_pickup_observed', { inventoryGains: gained,
            goldGain: observed.state.money - after.state.money, pickupAttributionVerified: false });
          for (const id of pending) if (!observed.mining.debris.some((d: ObjectValue) => d.key === id && d.chunks > 0)) pending.delete(id);
          after = observed;
        }
        if (pending.size) { io.observed('mining_drop_waiting', { pendingObservedDropInstances: pending.size, broken, swings, pickupAttributionVerified: false }); return 'waiting'; }
      }
      latest = after;
    } catch { return io.uncertain('挥镐后的独立原石耐久/统计/物品/资源或掉落观察未确认；不重复已经可能生效的攻击。'); }
  }
  if (args.mode === 'find_exit' && exitFound(latest)) { io.observed('mining_exit_observed', { level: args.fromLevel, swings, broken, alreadyExistedBeforeMining: false, traversed: false }); return 'completed'; }
  if (args.mode === 'break_targets' && completed.size === fixed.length) return 'completed';
  return waiting('bounded_stone_or_swing_budget_reached');
}

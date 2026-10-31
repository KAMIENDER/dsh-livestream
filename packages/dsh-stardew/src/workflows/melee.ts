import { object, positionOf, requireFact, samePosition, type ObjectValue, type Position, type WorkflowIO } from '../workflow-context.js';
import { inventoryDelta, verifyInventoryChanges, verifyNativeInventory } from './inventory-receipt.js';

const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const qualified = (v: unknown): v is string => typeof v === 'string' && /^\([A-Za-z]+\)[^\s\x00-\x1f]{1,128}$/.test(v);
const ref = (v: unknown): v is { value: string } => object(v) && typeof v.value === 'string' && v.value.length > 0 && v.value.length <= 512 && !v.value.includes('\0');
const near = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.001;
const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y);
const families = ['stabbing_sword', 'dagger', 'club', 'defense_sword'];
const life = (v: unknown): v is ObjectValue => object(v) && int(v.deathAnimationCounter, 0, 2147483647)
  && (v.mummyReviveTimerMs === null || int(v.mummyReviveTimerMs, -1000000, 1000000));
const mummy = 'StardewValley.Monsters.Mummy';
/** Recheck the native receipt's exact instance-lifecycle rule. A global kill
 * delta, removal or animation alone never becomes a death claim. */
export function verifyDeath(r: ObjectValue, targetType: string, allowCollapsedMummy = false): void {
  requireFact(life(r.targetLifeBefore) && life(r.targetLifeAfter) && r.targetLifeAfter.deathAnimationCounter >= r.targetLifeBefore.deathAnimationCounter
    && typeof r.targetDeathVerified === 'boolean' && typeof r.targetCollapsedForRevival === 'boolean', '缺少原生怪物生命周期收据。');
  if (r.targetDeathVerified) {
    requireFact(r.targetPresent === false && r.targetHealthAfter <= 0 && r.monstersKilledDelta > 0 && r.targetCollapsedForRevival === false
      && (r.targetDeathProofRule === 'native_mummy_terminal_removal' ? targetType === mummy
        && r.targetLifeBefore.mummyReviveTimerMs !== null && (allowCollapsedMummy || r.targetLifeBefore.mummyReviveTimerMs <= 0) && r.targetLifeAfter.mummyReviveTimerMs !== null
        : r.targetDeathProofRule === 'native_death_event_and_terminal_removal' && targetType !== mummy
          && r.targetLifeAfter.deathAnimationCounter === r.targetLifeBefore.deathAnimationCounter + 1), '目标死亡未满足准确的原生事件/最终移除规则。');
  } else requireFact(r.targetDeathProofRule === null, '未确认死亡不能带已确认规则。');
  if (r.targetCollapsedForRevival) requireFact(targetType === mummy && r.targetPresent === true && r.targetHealthAfter > 0
    && r.targetDeathVerified === false && r.targetLifeBefore.mummyReviveTimerMs !== null && r.targetLifeBefore.mummyReviveTimerMs <= 0
    && r.targetLifeAfter.mummyReviveTimerMs > 0 && r.targetLifeAfter.deathAnimationCounter === r.targetLifeBefore.deathAnimationCounter + 1, '木乃伊倒地/复活计时与死亡标记冲突。');
}
const positionSchema = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: {
  locationId: { type: 'string', minLength: 1, maxLength: 128 }, x: { type: 'integer', minimum: 0, maximum: 10000 }, y: { type: 'integer', minimum: 0, maximum: 10000 },
} };
export const MELEE_WORKFLOW = {
  name: 'melee_engage', title: '固定目标近战、击败观察与明确撤退', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_mine', 'dsh_melee', 'stardew_query_inventory', 'stardew_equip', 'stardew_navigate'],
  parameters: { type: 'object', additionalProperties: false,
    required: ['targetKey', 'expectedTargetType', 'expectedDeathAnimationCounter', 'weaponSlot', 'expectedWeaponItemId', 'expectedFamily', 'maxActions', 'maxApproaches', 'maxSpecials', 'maxChaseTiles', 'healthFloor', 'maxHealthLoss'], properties: {
      targetKey: { type: 'string', pattern: '^[a-f0-9]{32}$' }, expectedTargetType: { type: 'string', minLength: 1, maxLength: 256 },
      expectedDeathAnimationCounter: { type: 'integer', minimum: 0, maximum: 2147483647, description: '当前查询的原生生命周期计数；倒地/复活后不把旧批准套到新生命阶段' },
      objective: { type: 'string', enum: ['actions', 'defeat_target'], default: 'actions', description: 'actions完成有限动作批次；defeat_target仅该实例满足原生死亡/最终移除规则才completed，额度用完仍活着则waiting' },
      weaponSlot: { type: 'integer', minimum: 0, maximum: 255 }, expectedWeaponItemId: { type: 'string' }, expectedFamily: { type: 'string', enum: families },
      maxActions: { type: 'integer', minimum: 1, maximum: 32, description: '普攻或一次原生特殊招式各计1次；特殊招式可原生多段/范围攻击，不承诺只伤目标' },
      maxApproaches: { type: 'integer', minimum: 0, maximum: 4 }, maxSpecials: { type: 'integer', minimum: 0, maximum: 4, description: '明确允许的特殊招式次数，0只用普攻；仅真实冷却已结束时选用' },
      maxChaseTiles: { type: 'integer', minimum: 1, maximum: 16, description: '每次读取时目标与主角须在本批起点的此半径内，不跨地点追击；尚无原生导航逐帧边界监视，不证明途中路线始终处于该半径' },
      healthFloor: { type: 'integer', minimum: 20, maximum: 1000 }, maxHealthLoss: { type: 'integer', minimum: 0, maximum: 1000 },
      retreatAtHealth: { type: 'integer', minimum: 21, maximum: 1000, description: '有retreatTo时必填且大于healthFloor；到阈值先尝试明确同地点退点，不能保证可达或无伤' },
      retreatTo: positionSchema,
    } },
  scope: '当前同地点、固定原生怪物实例/完整类型/生命周期计数和实际非镰刀近战武器。有限接近、原生普攻/特殊、冷却与8帧空闲，独立背包/资源核对。defeat_target须同实例原生死亡事件+最终移除或准确木乃伊规则；普通动作批次、倒地待复活、死亡与清层/伤害/掉落归因分开。弹弓、其他未识别生命周期、全怪物战术/避障和完整返家仍缺。',
  postconditions: ['固定目标和武器不按最近怪物、名字或槽位替换；原生动作接受和观察到的伤害分开', '原日预算与pending检查点不重领，普攻/特殊/接近次数及每帧观察生命损失有界，恢复不返还损失额度', '完整原生怪物列表、全背包与MCP独立数量、金币/生命核对；范围攻击附带变化单列，不作伤害/拾取因果保证', '明确退点只走一次并查真实到达；失去目标、无伤进展、预算/范围不足waiting，未知停止接管且不重放'],
};

interface Frame { query: ObjectValue; state: ObjectValue; weapon: ObjectValue; inventory: ObjectValue; target?: ObjectValue }
export async function meleeEngage(args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  requireFact(object(args) && Object.keys(args).every(k => ['targetKey', 'expectedTargetType', 'expectedDeathAnimationCounter', 'objective', 'weaponSlot', 'expectedWeaponItemId', 'expectedFamily', 'maxActions', 'maxApproaches', 'maxSpecials', 'maxChaseTiles', 'healthFloor', 'maxHealthLoss', 'retreatAtHealth', 'retreatTo'].includes(k))
    && key(args.targetKey) && typeof args.expectedTargetType === 'string' && /^StardewValley\.Monsters\.[A-Za-z0-9_+.`]{1,220}$/.test(args.expectedTargetType)
    && int(args.expectedDeathAnimationCounter, 0, 2147483647) && (args.objective === undefined || ['actions', 'defeat_target'].includes(args.objective))
    && int(args.weaponSlot, 0, 255) && qualified(args.expectedWeaponItemId) && families.includes(args.expectedFamily)
    && int(args.maxActions, 1, 32) && int(args.maxApproaches, 0, 4) && int(args.maxSpecials, 0, Math.min(4, args.maxActions)) && int(args.maxChaseTiles, 1, 16)
    && int(args.healthFloor, 20, 1000) && int(args.maxHealthLoss, 0, 1000), 'melee_engage需要真实怪物/武器身份和有限动作、接近、特殊招式、追击半径与生命预算。');
  const retreat = args.retreatTo === undefined ? undefined : positionOf(args.retreatTo);
  const objective = args.objective ?? 'actions';
  requireFact(retreat ? int(args.retreatAtHealth, args.healthFloor + 1, 1000) : args.retreatAtHealth === undefined, '退点与高于生命硬下限的撤退阈值必须同时明确。');
  if (retreat) requireFact(Object.keys(args.retreatTo).every(k => ['locationId', 'x', 'y'].includes(k)), '退点只接受明确位置。');
  io.needs(MELEE_WORKFLOW.requiredTools); io.ready();
  const start = { ...io.port.current().player.position }, location = start.locationId;
  requireFact(!retreat || retreat.locationId === location && distance(start, retreat) <= args.maxChaseTiles, '退点必须是同地点且处于本批明确半径内。');
  let healthUsed = 0, lastHealth = io.port.current().player.health, actions = 0, approaches = 0, specials = 0, noDamage = 0;
  let locationKey = '', weaponKey = '', gearDigest = '';
  let lastInventory: ObjectValue | undefined, lastMoney: number | undefined;
  const account = () => {
    const s = io.port.current(); healthUsed += Math.max(0, lastHealth - s.player.health); lastHealth = s.player.health;
    requireFact(s.player.position.locationId === location && s.player.health >= args.healthFloor && healthUsed <= args.maxHealthLoss
      && distance(start, s.player.position) <= args.maxChaseTiles, '地点、追击半径或观察生命预算已触及；恢复不返还额度，停止新攻击。');
  };
  const read = async (): Promise<Frame> => {
    const first = (await io.call('dsh_query_mine', {})).combat; account();
    const inventory = await io.inventory(); account();
    const q = (await io.call('dsh_query_mine', {})).combat; account();
    requireFact(object(first) && object(first.state) && object(q) && q.available === true && q.complete === true && object(q.state), '没有完整当前原生近战事实。');
    const s = q.state, player = io.port.current().player;
    requireFact(key(s.locationKey) && (!locationKey || s.locationKey === locationKey) && s.locationId === location && first.state.locationKey === s.locationKey
      && sha(s.inventoryDigest) && first.state.inventoryDigest === s.inventoryDigest && first.state.money === s.money
      && s.canMove === true && s.menuType === null && s.eventUp === false && s.fading === false && q.poseReady === true && q.usingTool === false && q.pauseForAnimation === false
      && int(s.health, 1, 1000) && int(s.money, 0, 2147483647) && player.health === s.health && near(player.energy, s.energy)
      && player.money === String(s.money) && samePosition(player.position, positionOf(s.position))
      && Array.isArray(q.weapons) && Array.isArray(q.monsters) && q.monsters.length <= 128 && int(q.monstersKilled, 0, 4294967295), '原生与独立主角/背包/地点或空闲状态不一致。');
    verifyNativeInventory(inventory, s.inventoryCounts);
    // Waiting for hit invulnerability also advances real game time. Do not
    // silently adopt an unexplained loss between two otherwise valid captures.
    if (lastInventory) requireFact([...inventoryDelta(lastInventory, inventory).values()].every(v => v >= 0)
      && lastMoney !== undefined && s.money >= lastMoney, '两次近战观察之间出现未批准物品或金币减少。');
    requireFact(q.monsters.every((m: unknown) => object(m) && key(m.targetKey) && m.native === true && typeof m.type === 'string'
      && int(m.health, -2147483648, 2147483647) && int(m.maxHealth, 1, 2147483647) && int(m.invincibleCountdown, -1000000, 1000000)
      && life(m.lifecycle) && typeof m.meleeTargetReady === 'boolean' && (m.type !== mummy || m.lifecycle.mummyReviveTimerMs !== null)
      && object(m.position) && m.position.locationId === location && Number.isInteger(m.position.x) && Number.isInteger(m.position.y))
      && new Set(q.monsters.map((m: ObjectValue) => m.targetKey)).size === q.monsters.length, '怪物列表不完整、有自定义类型、重复实例或缺少状态。');
    const w = q.weapons.find((w: ObjectValue) => w.slot === args.weaponSlot);
    const slot = inventory.slots.find((s: ObjectValue) => s.index === args.weaponSlot)?.item;
    requireFact(object(w) && key(w.weaponKey) && sha(w.gearDigest) && (!weaponKey || w.weaponKey === weaponKey && w.gearDigest === gearDigest)
      && w.itemId === args.expectedWeaponItemId && w.family === args.expectedFamily && w.scythe === false && w.nativeEnchantmentsOnly === true
      && w.isOnSpecial === false && int(w.specialCooldownMs, -1000000, 1000000)
      && slot?.qualifiedItemId === w.itemId && slot.tool === true && ref(slot.ref), '原生武器/家族/附魔或独立背包实际工具Ref变化。');
    const target = q.monsters.find((m: ObjectValue) => m.targetKey === args.targetKey);
    requireFact(!target || target.type === args.expectedTargetType, '固定目标类型改变，未改打另一怪物。');
    locationKey ||= s.locationKey; weaponKey ||= w.weaponKey; gearDigest ||= w.gearDigest;
    lastInventory = inventory; lastMoney = s.money;
    return { query: q, state: s, inventory, weapon: w, target };
  };
  const gains = (before: Frame, after: Frame) => {
    const rows = [...inventoryDelta(before.inventory, after.inventory)].map(([k, amount]) => { const [itemId, quality] = JSON.parse(k); return { itemId, quality, amount }; });
    requireFact(rows.every(c => c.amount >= 0) && after.state.money >= before.state.money, '近战/移动中出现未批准物品或金币减少。'); return rows;
  };
  const waiting = (reason: string) => {
    io.observed('melee_waiting', { reason, actions, approaches, specials, healthUsed, targetDeathVerified: false, explorationCompleted: false }); return 'waiting' as const;
  };
  let latest = await read();
  requireFact(latest.target && latest.target.health > 0 && latest.target.lifecycle.deathAnimationCounter === args.expectedDeathAnimationCounter,
    '本批开始时实际目标已不在/非正血量或生命周期改变，不能把旧批准套到新阶段或记为本批击杀。');
  io.observed('melee_preflight', { objective, targetType: args.expectedTargetType, expectedDeathAnimationCounter: args.expectedDeathAnimationCounter,
    weaponItemId: args.expectedWeaponItemId, family: args.expectedFamily,
    maxActions: args.maxActions, maxApproaches: args.maxApproaches, maxSpecials: args.maxSpecials, maxChaseTiles: args.maxChaseTiles,
    healthFloor: args.healthFloor, maxHealthLoss: args.maxHealthLoss, retreatTo: retreat ?? null, retreatAtHealth: args.retreatAtHealth ?? null });
  while (actions < args.maxActions) {
    io.ready(location); account();
    if (retreat && lastHealth <= args.retreatAtHealth) {
      if ((io.port.remainingActions?.() ?? 0) < 3) return waiting('insufficient_original_budget_for_retreat_and_exit_reserve');
      const before = latest;
      await io.call('stardew_navigate', { position: retreat, arrival: 'exact' });
      try {
        latest = await read(); gains(before, latest);
        requireFact(samePosition(positionOf(latest.state.position), retreat), '明确退点没有实际到达。');
        io.observed('melee_retreat_observed', { destination: retreat, healthBefore: before.state.health, healthAfter: latest.state.health,
          healthUsed, targetStillPresent: !!latest.target, safeEscapeVerified: false, inventoryGains: gains(before, latest), goldGain: latest.state.money - before.state.money });
      } catch { return io.uncertain('撤退移动已提交，但明确到达/资源收据未确认；不重走或继续攻击。'); }
      return waiting('explicit_retreat_destination_reached');
    }
    if (!latest.target || latest.target.health <= 0) return waiting('pinned_target_removed_or_inactive_death_not_proven');
    if (latest.target.lifecycle.deathAnimationCounter !== args.expectedDeathAnimationCounter) return waiting('pinned_lifecycle_changed_replan_required');
    if (!latest.target.meleeTargetReady) return waiting('native_mummy_collapsed_or_reviving_requires_replanning');
    if (healthUsed >= args.maxHealthLoss && args.maxHealthLoss > 0) return waiting('observed_health_loss_budget_reached');
    if (distance(start, positionOf(latest.target.position)) > args.maxChaseTiles) return waiting('pinned_target_left_approved_radius');
    const reserve = latest.query.selectedSlot === args.weaponSlot ? 3 : 4;
    if ((io.port.remainingActions?.() ?? 0) < reserve) return waiting('reserve_equip_action_and_two_exit_actions');
    if (distance(positionOf(latest.state.position), positionOf(latest.target.position)) > 2.5) {
      if (approaches >= args.maxApproaches) return waiting('bounded_approaches_used');
      if ((io.port.remainingActions?.() ?? 0) < reserve + 1) return waiting('reserve_approach_equip_action_and_two_exit_actions');
      const before = latest, position = positionOf(latest.target.position);
      await io.call('stardew_navigate', { position, arrival: 'adjacent' }); approaches++;
      try { latest = await read(); gains(before, latest); }
      catch { return io.uncertain('接近原目标后的地点/资源未完整确认；不继续追击或攻击。'); }
      continue; // Re-evaluate the same moving instance, retreat threshold and radius.
    }
    if (latest.query.selectedSlot !== args.weaponSlot) {
      const slot = latest.inventory.slots.find((s: ObjectValue) => s.index === args.weaponSlot).item, before = latest;
      await io.call('stardew_equip', { itemRef: slot.ref, inventoryRevision: latest.inventory.inventoryRevision });
      try { latest = await read(); gains(before, latest); requireFact(latest.query.selectedSlot === args.weaponSlot, '实际武器没有选中。'); }
      catch { return io.uncertain('装备后的真实武器/资源没有完整确认，未提交攻击。'); }
      continue;
    }
    // Observe native hit invulnerability briefly, without consuming more swings
    // or inferring that a currently invulnerable target must be unkillable.
    let waits = 0;
    while (latest.target && latest.target.health > 0 && latest.target.invincibleCountdown > 0 && waits++ < 12) {
      await new Promise(resolve => setTimeout(resolve, 100)); latest = await read();
      if (retreat && lastHealth <= args.retreatAtHealth) break;
    }
    if ((retreat && lastHealth <= args.retreatAtHealth) || !latest.target || latest.target.health <= 0) continue;
    if (latest.target.lifecycle.deathAnimationCounter !== args.expectedDeathAnimationCounter || !latest.target.meleeTargetReady) continue;
    if (latest.target.invincibleCountdown > 0) return waiting('native_target_hit_invulnerability_not_finished');
    if (healthUsed >= args.maxHealthLoss && args.maxHealthLoss > 0) return waiting('observed_health_loss_budget_reached');
    if (distance(start, positionOf(latest.target.position)) > args.maxChaseTiles) return waiting('pinned_target_left_approved_radius');
    if (distance(positionOf(latest.state.position), positionOf(latest.target.position)) > 2.5) continue;
    if ((io.port.remainingActions?.() ?? 0) < 3) return waiting('reserve_native_action_and_two_exit_actions');
    const before = latest, mode = specials < args.maxSpecials && before.weapon.specialCooldownMs <= 0 ? 'special' : 'attack';
    const budget = args.maxHealthLoss - healthUsed;
    const outcome = await io.port.call('dsh_melee', { mode, locationKey, targetKey: args.targetKey, expectedTargetType: args.expectedTargetType,
      expectedDeathAnimationCounter: args.expectedDeathAnimationCounter,
      weaponSlot: args.weaponSlot, weaponKey, expectedWeaponItemId: args.expectedWeaponItemId, gearDigest, inventoryDigest: before.state.inventoryDigest,
      expectedHealth: before.state.health, expectedMoney: before.state.money, healthFloor: args.healthFloor, maxHealthLoss: budget,
      maxRangeTiles: 2.5, maxDisplacementTiles: 3, durationMs: 6000 });
    io.observed('melee_native_receipt', { status: outcome.status, output: outcome.output, error: outcome.error });
    if (outcome.status === 'failed') return waiting('native_precondition_rejected_without_input');
    if (outcome.status !== 'succeeded' || !object(outcome.output)) return io.uncertain('近战输入结果未知，可能已经命中；不自动重打。');
    const r = outcome.output;
    if (r.completedWorkflow !== true && r.nativeActionSubmitted === false) return waiting('native_precondition_changed_before_input');
    try {
      requireFact(r.completedWorkflow === true && r.completionUncertain === false && r.mode === mode && r.nativeActionSubmitted === true && r.nativeActionAccepted === true
        && r.targetKey === args.targetKey && r.targetType === args.expectedTargetType && r.rosterComplete === true
        && r.before?.available === true && r.after?.available === true && r.before.complete === true && r.after.complete === true
        && object(r.before.state) && object(r.after.state) && r.before.state.locationKey === locationKey && r.after.state.locationKey === locationKey
        && r.before.state.health === before.state.health && r.before.state.inventoryDigest === before.state.inventoryDigest
        && int(r.observedHealthLoss, 0, budget) && int(r.after.state.health, args.healthFloor, 1000)
        && r.observedHealthLoss >= Math.max(0, before.state.health - r.after.state.health)
        && int(r.targetHealthBefore, 1, 2147483647) && int(r.targetHealthAfter, -2147483648, 2147483647) && typeof r.targetPresent === 'boolean'
        && typeof r.targetRemovedWithKillEvidence === 'boolean' && typeof r.targetDeathVerified === 'boolean' && r.targetDamageCauseVerified === false
        && int(r.monstersKilledDelta, 0, 4294967295) && Array.isArray(r.monsterChanges) && r.monsterChanges.length <= 256
        && r.monsterChanges.every((m: unknown) => object(m) && key(m.targetKey) && (m.beforeHealth === null || int(m.beforeHealth, -2147483648, 2147483647))
          && int(m.health, -2147483648, 2147483647) && typeof m.present === 'boolean')
        && new Set(r.monsterChanges.map((m: ObjectValue) => m.targetKey)).size === r.monsterChanges.length, '近战接受/空闲或原生观察收据不完整。');
      verifyDeath(r, args.expectedTargetType);
      requireFact(r.targetLifeBefore.deathAnimationCounter === args.expectedDeathAnimationCounter, '原生动作没有绑定所批准的目标生命周期。');
      healthUsed += r.observedHealthLoss; lastHealth = r.after.state.health; account();
      latest = await read();
      requireFact(latest.state.inventoryDigest === r.after.state.inventoryDigest && latest.state.health === r.after.state.health
        && near(latest.state.energy, r.after.state.energy) && latest.state.money === r.goldAfter && r.goldBefore === before.state.money
        && latest.state.money >= before.state.money && latest.state.energy + 0.001 >= before.state.energy
        && latest.query.selectedSlot === args.weaponSlot && latest.weapon.weaponKey === weaponKey
        && latest.query.monstersKilled === r.after.monstersKilled && r.after.monstersKilled - r.before.monstersKilled === r.monstersKilledDelta,
      '近战后的独立背包/资源/装备/击杀计数不一致。');
      verifyInventoryChanges(before.inventory, latest.inventory, r.inventoryChanges);
      const inventoryGains = gains(before, latest);
      const targetAfter = latest.target;
      requireFact(!!targetAfter === r.targetPresent && (!targetAfter || targetAfter.health === r.targetHealthAfter
        && targetAfter.lifecycle.deathAnimationCounter === r.targetLifeAfter.deathAnimationCounter), '原目标后续存在性、血量或生命周期变化，保留不确定结果。');
      actions++; if (mode === 'special') specials++;
      const observedDamage = Math.max(0, r.targetHealthBefore - r.targetHealthAfter);
      noDamage = observedDamage > 0 ? 0 : noDamage + (mode === 'attack' ? 1 : 0);
      io.observed('melee_action_verified', { mode, targetType: args.expectedTargetType, weaponItemId: args.expectedWeaponItemId, family: args.expectedFamily,
        targetHealthBefore: r.targetHealthBefore, targetHealthAfter: r.targetHealthAfter, targetPresent: r.targetPresent, observedDamage,
        targetRemovedWithKillEvidence: r.targetRemovedWithKillEvidence, targetDeathVerified: r.targetDeathVerified, targetDeathProofRule: r.targetDeathProofRule,
        targetCollapsedForRevival: r.targetCollapsedForRevival, targetLifeBefore: r.targetLifeBefore, targetLifeAfter: r.targetLifeAfter, targetDamageCauseVerified: false,
        monstersKilledDelta: r.monstersKilledDelta, affectedMonsterCount: r.monsterChanges.filter((m: ObjectValue) => m.beforeHealth !== m.health || !m.present).length,
        healthBefore: before.state.health, healthAfter: latest.state.health, healthUsed, inventoryGains, goldGain: latest.state.money - before.state.money,
        pickupAttributionVerified: false, explorationCompleted: false });
    } catch { return io.uncertain('单次近战已提交，但独立结果或预算未完整确认；不补打或重放。'); }
    if (r.targetDeathVerified) {
      io.observed('melee_target_defeated', { targetType: args.expectedTargetType, weaponItemId: args.expectedWeaponItemId, family: args.expectedFamily,
        proofRule: r.targetDeathProofRule, lifeBefore: r.targetLifeBefore, lifeAfter: r.targetLifeAfter,
        targetHealthAfter: r.targetHealthAfter, monstersKilledDelta: r.monstersKilledDelta,
        actions, specials, approaches, healthUsed, targetDamageCauseVerified: false, encounterCleared: false, explorationCompleted: false });
      return 'completed';
    }
    if (r.targetCollapsedForRevival) return waiting('native_mummy_collapse_is_not_terminal_death');
    if (noDamage >= 2) return waiting('two_accepted_normal_attacks_without_observed_damage_replan_required');
  }
  if (objective === 'defeat_target') return waiting('bounded_actions_used_target_not_defeated');
  io.observed('melee_batch_completed', { actions, approaches, specials, healthUsed, targetStillPresent: !!latest.target,
    targetHealth: latest.target?.health ?? null, targetDeathVerified: false, explorationCompleted: false });
  return 'completed';
}

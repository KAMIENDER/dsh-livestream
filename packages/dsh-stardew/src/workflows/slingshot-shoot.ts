import { object, positionOf, requireFact, samePosition, type ObjectValue, type WorkflowIO } from '../workflow-context.js';
import { inventoryDelta, verifyInventoryChanges, verifyNativeInventory } from './inventory-receipt.js';
import { sameSlingshotAmmo, validSlingshotAmmo } from './slingshot.js';
import { verifyDeath } from './melee.js';

const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^\([A-Za-z]+\)[^\s\x00-\x1f]{1,128}$/.test(v);
const near = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.001;
const life = (v: unknown): v is ObjectValue => object(v) && int(v.deathAnimationCounter, 0, 2147483647)
  && (v.mummyReviveTimerMs === null || int(v.mummyReviveTimerMs, -1000000, 1000000));
const mummy = 'StardewValley.Monsters.Mummy', basicProjectile = 'StardewValley.Projectiles.BasicProjectile';
const projectile = (v: unknown): v is ObjectValue => object(v) && key(v.projectileKey) && typeof v.type === 'string'
  && v.native === true && (v.itemId === null || v.itemId === '' || id(v.itemId)) && typeof v.firedByPlayer === 'boolean'
  && object(v.position) && Number.isFinite(v.position.x) && Number.isFinite(v.position.y)
  && Number.isFinite(v.xVelocity) && Number.isFinite(v.yVelocity) && typeof v.destroyMe === 'boolean' && typeof v.damagesMonsters === 'boolean'
  && (v.nativeExplodeFlag === null || typeof v.nativeExplodeFlag === 'boolean');

export const SLINGSHOT_SHOOT_WORKFLOW = {
  name: 'slingshot_shoot', title: '固定目标有限原生弹弓射击与结果观察', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_slingshot', 'dsh_query_mine', 'dsh_slingshot_shot', 'stardew_query_inventory', 'stardew_equip'],
  parameters: { type: 'object', additionalProperties: false,
    required: ['targetKey', 'expectedTargetType', 'expectedDeathAnimationCounter', 'expectedMummyCollapsed', 'slingshotSlot', 'expectedSlingshotItemId', 'toolKey', 'expectedAmmo', 'maxShots', 'healthFloor', 'maxHealthLoss'],
    properties: {
      targetKey: { type: 'string' }, expectedTargetType: { type: 'string' }, expectedDeathAnimationCounter: { type: 'integer', minimum: 0, maximum: 2147483647 },
      expectedMummyCollapsed: { type: 'boolean', description: '准确Mummy当前reviveTimerMs>0时true，其他情况false；阶段改变即使计数不变也需新规划' },
      slingshotSlot: { type: 'integer', minimum: 0, maximum: 255 }, expectedSlingshotItemId: { type: 'string' }, toolKey: { type: 'string' },
      expectedAmmo: { type: 'object', additionalProperties: false, required: ['itemId', 'quality', 'stack'], properties: {
        itemId: { type: 'string' }, quality: { type: 'integer', minimum: 0, maximum: 4 }, stack: { type: 'integer', minimum: 1, maximum: 10000 },
      } },
      maxShots: { type: 'integer', minimum: 1, maximum: 16 }, objective: { type: 'string', enum: ['shots', 'defeat_target'], default: 'shots' },
      maxRangeTiles: { type: 'integer', minimum: 1, maximum: 20, default: 12 }, maxDisplacementTiles: { type: 'integer', minimum: 0, maximum: 8, default: 2 },
      healthFloor: { type: 'integer', minimum: 20, maximum: 1000 }, maxHealthLoss: { type: 'integer', minimum: 0, maximum: 1000 }, allowExplosive: { type: 'boolean', default: false },
    } },
  scope: '固定当前原生怪物实例/生命周期、拥有的原生弹弓和明确现有弹药，1–16发上限。当前地点存在非怪物角色时不发射，未授权友伤。保持实际旧式/新版瞄准设置，原生蓄力、公开释放及准确弹丸引用的飞行结束。每发完整独立背包/资源/其他附件与目标观察。无自动装弹、追击或换目标；shots只确认有限射击，defeat_target另须终态死亡证据。',
  postconditions: ['原生蓄力就绪且只释放一次，同步观察实际新弹丸/真实所有者/弹药身份，准确消耗1份', '弹丸引用结束与目标血量/倒地/终态死亡分开；消失不冒充碰撞、命中、爆炸或伤害归因', '每发新MCP全库存和Native完整数量、其他工具附件、装备、资源及生命损失预算核对', '取消先原生结束蓄力；中断/未知停止接管不重发；原日动作预算与主人具体审核，无可复用战斗授权'],
};

interface Frame { query: ObjectValue; state: ObjectValue; sling: ObjectValue; combat: ObjectValue; inventory: ObjectValue; target?: ObjectValue }
export async function slingshotShoot(args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  requireFact(object(args) && Object.keys(args).every(k => ['targetKey', 'expectedTargetType', 'expectedDeathAnimationCounter', 'expectedMummyCollapsed', 'slingshotSlot', 'expectedSlingshotItemId', 'toolKey',
    'expectedAmmo', 'maxShots', 'objective', 'maxRangeTiles', 'maxDisplacementTiles', 'healthFloor', 'maxHealthLoss', 'allowExplosive'].includes(k))
    && key(args.targetKey) && typeof args.expectedTargetType === 'string' && /^StardewValley\.Monsters\.[A-Za-z0-9_+.`]{1,220}$/.test(args.expectedTargetType)
    && int(args.expectedDeathAnimationCounter, 0, 2147483647) && typeof args.expectedMummyCollapsed === 'boolean'
    && (!args.expectedMummyCollapsed || args.expectedTargetType === mummy && args.allowExplosive === true && args.expectedAmmo?.itemId === '(O)441')
    && int(args.slingshotSlot, 0, 255) && id(args.expectedSlingshotItemId) && key(args.toolKey)
    && object(args.expectedAmmo) && Object.keys(args.expectedAmmo).every(k => ['itemId', 'quality', 'stack'].includes(k))
    && id(args.expectedAmmo.itemId) && int(args.expectedAmmo.quality, 0, 4) && int(args.expectedAmmo.stack, 1, 10000)
    && int(args.maxShots, 1, 16) && args.expectedAmmo.stack >= args.maxShots && int(args.healthFloor, 20, 1000) && int(args.maxHealthLoss, 0, 1000)
    && (args.objective === undefined || ['shots', 'defeat_target'].includes(args.objective)) && (args.allowExplosive === undefined || typeof args.allowExplosive === 'boolean'),
  'slingshot_shoot需要准确原生目标/生命周期、弹弓实例、足量现有弹药与有限发数和生命预算。');
  const objective = args.objective ?? 'shots', maxRange = args.maxRangeTiles ?? 12, displacement = args.maxDisplacementTiles ?? 2;
  requireFact(int(maxRange, 1, 20) && int(displacement, 0, 8) && (args.expectedAmmo.itemId !== '(O)441' || args.allowExplosive === true), '射程/位移预算无效或爆炸弹没有明确发射许可。');
  io.needs(SLINGSHOT_SHOOT_WORKFLOW.requiredTools); io.ready();
  const start = { ...io.port.current().player.position }, location = start.locationId;
  let locationKey = '', firingMode: boolean | undefined, healthUsed = 0, lastHealth = io.port.current().player.health, shots = 0, noProgress = 0;
  let enchantments = '';
  const account = () => {
    const p = io.port.current().player; healthUsed += Math.max(0, lastHealth - p.health); lastHealth = p.health;
    requireFact(p.position.locationId === location && Math.hypot(p.position.x - start.x, p.position.y - start.y) <= displacement
      && p.health >= args.healthFloor && healthUsed <= args.maxHealthLoss, '射击地点、整批位移或观察生命损失预算已触及；恢复不返还额度。');
  };
  const read = async (): Promise<Frame> => {
    const first = await io.call('dsh_query_slingshot', {}); account();
    const combat = (await io.call('dsh_query_mine', {})).combat; account();
    const inventory = await io.inventory(); account();
    const q = await io.call('dsh_query_slingshot', {}); account();
    requireFact(first.available === true && object(first.state) && q.available === true && q.complete === true && object(q.state)
      && first.state.locationKey === q.state.locationKey && first.state.inventoryDigest === q.state.inventoryDigest && first.attachmentSetDigest === q.attachmentSetDigest
      && sha(q.state.inventoryDigest) && sha(q.attachmentSetDigest) && q.state.canMove === true && q.state.menuType === null && q.state.eventUp === false && q.state.fading === false
      && q.usingSlingshot === false && q.usingTool === false && typeof q.legacyFiring === 'boolean' && (firingMode === undefined || firingMode === q.legacyFiring)
      && object(q.shooting) && q.shooting.complete === true && q.shooting.poseReady === true && q.shooting.mouseAimAvailable === true && q.shooting.nonCombatantsPresent === false
      && Array.isArray(q.shooting.projectiles) && q.shooting.projectiles.length <= 256 && q.shooting.projectiles.every(projectile)
      && new Set(q.shooting.projectiles.map((p: ObjectValue) => p.projectileKey)).size === q.shooting.projectiles.length
      && Array.isArray(q.attachments) && q.attachments.length <= 4096 && Array.isArray(q.slingshots) && q.slingshots.length <= 256,
    '没有稳定空闲的完整弹弓/射弹事实、原瞄准方式改变或地点内存在非怪物角色，未授权友伤。');
    const s = q.state, player = io.port.current().player;
    requireFact(key(s.locationKey) && (!locationKey || s.locationKey === locationKey) && s.locationId === location
      && samePosition(player.position, positionOf(s.position)) && player.health === s.health && near(player.energy, s.energy) && player.money === String(s.money)
      && int(s.health, args.healthFloor, 1000) && int(s.money, 0, 2147483647) && object(combat) && combat.available === true && combat.complete === true
      && object(combat.state) && combat.state.locationKey === s.locationKey && combat.state.inventoryDigest === s.inventoryDigest && combat.state.money === s.money
      && Array.isArray(combat.monsters) && combat.monsters.length <= 128 && int(combat.monstersKilled, 0, 4294967295), '独立MCP与原生主角/地点/库存/怪物捕获不同。');
    verifyNativeInventory(inventory, s.inventoryCounts);
    requireFact(combat.monsters.every((m: unknown) => object(m) && key(m.targetKey) && m.native === true && typeof m.type === 'string'
      && int(m.health, -2147483648, 2147483647) && life(m.lifecycle) && int(m.invincibleCountdown, -1000000, 1000000)
      && (m.type !== mummy || m.lifecycle.mummyReviveTimerMs !== null) && object(m.position) && m.position.locationId === location)
      && new Set(combat.monsters.map((m: ObjectValue) => m.targetKey)).size === combat.monsters.length, '原生怪物列表、身份或生命周期缺失。');
    requireFact(q.attachments.every((a: unknown) => object(a) && int(a.toolSlot, 0, 255) && key(a.toolKey) && int(a.index, 0, 15) && int(a.quality, 0, 4)
      && (a.itemId === null ? a.stack === 0 && a.quality === 0 && a.itemKey === null : id(a.itemId) && int(a.stack, 1, 10000) && key(a.itemKey)))
      && new Set(q.attachments.map((a: ObjectValue) => `${a.toolSlot}:${a.index}`)).size === q.attachments.length, '完整工具附件缺失、重复或无效。');
    const sling = q.slingshots.find((s: ObjectValue) => s.slot === args.slingshotSlot), item = inventory.slots.find((s: ObjectValue) => s.index === args.slingshotSlot)?.item;
    requireFact(object(sling) && sling.toolKey === args.toolKey && sling.itemId === args.expectedSlingshotItemId && sha(sling.gearDigest)
      && sling.attachmentSlots === 1 && sling.nativeEnchantmentsOnly === true && sling.canAutoFire === false && validSlingshotAmmo(sling.ammo)
      && Array.isArray(sling.enchantments) && (!enchantments || JSON.stringify(sling.enchantments) === enchantments)
      && item?.qualifiedItemId === sling.itemId && item.tool === true && object(item.ref) && typeof item.ref.value === 'string'
      && q.attachments.some((a: ObjectValue) => a.toolSlot === args.slingshotSlot && a.toolKey === args.toolKey && a.index === 0
        && a.itemId === sling.ammo.itemId && a.quality === sling.ammo.quality && a.stack === sling.ammo.stack), '实际弹弓/附魔/独立工具Ref或准确弹药配置不符。');
    const target = combat.monsters.find((m: ObjectValue) => m.targetKey === args.targetKey);
    requireFact(!target || target.type === args.expectedTargetType, '固定目标类型改变，未换目标继续射击。');
    locationKey ||= s.locationKey; firingMode ??= q.legacyFiring; enchantments ||= JSON.stringify(sling.enchantments);
    return { query: q, state: s, sling, combat, inventory, target };
  };
  const waiting = (reason: string) => { io.observed('slingshot_waiting', { reason, shots, healthUsed, targetDeathVerified: false }); return 'waiting' as const; };
  let latest = await read(); const initialAmmo: ObjectValue = latest.sling.ammo;
  requireFact(initialAmmo.itemId === args.expectedAmmo.itemId && initialAmmo.quality === args.expectedAmmo.quality && initialAmmo.stack === args.expectedAmmo.stack
    && latest.target && latest.target.health > 0 && latest.target.lifecycle.deathAnimationCounter === args.expectedDeathAnimationCounter
    && (latest.target.type === mummy && latest.target.lifecycle.mummyReviveTimerMs > 0) === args.expectedMummyCollapsed,
  '本批原弹药/目标/生命周期已变，未采用旧批准。');
  io.observed('slingshot_shoot_preflight', { objective, targetType: args.expectedTargetType, slingshotItemId: args.expectedSlingshotItemId,
    expectedAmmo: args.expectedAmmo, expectedMummyCollapsed: args.expectedMummyCollapsed, maxShots: args.maxShots, legacyFiring: firingMode, maxRangeTiles: maxRange, maxDisplacementTiles: displacement,
    healthFloor: args.healthFloor, maxHealthLoss: args.maxHealthLoss, allowExplosive: args.allowExplosive === true });
  if (latest.query.selectedSlot !== args.slingshotSlot) {
    if ((io.port.remainingActions?.() ?? 0) < 4) return waiting('reserve_equip_shot_and_two_exit_actions');
    const before = latest, tool = before.inventory.slots.find((s: ObjectValue) => s.index === args.slingshotSlot).item;
    await io.call('stardew_equip', { itemRef: tool.ref, inventoryRevision: before.inventory.inventoryRevision });
    try {
      latest = await read();
      requireFact(latest.query.selectedSlot === args.slingshotSlot && sameSlingshotAmmo(initialAmmo, latest.sling.ammo)
        && inventoryDelta(before.inventory, latest.inventory).size === 0 && latest.state.money === before.state.money, '装备弹弓后的独立物品/弹药/金币或所选槽不符。');
    } catch { return io.uncertain('装备动作已提交但独立结果未确认，不继续射击。'); }
  }
  while (shots < args.maxShots) {
    io.ready(location); account();
    const t = latest.target;
    if (!t || t.health <= 0) return waiting('pinned_target_absent_or_inactive_without_terminal_proof');
    if (t.lifecycle.deathAnimationCounter !== args.expectedDeathAnimationCounter) return waiting('pinned_lifecycle_changed_replan_required');
    if ((t.type === mummy && t.lifecycle.mummyReviveTimerMs > 0) !== args.expectedMummyCollapsed) return waiting('mummy_phase_changed_replan_required');
    if (t.type === mummy && t.lifecycle.mummyReviveTimerMs > 0 && args.expectedAmmo.itemId !== '(O)441') return waiting('collapsed_mummy_requires_explicit_native_explosive_strategy');
    if (t.invincibleCountdown > 0) return waiting('native_hit_invulnerability_active');
    const position = positionOf(t.position), player = positionOf(latest.state.position);
    if (Math.hypot(position.x - player.x, position.y - player.y) > maxRange || Math.hypot(position.x - start.x, position.y - start.y) > maxRange)
      return waiting('pinned_target_outside_approved_range_no_automatic_chase');
    if (healthUsed >= args.maxHealthLoss && args.maxHealthLoss > 0) return waiting('observed_health_loss_budget_reached');
    if ((io.port.remainingActions?.() ?? 0) < 3) return waiting('reserve_one_shot_and_two_exit_actions');
    const before = latest, budget = args.maxHealthLoss - healthUsed;
    requireFact(before.sling.ammo.stack === initialAmmo.stack - shots && before.sling.ammo.itemKey === initialAmmo.itemKey,
      '两发之间出现未批准的弹药数量或实例变化。');
    const outcome = await io.port.call('dsh_slingshot_shot', { locationKey, targetKey: args.targetKey, expectedTargetType: args.expectedTargetType,
      expectedDeathAnimationCounter: args.expectedDeathAnimationCounter, expectedMummyCollapsed: args.expectedMummyCollapsed,
      slingshotSlot: args.slingshotSlot, expectedSlingshotItemId: args.expectedSlingshotItemId,
      toolKey: args.toolKey, gearDigest: before.sling.gearDigest, inventoryDigest: before.state.inventoryDigest, attachmentSetDigest: before.query.attachmentSetDigest,
      expectedAmmoItemId: before.sling.ammo.itemId, expectedAmmoQuality: before.sling.ammo.quality, expectedAmmoStack: before.sling.ammo.stack, ammoItemKey: before.sling.ammo.itemKey,
      expectedLegacyFiring: firingMode, expectedHealth: before.state.health, expectedMoney: before.state.money, healthFloor: args.healthFloor,
      maxHealthLoss: budget, maxRangeTiles: maxRange, maxDisplacementTiles: Math.max(0, displacement - Math.hypot(player.x - start.x, player.y - start.y)),
      allowExplosive: args.allowExplosive === true, durationMs: 15000 });
    io.observed('slingshot_native_receipt', { status: outcome.status, output: outcome.output, error: outcome.error });
    if (outcome.status === 'failed') return waiting('native_preflight_rejected_without_input');
    if (outcome.status !== 'succeeded' || !object(outcome.output)) return io.uncertain('弹弓动作结果未知，可能已发射；不重发。');
    const r = outcome.output;
    if (r.completedWorkflow !== true && r.nativeActionSubmitted === false) return waiting('native_preconditions_changed_before_input');
    try {
      requireFact(r.completedWorkflow === true && r.completionUncertain === false && r.nativeActionSubmitted === true && r.nativeReleaseSubmitted === true
        && r.nativeReleaseReturned === true && r.projectileObserved === true && r.projectileEnded === true && r.ammunitionSpent === 1
        && r.slingshotSlot === args.slingshotSlot && r.toolKey === args.toolKey && r.legacyFiring === firingMode && r.chargeAtRelease === 1 && int(r.backArmAtRelease, 5, 20)
        && r.rosterComplete === true && validSlingshotAmmo(r.beforeAmmo) && validSlingshotAmmo(r.afterAmmo) && sameSlingshotAmmo(r.beforeAmmo, before.sling.ammo)
        && projectile(r.initialProjectile) && projectile(r.finalProjectile) && key(r.projectileKey)
        && r.initialProjectile.projectileKey === r.projectileKey && r.finalProjectile.projectileKey === r.projectileKey
        && r.initialProjectile.type === basicProjectile && r.initialProjectile.firedByPlayer === true && r.initialProjectile.damagesMonsters === true
        && r.initialProjectile.itemId === initialAmmo.itemId && r.initialProjectile.nativeExplodeFlag === false
        && r.finalProjectile.type === basicProjectile && r.finalProjectile.firedByPlayer === true && r.finalProjectile.damagesMonsters === true && r.finalProjectile.itemId === initialAmmo.itemId
        && (r.projectilePresent === false || r.projectilePresent === true && r.finalProjectile.destroyMe === true)
        && r.hitVerified === false && r.explosionVerified === false && r.targetDamageCauseVerified === false
        && r.targetKey === args.targetKey && r.targetType === args.expectedTargetType && int(r.targetHealthBefore, 1, 2147483647)
        && int(r.targetHealthAfter, -2147483648, 2147483647) && typeof r.targetPresent === 'boolean' && int(r.monstersKilledDelta, 0, 4294967295)
        && Array.isArray(r.monsterChanges) && r.monsterChanges.length <= 256
        && r.monsterChanges.every((m: unknown) => object(m) && key(m.targetKey) && typeof m.type === 'string'
          && (m.beforeHealth === null || int(m.beforeHealth, -2147483648, 2147483647)) && int(m.health, -2147483648, 2147483647)
          && typeof m.present === 'boolean' && (m.lifeBefore === null || life(m.lifeBefore)) && life(m.lifeAfter) && typeof m.nativeDeathVerified === 'boolean')
        && new Set(r.monsterChanges.map((m: ObjectValue) => m.targetKey)).size === r.monsterChanges.length
        && r.monsterChanges.filter((m: ObjectValue) => m.nativeDeathVerified).length <= r.monstersKilledDelta
        && object(r.before?.slingshot?.state) && object(r.after?.slingshot?.state) && object(r.before?.combat) && object(r.after?.combat)
        && r.before.slingshot.state.locationKey === locationKey && r.after.slingshot.state.locationKey === locationKey
        && r.before.slingshot.state.inventoryDigest === before.state.inventoryDigest && r.before.slingshot.state.health === before.state.health
        && int(r.observedHealthLoss, 0, budget) && int(r.after.slingshot.state.health, args.healthFloor, 1000)
        && r.observedHealthLoss >= Math.max(0, before.state.health - r.after.slingshot.state.health), '实际蓄力/单发/弹丸结束、目标或原生资源收据不完整。');
      verifyDeath(r, args.expectedTargetType, true);
      requireFact(r.targetLifeBefore.deathAnimationCounter === args.expectedDeathAnimationCounter
        && (args.expectedTargetType === mummy && r.targetLifeBefore.mummyReviveTimerMs > 0) === args.expectedMummyCollapsed, '发射没有绑定批准的生命周期/倒地阶段。');
      healthUsed += r.observedHealthLoss; lastHealth = r.after.slingshot.state.health; account();
      latest = await read();
      const a = latest.sling.ammo, spent = before.sling.ammo.stack === 1 ? a.itemId === null && a.stack === 0
        : a.itemId === before.sling.ammo.itemId && a.quality === before.sling.ammo.quality && a.itemKey === before.sling.ammo.itemKey && a.stack === before.sling.ammo.stack - 1;
      requireFact(spent && sameSlingshotAmmo(a, r.afterAmmo) && latest.state.inventoryDigest === r.after.slingshot.state.inventoryDigest
        && latest.query.selectedSlot === args.slingshotSlot && latest.state.money === r.after.slingshot.state.money && latest.state.money >= before.state.money
        && latest.state.health === r.after.slingshot.state.health && near(latest.state.energy, r.after.slingshot.state.energy) && latest.state.energy + 0.001 >= before.state.energy
        && JSON.stringify(before.query.attachments.filter((a: ObjectValue) => a.toolSlot !== args.slingshotSlot)) === JSON.stringify(latest.query.attachments.filter((a: ObjectValue) => a.toolSlot !== args.slingshotSlot))
        && !latest.query.shooting.projectiles.some((p: ObjectValue) => p.projectileKey === r.projectileKey && !p.destroyMe)
        && latest.combat.monstersKilled === r.after.combat.monstersKilled && r.after.combat.monstersKilled - r.before.combat.monstersKilled === r.monstersKilledDelta,
      '独立弹药-1/背包/资源/装备、其他附件、射弹或击杀统计不同。');
      verifyInventoryChanges(before.inventory, latest.inventory, r.inventoryChanges);
      const inventoryGains = [...inventoryDelta(before.inventory, latest.inventory)].map(([k, amount]) => { const [itemId, quality] = JSON.parse(k); return { itemId, quality, amount }; });
      requireFact(inventoryGains.every(g => g.amount >= 0) && !!latest.target === r.targetPresent
        && (!latest.target || latest.target.health === r.targetHealthAfter && latest.target.lifecycle.deathAnimationCounter === r.targetLifeAfter.deathAnimationCounter),
      '独立背包出现未批准损失或目标终态未保持可核对。');
      shots++;
      const observedHealthDecrease = Math.max(0, r.targetHealthBefore - r.targetHealthAfter); noProgress = observedHealthDecrease > 0 ? 0 : noProgress + 1;
      io.observed('slingshot_shot_verified', { targetType: args.expectedTargetType, slingshotItemId: args.expectedSlingshotItemId, beforeAmmo: r.beforeAmmo, afterAmmo: r.afterAmmo,
        ammunitionSpent: 1, legacyFiring: firingMode, chargeAtRelease: r.chargeAtRelease, projectileEnded: true,
        targetHealthBefore: r.targetHealthBefore, targetHealthAfter: r.targetHealthAfter, targetPresent: r.targetPresent, observedHealthDecrease,
        targetDeathVerified: r.targetDeathVerified, targetDeathProofRule: r.targetDeathProofRule, targetCollapsedForRevival: r.targetCollapsedForRevival,
        targetLifeBefore: r.targetLifeBefore, targetLifeAfter: r.targetLifeAfter, monstersKilledDelta: r.monstersKilledDelta,
        healthBefore: before.state.health, healthAfter: latest.state.health, healthUsed, inventoryGains, goldGain: latest.state.money - before.state.money,
        hitVerified: false, explosionVerified: false, targetDamageCauseVerified: false, pickupAttributionVerified: false, explorationCompleted: false });
    } catch { return io.uncertain('射击已提交但弹药/弹丸/独立资源或目标结果未完整确认，不重发。'); }
    if (r.targetDeathVerified) {
      io.observed('slingshot_target_defeated', { targetType: args.expectedTargetType, slingshotItemId: args.expectedSlingshotItemId,
        proofRule: r.targetDeathProofRule, lifeBefore: r.targetLifeBefore, lifeAfter: r.targetLifeAfter, targetHealthAfter: r.targetHealthAfter,
        monstersKilledDelta: r.monstersKilledDelta, shots, healthUsed, targetDamageCauseVerified: false, encounterCleared: false });
      return 'completed';
    }
    if (r.targetCollapsedForRevival || latest.target?.lifecycle.deathAnimationCounter !== args.expectedDeathAnimationCounter
      || (latest.target?.type === mummy && latest.target.lifecycle.mummyReviveTimerMs > 0) !== args.expectedMummyCollapsed) return waiting('native_lifecycle_changed_replan_required');
    if (shots >= args.maxShots) return objective === 'shots' ? 'completed' : waiting('shot_cap_reached_without_terminal_death');
    if (noProgress >= 2) return waiting('two_shots_without_observed_health_progress');
    // Re-read after each actual projectile ends. No synthetic hit claim, automatic
    // reload, retry of unknown shots or adoption of a different monster phase.
  }
  return objective === 'shots' ? 'completed' : waiting('terminal_death_not_proven');
}

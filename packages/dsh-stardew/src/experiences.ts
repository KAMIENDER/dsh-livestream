import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FarmIdentity } from './extension.js';
import { atomicJson, dayNumber, PersistenceError, type DayReport, type GameDate } from './persistence.js';
import { object, type ObjectValue, type WorkflowReport } from './workflow-context.js';
import { validNightReport } from './night-observation.js';

export interface GameExperience {
  version: 1; eventId: string; saveId: string; gameBuildId: string; runId: string;
  sourceId: string; kind: string; gameDate: GameDate; recordedAt: number;
  facts: ObjectValue; characterId: string | null;
  delivery: { state: 'unbound' | 'pending' | 'recorded' | 'forgotten'; attempts: number; lastAttemptAt?: number; lastOutcome?: 'unavailable' | 'write_failed' | 'recorded' | 'forgotten' };
}
export interface StoryObserver {
  character(): string | null;
  publish(event: GameExperience): 'recorded' | 'forgotten' | 'unavailable';
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const character = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v);
const plainText = (v: unknown, limit = 128): string | null => typeof v === 'string' && v.length <= limit && !/[\x00-\x1f]/.test(v) ? v : null;
const scalar = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const point = (v: any) => object(v) ? { locationId: plainText(v.locationId), x: scalar(v.x), y: scalar(v.y) } : null;
const lifecycle = (v: any) => object(v) ? { deathAnimationCounter: scalar(v.deathAnimationCounter), mummyReviveTimerMs: scalar(v.mummyReviveTimerMs) } : null;
const ammunition = (v: any) => object(v) ? { itemId: plainText(v.itemId), quality: scalar(v.quality), stack: scalar(v.stack), explosive: v.explosive === true } : null;
const gains = (v: any): ObjectValue => {
  const rows = Array.isArray(v) ? v : [];
  return { totalRows: rows.length, detailsLimited: rows.length > 4,
    items: rows.slice(0, 4).map((r: any) => ({ itemId: plainText(r.itemId), quality: scalar(r.quality), amount: scalar(r.amount) })) };
};
interface Fact { sourceId: string; kind: string; facts: ObjectValue }

/** No model notes, free-form plans, UI refs or raw dialogue enter the observed-fact lane. */
export function workflowExperiences(report: WorkflowReport): Fact[] {
  const output: Fact[] = [];
  const add = (sourceId: string, kind: string, facts: ObjectValue) => output.push({ sourceId, kind, facts });
  if (report.quest) {
    const q = report.quest, r = q.receipt, target = r.targetAfter;
    if (r.confirmedEffect === true && r.targetKey === q.targetKey) add(`workflow:${report.id}:quest`, q.operation === 'accepted' ? 'quest_accepted' : 'quest_money_claimed', {
      nativeQuestId: plainText(target?.quest?.id), questType: plainText(target?.quest?.type), orderKey: plainText(target?.order?.questKey),
      generationSeed: scalar(target?.order?.generationSeed), goldBefore: scalar(r.beforeGold), goldAfter: scalar(r.afterGold),
      uiWorkflowStatus: report.status,
    });
  }
  if (report.social?.receipt.confirmedEffect === true && report.workflow !== 'npc_dialogue') {
    const social = report.social, r = social.receipt;
    // Continuation copies the original verified effect; it must not create another gift.
    add(`workflow:${social.originWorkflowId ?? report.id}:social`, `npc_${social.operation}`, {
      npcName: plainText(social.npcName), itemId: plainText(r.offeredItemId), quality: scalar(r.offeredQuality), amountConsumed: scalar(r.amountConsumed),
      nativeQuestId: plainText(r.questId), pointsAfter: scalar(r.afterFriendship?.points), giftsTodayAfter: scalar(r.afterFriendship?.giftsToday),
      effect: plainText(r.outcome), dialogueEndConfirmedInThisReport: report.status === 'completed',
    });
  }
  report.observed.forEach((entry, index) => {
    const d = entry.data;
    if (!object(d)) return;
    const source = `workflow:${report.id}:step:${index}`;
    switch (entry.step) {
      case 'building_skin_verified': add(source, 'building_skin_observed', { buildingGuid: plainText(d.buildingGuid), position: point(d.position), skinId: plainText(d.skinId),
        baseSkin: d.skinId === null, previousSkinId: plainText(d.previousSkinId), changedDuringWorkflow: d.changedDuringWorkflow === true, observationOnly: d.observationOnly === true,
        constructionDays: scalar(d.constructionDays), upgradeDays: scalar(d.upgradeDays), constructionReady: d.constructionReady === true,
        defaultFlags: Array.isArray(d.defaultFlags) && d.defaultFlags.length === 3 && d.defaultFlags.every((v: unknown) => typeof v === 'boolean') ? d.defaultFlags : null,
        preservationVerified: d.preservationVerified === true, constructionCauseVerified: false }); break;
      case 'building_paint_region_verified': add(source, 'building_color_region_observed', { buildingGuid: plainText(d.buildingGuid), position: point(d.position),
        regionId: plainText(d.regionId), regionIndex: scalar(d.index), default: d.default === true, hue: scalar(d.hue), saturation: scalar(d.saturation), lightness: scalar(d.lightness),
        changedDuringWorkflow: d.changedDuringWorkflow === true, preservationVerified: d.preservationVerified === true, immediateEffect: true }); break;
      case 'building_legacy_tint_reset_verified': add(source, 'building_legacy_tint_reset', { buildingGuid: plainText(d.buildingGuid), position: point(d.position),
        before: scalar(d.before), after: scalar(d.after), nativePaintOpening: true }); break;
      case 'building_move_verified':
      case 'building_returned_to_origin_verified': add(source, entry.step === 'building_move_verified' ? 'building_moved' : 'building_returned_to_origin', {
        buildingGuid: plainText(d.buildingGuid), locationId: plainText(d.locationId), builder: plainText(d.builder), type: plainText(d.type), skinId: plainText(d.skinId),
        origin: point(d.origin), position: point(d.position ?? d.origin), targetMoveCompleted: d.targetMoveCompleted === true,
        preservationVerified: d.preservationVerified === true, preservationScope: 'listed_building_interior_item_and_resident_fields',
        exitUpdatesVerified: d.exitUpdatesVerified === true, trackedExitCount: scalar(d.trackedExitCount), exitTraversalVerified: false,
        // Keep permanent facts compact and free of temporary reference keys;
        // the workflow report retains every approved ground cell before/after.
        groundPolicy: plainText(d.groundPolicy), affectedGroundCells: Array.isArray(d.groundBefore) ? d.groundBefore.length : null,
        changedGroundCells: Array.isArray(d.groundBefore) && Array.isArray(d.groundAfter)
          ? d.groundBefore.filter((row: unknown, i: number) => JSON.stringify(row) !== JSON.stringify(d.groundAfter[i])).length : null,
      }); break;
      case 'building_construction_verified': add(source, 'building_construction_started', { mode: plainText(d.mode), builder: plainText(d.builder),
        locationId: plainText(d.locationId), buildingGuid: plainText(d.buildingGuid), blueprintId: plainText(d.blueprintId), type: plainText(d.type), skinId: plainText(d.skinId),
        upgradeName: plainText(d.upgradeName), x: scalar(d.x), y: scalar(d.y), width: scalar(d.width), height: scalar(d.height),
        constructionDays: scalar(d.constructionDays), upgradeDays: scalar(d.upgradeDays), goldSpent: scalar(d.goldSpent), materialsConsumed: gains(d.materialsConsumed),
        readyAtConfirmation: d.ready === true, constructionCauseVerified: false }); break;
      case 'building_status_verified': add(source, d.ready === true ? 'building_ready_observed' : 'building_under_construction_observed', {
        locationId: plainText(d.locationId), buildingGuid: plainText(d.buildingGuid), type: plainText(d.type), skinId: plainText(d.skinId), upgradeName: plainText(d.upgradeName),
        x: scalar(d.x), y: scalar(d.y), width: scalar(d.width), height: scalar(d.height), constructionDays: scalar(d.constructionDays), upgradeDays: scalar(d.upgradeDays),
        observationOnly: true, constructionCauseVerified: false }); break;
      case 'slingshot_target_defeated': add(source, 'monster_terminal_death_observed', { targetType: plainText(d.targetType, 256),
        weaponItemId: plainText(d.slingshotItemId), family: 'slingshot', proofRule: plainText(d.proofRule), lifecycleBefore: lifecycle(d.lifeBefore), lifecycleAfter: lifecycle(d.lifeAfter),
        targetHealthAfter: scalar(d.targetHealthAfter), monstersKilledDelta: scalar(d.monstersKilledDelta), shots: scalar(d.shots),
        healthObservedLossUsed: scalar(d.healthUsed), targetDamageCauseVerified: false, encounterCleared: false, explorationCompleted: false }); break;
      case 'slingshot_shot_verified': add(source, 'slingshot_shot_observed', { targetType: plainText(d.targetType, 256), slingshotItemId: plainText(d.slingshotItemId),
        beforeAmmo: ammunition(d.beforeAmmo), afterAmmo: ammunition(d.afterAmmo), ammunitionSpent: scalar(d.ammunitionSpent), legacyFiring: d.legacyFiring === true,
        chargeAtRelease: scalar(d.chargeAtRelease), projectileEnded: d.projectileEnded === true,
        targetHealthBefore: scalar(d.targetHealthBefore), targetHealthAfter: scalar(d.targetHealthAfter), targetPresent: d.targetPresent === true,
        observedHealthDecrease: scalar(d.observedHealthDecrease), targetDeathVerified: d.targetDeathVerified === true, targetDeathProofRule: plainText(d.targetDeathProofRule),
        targetCollapsedForRevival: d.targetCollapsedForRevival === true, lifecycleBefore: lifecycle(d.targetLifeBefore), lifecycleAfter: lifecycle(d.targetLifeAfter),
        monstersKilledDelta: scalar(d.monstersKilledDelta), healthBefore: scalar(d.healthBefore), healthAfter: scalar(d.healthAfter), healthObservedLossUsed: scalar(d.healthUsed),
        inventoryGains: gains(d.inventoryGains), goldGain: scalar(d.goldGain), hitVerified: false, explosionVerified: false,
        targetDamageCauseVerified: false, pickupAttributionVerified: false, explorationCompleted: false }); break;
      case 'slingshot_ammo_verified': add(source, 'slingshot_ammo_moved', { operation: plainText(d.operation), slingshotItemId: plainText(d.slingshotItemId),
        itemId: plainText(d.itemId), quality: scalar(d.quality), loadedCount: scalar(d.loadedCount), detachedCount: scalar(d.detachedCount),
        beforeAmmo: ammunition(d.beforeAmmo), afterAmmo: ammunition(d.afterAmmo), conservedQuantity: d.conservedQuantity === true,
        ammunitionFired: false, hitOrKillProven: false }); break;
      case 'melee_action_verified': add(source, 'melee_action_observed', { mode: plainText(d.mode), targetType: plainText(d.targetType, 256),
        weaponItemId: plainText(d.weaponItemId), family: plainText(d.family), targetHealthBefore: scalar(d.targetHealthBefore), targetHealthAfter: scalar(d.targetHealthAfter),
        targetPresent: d.targetPresent === true, observedDamage: scalar(d.observedDamage), targetRemovedWithKillEvidence: d.targetRemovedWithKillEvidence === true,
        targetDeathVerified: d.targetDeathVerified === true, targetDeathProofRule: plainText(d.targetDeathProofRule), targetCollapsedForRevival: d.targetCollapsedForRevival === true,
        lifecycleBefore: lifecycle(d.targetLifeBefore), lifecycleAfter: lifecycle(d.targetLifeAfter),
        targetDamageCauseVerified: false, monstersKilledDelta: scalar(d.monstersKilledDelta), affectedMonsterCount: scalar(d.affectedMonsterCount),
        healthBefore: scalar(d.healthBefore), healthAfter: scalar(d.healthAfter), healthObservedLossUsed: scalar(d.healthUsed),
        inventoryGains: gains(d.inventoryGains), goldGain: scalar(d.goldGain), pickupAttributionVerified: false, explorationCompleted: false }); break;
      case 'melee_target_defeated': add(source, 'monster_terminal_death_observed', { targetType: plainText(d.targetType, 256), weaponItemId: plainText(d.weaponItemId),
        family: plainText(d.family), proofRule: plainText(d.proofRule), lifecycleBefore: lifecycle(d.lifeBefore), lifecycleAfter: lifecycle(d.lifeAfter),
        targetHealthAfter: scalar(d.targetHealthAfter), monstersKilledDelta: scalar(d.monstersKilledDelta),
        actions: scalar(d.actions), specials: scalar(d.specials), healthObservedLossUsed: scalar(d.healthUsed),
        targetDamageCauseVerified: false, encounterCleared: false, explorationCompleted: false }); break;
      case 'melee_retreat_observed': add(source, 'melee_retreat_destination_observed', { destination: point(d.destination), healthBefore: scalar(d.healthBefore),
        healthAfter: scalar(d.healthAfter), healthObservedLossUsed: scalar(d.healthUsed), targetStillPresent: d.targetStillPresent === true, safeEscapeVerified: false,
        inventoryGains: gains(d.inventoryGains), goldGain: scalar(d.goldGain), pickupAttributionVerified: false }); break;
      case 'mining_strike_verified': add(source, d.crushed === true ? 'mine_rock_broken' : 'mine_rock_damaged', { position: point(d.position), itemId: plainText(d.itemId), quality: scalar(d.quality),
        beforeDurability: scalar(d.beforeDurability), afterDurability: scalar(d.afterDurability), miningExperienceBefore: scalar(d.miningExperienceBefore), miningExperienceAfter: scalar(d.miningExperienceAfter),
        inventoryGains: gains(d.inventoryGains), goldGain: scalar(d.goldGain), pickupAttributionVerified: false, healthObservedLossUsed: scalar(d.healthUsed), energyObservedLossUsed: scalar(d.energyUsed) }); break;
      case 'mining_pickup_observed': add(source, 'mine_pickup_observed', { inventoryGains: gains(d.inventoryGains), goldGain: scalar(d.goldGain), pickupAttributionVerified: false }); break;
      case 'mining_exit_observed': add(source, 'mine_exit_observed', { level: scalar(d.level), swings: scalar(d.swings), broken: scalar(d.broken),
        alreadyExistedBeforeMining: d.alreadyExistedBeforeMining === true, traversed: false, causeVerified: false }); break;
      case 'mine_transition_verified': add(source, 'mine_transition', { operation: plainText(d.operation), fromLevel: scalar(d.fromLevel), toLevel: scalar(d.toLevel),
        destination: plainText(d.destination), healthBefore: scalar(d.healthBefore), healthAfter: scalar(d.healthAfter), fallLevels: scalar(d.fallLevels),
        observedHealthLossUsed: scalar(d.observedHealthLossUsed), incidentalPickups: gains(d.incidentalPickups), moneyUnchanged: d.moneyUnchanged === true,
        explorationCompleted: false, miningOrKillProven: false }); break;
      case 'tile_completed': add(source, 'crop_planted', { position: point(d.position), cropId: plainText(d.crop?.cropId), watered: typeof d.crop?.watered === 'boolean' ? d.crop.watered : null }); break;
      case 'animal_pet_confirmed': add(source, 'animal_petted', { animalId: plainText(d.animalId), locationId: plainText(d.locationId) }); break;
      case 'animal_harvest_inventory': add(source, 'animal_produce_collected', { animalId: plainText(d.animalId), itemId: plainText(d.itemId), quality: scalar(d.quality), amount: d.after - d.before }); break;
      case 'feed_prepared': add(source, 'hay_prepared', { position: point(d.target?.position), quality: scalar(d.target?.occupiedQuality), animalEatingConfirmed: false }); break;
      case 'ground_collected': add(source, 'ground_collected', { position: point(d.position), ...gains(d.inventoryChanges), specificAnimalSourceProven: false }); break;
      case 'fishing_attempt_completed': add(source, 'fishing_attempt', { outcome: plainText(d.outcome), baitConsumed: scalar(d.baitConsumed), ...gains(d.itemGains) }); break;
      case 'production_cycle_completed': add(source, 'machine_cycle_collected', { jobId: plainText(d.jobId), ...gains(d.receipt?.collect?.received) }); break;
      case 'recipe_craft_verified': add(source, 'recipe_crafted', { recipeName: plainText(d.recipeName), cooking: d.cooking === true,
        itemId: plainText(d.output?.itemId), quality: scalar(d.output?.quality), quantity: scalar(d.output?.quantity), crafts: 1,
        destinationAtConfirmation: plainText(d.output?.destination), seasoning: d.seasoning === true, materials: { ...gains(d.consumed), direction: 'consumed' } }); break;
      case 'crafted_output_stored': if (d.destination === 'cursor') add(source, 'recipe_output_stored', { recipeName: plainText(d.recipeName), itemId: plainText(d.itemId),
        quality: scalar(d.quality), quantityMoved: scalar(d.quantity), movementOnlyNotNewProduction: true }); break;
      case 'storage_transfer_verified': add(source, 'storage_item_moved', { position: point(d.position), containerKind: plainText(d.containerKind),
        containerItemId: plainText(d.containerItemId), direction: plainText(d.direction), itemId: plainText(d.itemId), quality: scalar(d.quality),
        quantityMoved: scalar(d.quantity), movementOnlyNotNewProduction: true }); break;
      case 'shop_trade_verified': add(source, d.operation === 'buy' ? 'shop_item_purchased' : 'shop_item_sold', { shopId: plainText(d.shopId),
        itemId: plainText(d.itemId), quality: scalar(d.quality), quantity: scalar(d.quantity), purchaseCount: scalar(d.purchaseCount),
        unitPrice: scalar(d.unitPrice), goldBefore: scalar(d.goldBefore), goldAfter: scalar(d.goldAfter), tradeNotFarmProduction: true }); break;
      case 'shipping_movement_verified': add(source, 'pending_shipment_moved', { position: point(d.position), kind: plainText(d.kind), operation: plainText(d.operation),
        itemId: plainText(d.itemId), quality: scalar(d.quality), quantity: scalar(d.quantity), lastBatchQuantity: scalar(d.lastBatchQuantity),
        queuedOnlyNotSettled: true, moneyUnchanged: true }); break;
      case 'food_consumption_verified': add(source, 'food_consumed', { itemId: plainText(d.itemId), quality: scalar(d.quality), count: scalar(d.count), outcome: plainText(d.outcome),
        healthBefore: scalar(d.beforePlayer?.health), healthAfter: scalar(d.afterPlayer?.health), energyBefore: scalar(d.beforePlayer?.energy), energyAfter: scalar(d.afterPlayer?.energy),
        baseMaxEnergyAfter: scalar(d.afterPlayer?.baseMaxEnergy) }); break;
    }
  });
  return output;
}

/** One atomic file per event; bounded reads never silently trim old verified history. */
export class ExperienceLedger {
  private root: string;
  private files = new Map<string, string>();
  private flushCursor = 0;
  constructor(root: string, private identity: FarmIdentity) {
    if (!sha.test(identity.saveId) || !uuid.test(identity.gameBuildId)) throw new PersistenceError('经历账本缺少真实存档/构建身份。');
    this.root = join(root, 'farms', identity.saveId, 'experiences');
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      for (const file of readdirSync(this.root)) {
        if (file.endsWith('.tmp')) continue; // Interrupted atomic writes are never observations.
        const match = /^(\d{13})-([a-f0-9]{64})\.json$/.exec(file);
        if (!match || this.files.has(match[2])) throw new Error();
        this.files.set(match[2], file);
      }
    } catch { throw new PersistenceError('经历目录无法读取或有未知/重复条目，未覆盖或重建历史。'); }
  }
  private readFile(id: string): GameExperience {
    try {
      const text = readFileSync(join(this.root, this.files.get(id)!), 'utf8');
      if (Buffer.byteLength(text) > 8000) throw new Error();
      const e = JSON.parse(text) as GameExperience;
      if (e.version !== 1 || e.eventId !== id || e.saveId !== this.identity.saveId || !uuid.test(e.runId) || !uuid.test(e.gameBuildId)
        || !Number.isSafeInteger(e.recordedAt) || !this.files.get(id)!.startsWith(`${e.recordedAt}-`) || !object(e.facts) || JSON.stringify(e.facts).length > 1400 || e.characterId !== null && !character(e.characterId)
        || !['unbound', 'pending', 'recorded', 'forgotten'].includes(e.delivery?.state) || !Number.isSafeInteger(e.delivery.attempts) || e.delivery.attempts < 0
        || typeof e.sourceId !== 'string' || e.sourceId.length > 160 || !/^[a-z_]{1,48}$/.test(e.kind)
        || e.characterId === null && e.delivery.state !== 'unbound' || e.characterId !== null && e.delivery.state === 'unbound'
        || e.delivery.lastAttemptAt !== undefined && (!Number.isSafeInteger(e.delivery.lastAttemptAt) || e.delivery.lastAttemptAt < e.recordedAt)
        || e.delivery.lastOutcome !== undefined && !['unavailable', 'write_failed', 'recorded', 'forgotten'].includes(e.delivery.lastOutcome)
        || hash({ runId: e.runId, sourceId: e.sourceId, kind: e.kind }) !== id) throw new Error();
      dayNumber(e.gameDate); return e;
    } catch { throw new PersistenceError('经历条目损坏或身份不一致，未改写历史或猜测已同步。'); }
  }
  record(runId: string, sourceId: string, kind: string, gameDate: GameDate, facts: ObjectValue, target: string | null): void {
    if (!uuid.test(runId) || sourceId.length > 160 || !/^[a-z_]{1,48}$/.test(kind) || !object(facts) || JSON.stringify(facts).length > 1400 || target !== null && !character(target)) throw new PersistenceError('后端经历不符合明确的身份/大小边界，未截断成假收据。');
    dayNumber(gameDate);
    const eventId = hash({ runId, sourceId, kind });
    if (this.files.has(eventId)) {
      const old = this.readFile(eventId);
      if (hash({ facts: old.facts, gameDate: old.gameDate, build: old.gameBuildId }) !== hash({ facts, gameDate, build: this.identity.gameBuildId })) throw new PersistenceError('同一经历ID出现不同事实，未替换旧证据。');
      return; // Preserve original character target, first recorded time and delivery receipt.
    }
    const recordedAt = Date.now(), file = `${recordedAt}-${eventId}.json`;
    const event: GameExperience = { version: 1, eventId, saveId: this.identity.saveId, gameBuildId: this.identity.gameBuildId, runId, sourceId, kind,
      gameDate: { ...gameDate }, recordedAt, facts, characterId: target, delivery: { state: target ? 'pending' : 'unbound', attempts: 0 } };
    atomicJson(join(this.root, file), event); this.files.set(eventId, file);
  }
  recordDay(runId: string, day: DayReport, target: string | null): void {
    if (day.observed.sleepConfirmed !== true || day.observed.dayAdvanced !== true || dayNumber(day.observed.afterSleep.date) !== dayNumber(day.observed.start.date) + 1
      || !day.observed.afterSleep.player.canMove || day.observed.afterSleep.ui.menuOpen) throw new PersistenceError('日终检查点未包含完整正常睡眠/换日/可操作证据，未补记。');
    this.record(runId, `day:${day.day}`, 'normal_day_finished', day.observed.start.date, {
      day: day.day, dateAfter: day.observed.afterSleep.date, moneyBefore: day.observed.start.player.money, moneyAfter: day.observed.afterSleep.player.money,
      healthAfter: day.observed.afterSleep.player.health, submittedActions: day.observed.submittedActions, normalSleepConfirmed: true,
    }, target);
    const n = day.observed.night, before = day.observed.beforeSleep;
    if (!n) return; // Older reports have no observation; never invent a zero shipment.
    if (!before || dayNumber(before.date) !== dayNumber(day.observed.start.date)
      || !validNightReport(n, before, day.observed.afterSleep, this.identity, runId)) throw new PersistenceError('日终结算观察与本存档/日期/余额不一致，未补记结算经历。');
    if (n.status !== 'observed' || !n.native) return;
    const native = n.native, lines = native.shipping.lines;
    // A separate stable event preserves the historical normal_day_finished payload.
    // Source checkpoint precedes this write; offline backfill never repeats sleep.
    this.record(runId, `day:${day.day}:night`, 'native_night_observed', day.observed.start.date, {
      day: day.day, dateAfter: n.dateAfter, shippingDisplayTotal: native.shipping.total, categoryTotals: native.shipping.categoryTotals,
      beforeSleepMoney: n.wallet.beforeSleep, morningMoney: n.wallet.afterSleep, netSinceBeforeSleep: n.wallet.netSinceBeforeSleep,
      moneyAtDayEnding: native.moneyAtDayEnding, netSinceDayEnding: native.netChange, unclassifiedNetSinceDayEnding: n.unclassifiedNetSinceDayEnding!,
      creditCausalityVerified: false, totalLines: lines.length, detailsLimited: lines.length > 2,
      items: lines.slice(0, 2).map(l => ({ itemId: l.itemId, quality: l.quality, quantity: l.quantity, unitPrice: l.unitPrice, total: l.total })),
    }, target);
  }
  flush(sink?: StoryObserver): unknown {
    if (!sink) return { available: false };
    // Recent failed deliveries back off. Each call makes at most eight attempts.
    const entries = [...this.files];
    const report = { scanned: 0, attempted: 0, recorded: 0, forgotten: 0, pendingSeen: 0, total: entries.length, coverage: 'bounded_cursor_pass' };
    for (let checked = 0; checked < Math.min(entries.length, 64); checked++) {
      const [id, file] = entries[this.flushCursor % entries.length]; this.flushCursor = (this.flushCursor + 1) % entries.length;
      report.scanned++;
      const event = this.readFile(id);
      if (event.delivery.state !== 'pending') continue;
      report.pendingSeen++;
      if (event.delivery.lastAttemptAt && Date.now() - event.delivery.lastAttemptAt < 60000) continue;
      report.attempted++;
      event.delivery.attempts++; event.delivery.lastAttemptAt = Date.now();
      try {
        const result = sink.publish(event);
        if (result === 'recorded' || result === 'forgotten') { event.delivery.state = result; event.delivery.lastOutcome = result; report[result]++; }
        else event.delivery.lastOutcome = 'unavailable';
      }
      catch { event.delivery.lastOutcome = 'write_failed'; /* No raw memory text/paths in errors; no game action retry. */ }
      atomicJson(join(this.root, file), event);
      if (report.attempted >= 8) break;
    }
    return report;
  }
  list(source = '{}'): string {
    let args: any;
    try { args = JSON.parse(source); } catch { throw new Error('experiences需要JSON参数对象。'); }
    const offset = args?.offset ?? 0, limit = args?.limit ?? 6;
    if (!object(args) || Object.keys(args).some(k => !['offset', 'limit'].includes(k)) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('experiences只接受offset>=0和limit=1–20。');
    const files = [...this.files].sort((a, b) => b[1].localeCompare(a[1]));
    return JSON.stringify({ saveId: this.identity.saveId, total: files.length, offset, items: files.slice(offset, offset + limit).map(([id]) => this.readFile(id)),
      nextOffset: offset + limit < files.length ? offset + limit : null,
      note: '只读后端已核对的历史结果，按原存档/构建/游戏日期解释；不是当前库存、已喂饱、完整任务完成或工具授权。recordedAt是首次落盘时间，补记可能晚于发生；部分物品明细明确受限。没有历史Ref/菜单revision可重放。人物库遗忘与此独立游戏账本不是同一删除操作。' });
  }
}

import { object, positionOf, requireFact, type ObjectValue, type WorkflowIO } from '../workflow-context.js';
import { inventoryDelta, verifyInventoryChanges } from './inventory-receipt.js';
import { enterConstructionCatalogue, readConstructionFrame } from './construction.js';
import { constructionCameraRequest } from './construction-camera.js';
import { validConstructionColors } from './construction-colors.js';

const int = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && Number(v) >= lo && Number(v) <= hi;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const guid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v) && /[1-9a-f]/.test(v);
const skinId = (v: unknown): v is string | null => v === null || typeof v === 'string' && v.length > 0 && v.length <= 160;
const position = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: { locationId: { type: 'string' }, x: { type: 'integer', minimum: 0, maximum: 10000 }, y: { type: 'integer', minimum: 0, maximum: 10000 } } };
export const BUILDING_SKIN_WORKFLOW = {
  name: 'building_skin', title: '按真实外观选项切换准确建筑并核对涂色/施工变化', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_construction', 'dsh_construction', 'dsh_construction_skin', 'dsh_construction_paint', 'stardew_query_inventory'],
  conditionalTools: { counter: ['dsh_construction_entry', 'stardew_navigate'] },
  parameters: { type: 'object', additionalProperties: false, required: ['builder', 'buildingGuid', 'position', 'skinId', 'maxConstructionDays'], properties: {
    builder: { type: 'string', enum: ['Robin', 'Wizard'] }, buildingGuid: { type: 'string', format: 'uuid' }, position,
    skinId: { type: ['string', 'null'], description: '必须是实际原生可用外观ID；null明确选择基础外观' }, maxConstructionDays: { type: 'integer', minimum: 0, maximum: 10000 },
    allowColorReset: { type: 'boolean', default: false, description: '换皮立即把三组颜色Default置true；已有自定义涂色时必须明确许可，H/S/L保存值仍逐字段核对' },
    allowOpeningFallback: { type: 'boolean', default: false, description: '旧skin已不在加载数据中时，允许原生打开菜单先回退基础外观；不默许该副作用' },
    allowTintReset: { type: 'boolean', default: false }, entry: { type: 'string', enum: ['current', 'counter'], default: 'current' }, entryPosition: position,
    maxEntrySteps: { type: 'integer', minimum: 1, maximum: 32, default: 16 }, maxPanSteps: { type: 'integer', minimum: 0, maximum: 32, default: 16 },
    maxUiSteps: { type: 'integer', minimum: 4, maximum: 64, default: 32 }, maxCatalogueSteps: { type: 'integer', minimum: 0, maximum: 128, default: 64 }, closeAfter: { type: 'boolean', default: true },
  } },
  scope: '复用当前地点原生木匠/巫师入口与画笔模式，识别直接或调色菜单内的真实外观子菜单。只用实际已过滤外观，逐步正常前后选择；路径先模拟所有中间外观的默认色重置和原生施工天数，超许可不点击。变更即时生效，关闭不撤销；换皮成功不证明建筑完工。完整专用设施/拆除、全字段保全及持久pending恢复仍缺，全部实机验收pending。',
  postconditions: ['准确GUID/实例/原格到显式skinId或null基础外观；旧外观缺失的打开回退需明确许可', '每次切换按原生规则核对三组Default、保留H/S/L和Name、施工天数上限；其他建筑结构/颜色、完整背包/金币/资源和列明内部/住户/出口不变',
    '直接或嵌套菜单正常收尾；原生可能重建调色父菜单，用新状态核对，不持久复用旧菜单引用', '具体主人审核、原日预算/pending/F9；已知拒绝waiting，未知不回滚/重放，无可复用换皮授权'],
};

export async function buildingSkin(args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  requireFact(object(args) && Object.keys(args).every(k => ['builder', 'buildingGuid', 'position', 'skinId', 'maxConstructionDays', 'allowColorReset', 'allowOpeningFallback', 'allowTintReset', 'entry', 'entryPosition', 'maxEntrySteps', 'maxPanSteps', 'maxUiSteps', 'maxCatalogueSteps', 'closeAfter'].includes(k))
    && ['Robin', 'Wizard'].includes(args.builder) && guid(args.buildingGuid) && Object.prototype.hasOwnProperty.call(args, 'skinId') && skinId(args.skinId) && int(args.maxConstructionDays, 0, 10000), '换皮需要准确建筑GUID/原格、明确外观ID或null及施工天数上限。');
  const pos = positionOf(args.position), entry = args.entry ?? 'current', entryPosition = args.entryPosition === undefined ? undefined : positionOf(args.entryPosition);
  const maxPan = args.maxPanSteps ?? 16, maxUi = args.maxUiSteps ?? 32, maxCatalogue = args.maxCatalogueSteps ?? 64, closeAfter = args.closeAfter ?? true;
  const flags = { allowTintReset: args.allowTintReset ?? false, allowColorReset: args.allowColorReset ?? false, allowOpeningFallback: args.allowOpeningFallback ?? false };
  requireFact(Object.values(flags).every(v => typeof v === 'boolean') && typeof closeAfter === 'boolean' && ['current', 'counter'].includes(entry)
    && (entry === 'counter' ? entryPosition : entryPosition === undefined) && int(args.maxEntrySteps ?? 16, 1, 32) && int(maxPan, 0, 32) && int(maxUi, 4, 64) && int(maxCatalogue, 0, 128), '换皮许可、入口或操作上限无效。');
  io.needs(BUILDING_SKIN_WORKFLOW.requiredTools); if (entry === 'counter') io.needs(BUILDING_SKIN_WORKFLOW.conditionalTools.counter);
  const read = () => readConstructionFrame(pos.locationId, io, entryPosition, undefined, args.buildingGuid, args.buildingGuid);
  let latest = await read(), steps = 0;
  const state = (): ObjectValue => {
    const q = latest.query.skin; requireFact(object(q) && q.available === true && q.complete === true && sha(q.revision) && object(q.state), '没有完整原生外观快照。');
    const s = q.state, b = s.building;
    requireFact(object(b) && b.buildingGuid === args.buildingGuid && b.x === pos.x && b.y === pos.y && b.isMoving === false && validConstructionColors(s.colors)
      && latest.query.structures.some((r: ObjectValue) => JSON.stringify(r) === JSON.stringify(b)) && int(s.legacyTint, 0, 4294967295) && sha(s.preservationDigest)
      && object(s.data) && int(s.data.baseBuildDays, 0, 10000) && typeof s.data.currentDeclared === 'boolean' && Array.isArray(s.data.definitions) && s.data.definitions.length <= 256
      && s.data.definitions.every((r: unknown) => object(r) && typeof r.id === 'string' && skinId(r.id) && (r.buildDays === null || int(r.buildDays, 0, 10000)))
      && new Set(s.data.definitions.map((r: ObjectValue) => r.id)).size === s.data.definitions.length && typeof s.paintParentIdle === 'boolean'
      && (s.paintParentKey === null || key(s.paintParentKey)) && (s.paletteDigest === null || sha(s.paletteDigest))
      && Array.isArray(s.colorRoster) && s.colorRoster.length === latest.query.structures.length && s.colorRoster.every((r: unknown) => object(r) && guid(r.guid) && key(r.key) && int(r.tint, 0, 4294967295) && validConstructionColors(r.colors))
      && new Set(s.colorRoster.map((r: ObjectValue) => r.guid)).size === s.colorRoster.length
      && latest.query.structures.every((r: ObjectValue) => s.colorRoster.some((c: ObjectValue) => c.guid === r.buildingGuid && c.key === r.buildingKey))
      && s.colorRoster.some((r: ObjectValue) => r.guid === args.buildingGuid && r.tint === s.legacyTint && JSON.stringify(r.colors) === JSON.stringify(s.colors)), '建筑/加载外观数据/颜色/保护快照不完整。');
    if (s.menu !== null) {
      const m = s.menu; requireFact(object(m) && key(m.key) && key(m.selectedKey) && int(m.depth, 1, 2) && Array.isArray(m.offers) && m.offers.length > 0 && m.offers.length <= 256
        && m.offers.every((r: unknown, i: number) => object(r) && r.index === i && key(r.key) && skinId(r.id) && (r.buildDays === null || int(r.buildDays, 0, 10000)))
        && new Set(m.offers.map((r: ObjectValue) => r.id)).size === m.offers.length && new Set(m.offers.map((r: ObjectValue) => r.key)).size === m.offers.length
        && m.offers.some((r: ObjectValue) => r.key === m.selectedKey && r.id === b.skinId) && s.rootKey === latest.query.menu?.menuKey && s.paintParentIdle === true
        && (m.depth === 1 ? latest.query.menu?.childType === 'StardewValley.Menus.BuildingSkinMenu' && latest.query.menu.childKey === m.key && s.paintParentKey === null
          : latest.query.menu?.childType === 'StardewValley.Menus.BuildingPaintMenu' && latest.query.menu.childKey === s.paintParentKey), '真实直接/嵌套外观菜单与已过滤可用选项不完整。');
    }
    return s;
  };
  const initial = state(), initialBuilding = initial.building, protection = initial.preservationDigest;
  const observed = (observationOnly: boolean) => { const s = state(); io.observed('building_skin_verified', { buildingGuid: args.buildingGuid, position: pos, skinId: s.building.skinId,
    previousSkinId: initialBuilding.skinId, changedDuringWorkflow: s.building.skinId !== initialBuilding.skinId, observationOnly,
    constructionDays: s.building.constructionDays, upgradeDays: s.building.upgradeDays, constructionReady: s.building.constructionDays === 0 && s.building.upgradeDays === 0,
    defaultFlags: s.colors.regions.map((r: ObjectValue) => r.default), preservationVerified: true }); };
  if (initialBuilding.skinId === args.skinId && initial.data.currentDeclared && latest.query.menu === null
    && latest.query.state.menuType === null && io.port.current().ui.menuOpen === false) { observed(true); return 'completed'; }
  if (entry === 'counter' && !initial.menu && latest.query.menu?.onFarm !== true) {
    const opened = await enterConstructionCatalogue(args, io, read, latest, entryPosition!); if (!opened) return 'waiting'; latest = opened;
  }
  const root = latest.query.menu, menuKey = root?.menuKey, targetKey = latest.query.target.locationKey;
  requireFact(object(root) && key(menuKey) && root.builder === args.builder && root.targetLocationId === pos.locationId && root.targetLocationKey === targetKey && root.freeze === false && root.readOnly === false
    && (root.onFarm ? root.action === 3 : root.action === 0 && root.childType === null) && (entry !== 'counter' || root.builderLocationId === entryPosition!.locationId), '不是相同建造者/地点的目录、画笔模式或外观菜单。');
  const ready = () => { const s = io.port.current(); return s.timeOfDay < 2200 && s.player.health >= 20 && s.player.energy >= 30; };
  const step = async (operation: string, kind: 'skin' | 'generic' | 'paint' = 'skin', extra: ObjectValue = {}): Promise<ObjectValue> => {
    const before = latest, s = state(), old = before.query.menu, cleanup = ['done', 'cancel', 'close'].includes(operation);
    requireFact(steps < maxUi && (io.port.remainingActions?.() ?? 0) >= (cleanup ? 1 : 5) && (cleanup || ready()) && s.preservationDigest === protection
      && old?.menuKey === menuKey && old.builder === args.builder && before.query.target.locationKey === targetKey, '换皮会话/保护字段已变，或没有原日预算/流程预算/资源。');
    const common = { operation, locationId: pos.locationId, menuKey, revision: before.query.revision, structureDigest: before.query.structureDigest, inventoryDigest: before.query.state.inventoryDigest, expectedGold: before.query.state.money };
    const paint = before.query.paint;
    if (kind === 'paint') requireFact(paint?.available === true && paint.complete === true && sha(paint.revision) && paint.state?.ui, '没有真实、完整的调色父菜单收尾快照。');
    const payload = kind === 'generic' ? { ...common, blueprintKey: old.selected.blueprintKey, planDigest: old.planDigest, ...extra }
      : kind === 'paint' ? { ...common, buildingGuid: args.buildingGuid, position: pos, paintRevision: paint.revision, preservationDigest: protection,
        regionId: paint.state.ui.regions[paint.state.ui.currentRegion].id }
      : { ...common, buildingGuid: args.buildingGuid, position: pos, skinRevision: before.query.skin.revision, preservationDigest: protection, ...flags, maxConstructionDays: args.maxConstructionDays, ...extra };
    const outcome = await io.port.call(kind === 'generic' ? 'dsh_construction' : kind === 'paint' ? 'dsh_construction_paint' : 'dsh_construction_skin', payload); steps++;
    io.observed('building_skin_native_receipt', { operation, kind, status: outcome.status, output: outcome.output, error: outcome.error });
    if (outcome.status === 'failed') throw new Error('外观接口拒绝，不自动重试或补偿；保留实际外观/涂色。');
    if (outcome.status !== 'succeeded' || !object(outcome.output)) return io.uncertain('外观步骤结果未知，可能已切换或重置涂色；不回滚或重放。');
    const r = outcome.output; requireFact(r.nativeActionSubmitted !== false, '外观步骤在输入前停止。');
    try {
      requireFact(r.confirmedEffect === true && r.completedWorkflow === true && r.completionUncertain === false && r.nativeActionSubmitted === true && r.operation === operation
        && r.before?.revision === before.query.revision && r.goldBefore === before.query.state.money && r.goldAfter === r.goldBefore, '没有完整原生外观步骤收据。');
      latest = await read(); const after = state();
      requireFact(after.preservationDigest === protection && latest.query.target.locationKey === targetKey && latest.query.state.inventoryDigest === r.after?.state?.inventoryDigest
        && latest.query.state.money === r.goldAfter && latest.query.state.health === before.query.state.health && Math.abs(latest.query.state.energy - before.query.state.energy) <= 0.001, '独立库存/资源/内部保护字段与外观收据不符。');
      verifyInventoryChanges(before.inventory, latest.inventory, r.inventoryChanges); requireFact(inventoryDelta(before.inventory, latest.inventory).size === 0, '外观操作改变了物品。');
      let expectedId = s.building.skinId, days = s.building.constructionDays, selectedDays: number | null = null;
      if (kind === 'skin') {
        requireFact(r.buildingGuid === args.buildingGuid && r.preservationVerified === true && r.before?.skin?.revision === before.query.skin.revision
          && JSON.stringify(r.result) === JSON.stringify(after.building) && typeof r.skinOpened === 'boolean' && r.skinOpened === (after.menu !== null)
          && typeof r.paletteChecked === 'boolean' && (r.paletteChecked ? r.paletteUnchanged === true : r.paletteUnchanged === null), '准确外观/保护/色板收据不完整。');
        if (operation === 'open' && r.skinOpened && !s.data.currentDeclared) { requireFact(flags.allowOpeningFallback, '未授权打开回退。'); expectedId = null; }
        if (operation === 'next' || operation === 'previous') {
          const selected = s.menu.offers.find((o: ObjectValue) => o.key === s.menu.selectedKey), n = s.menu.offers.length;
          const next = s.menu.offers[(selected.index + (operation === 'next' ? 1 : n - 1)) % n]; expectedId = next.id; selectedDays = next.buildDays;
          requireFact(next.id === extra.expectedNextSkinId && after.menu?.selectedKey === next.key, '原生没有只前后切换到准确的下一项。');
        }
      } else if (kind === 'paint') requireFact(r.buildingGuid === args.buildingGuid && r.preservationVerified === true && r.paletteUnchanged === true, '调色父菜单关闭收据不完整。');
      const expectedColors = { name: s.colors.name, regions: s.colors.regions.map((c: ObjectValue) => ({ ...c })) };
      if (expectedId !== s.building.skinId) {
        requireFact(flags.allowColorReset || expectedColors.regions.every((c: ObjectValue) => c.default), '未授权重置自定义涂色。');
        if (days === s.data.baseBuildDays) days = selectedDays ?? s.data.baseBuildDays;
        requireFact(days <= args.maxConstructionDays, '原生施工天数超出许可。'); expectedColors.regions = expectedColors.regions.map((c: ObjectValue) => ({ ...c, default: true }));
      }
      const expected = { ...s.building, skinId: expectedId, constructionDays: days };
      const tint = kind === 'skin' && operation === 'open' && s.paintParentKey === null && after.childType !== null ? 4294967295 : s.legacyTint;
      requireFact(JSON.stringify(after.building) === JSON.stringify(expected) && JSON.stringify(after.colors) === JSON.stringify(expectedColors) && after.legacyTint === tint
        && latest.query.structures.length === before.query.structures.length
        && JSON.stringify(latest.query.structures.filter((b: ObjectValue) => b.buildingGuid !== args.buildingGuid)) === JSON.stringify(before.query.structures.filter((b: ObjectValue) => b.buildingGuid !== args.buildingGuid))
        && JSON.stringify(after.colorRoster.filter((b: ObjectValue) => b.guid !== args.buildingGuid)) === JSON.stringify(s.colorRoster.filter((b: ObjectValue) => b.guid !== args.buildingGuid))
        && (!s.paletteDigest || !after.paletteDigest || s.paletteDigest === after.paletteDigest), '其他建筑或皮肤/施工天数/三组涂色/旧式染色/色板不符合原生规则。');
      return r;
    } catch { return io.uncertain('外观输入已提交，但完整后续收据不符；不恢复外观、颜色或计时，不重放。'); }
  };
  const cleanup = async (): Promise<boolean> => {
    if (!closeAfter) return true; const s = state(), m = latest.query.menu;
    if (!m || m.menuKey !== menuKey) return false;
    if (!s.paintParentIdle || s.paintParentKey && !s.menu && !latest.query.paint?.state?.ui) return false;
    if (!s.menu && m.childType !== null && s.paintParentKey === null) return false;
    const needed = (s.menu ? 1 : 0) + (s.paintParentKey ? 1 : 0) + (m.onFarm ? 2 : 1);
    if (steps + needed > maxUi || (io.port.remainingActions?.() ?? 0) < needed) return false;
    if (state().menu) await step('done');
    if (state().paintParentKey && !state().menu) { requireFact(latest.query.paint?.state?.ui, '没有重建后的真实调色父菜单。'); await step('done', 'paint'); }
    if (latest.query.menu?.onFarm && latest.query.menu.childType === null) await step('cancel', 'generic');
    if (latest.query.menu && !latest.query.menu.onFarm && latest.query.menu.childType === null) await step('close', 'generic');
    return latest.query.menu === null && latest.query.state.menuType === null && io.port.current().ui.menuOpen === false;
  };
  const waiting = async (reason: string): Promise<'waiting'> => { await cleanup(); const s = state(); io.observed('building_skin_waiting', { buildingGuid: args.buildingGuid, reason,
    actualSkinId: s.building.skinId, immediateChangesRemain: JSON.stringify(s.colors) !== JSON.stringify(initial.colors) || s.legacyTint !== initial.legacyTint
      || s.building.skinId !== initialBuilding.skinId || s.building.constructionDays !== initialBuilding.constructionDays }); return 'waiting'; };
  if (!state().paintParentIdle) return waiting('existing_native_drag_not_owned');
  if (args.skinId !== null && !state().data.definitions.some((d: ObjectValue) => d.id === args.skinId)) return waiting('target_not_declared_in_loaded_data');
  if (state().building.skinId === args.skinId && state().data.currentDeclared) { observed(true); return await cleanup() ? 'completed' : 'waiting'; }
  if (!ready() || state().building.constructionDays > args.maxConstructionDays) return waiting('day_resource_or_existing_construction_limit');
  if (state().building.skinId !== args.skinId && !flags.allowColorReset && state().colors.regions.some((c: ObjectValue) => !c.default)) return waiting('custom_color_reset_not_authorized');
  if (!state().menu && !state().data.currentDeclared && !flags.allowOpeningFallback) return waiting('opening_fallback_not_authorized');
  if (!state().menu && !state().paintParentKey && state().legacyTint !== 4294967295 && !flags.allowTintReset) return waiting('legacy_tint_reset_not_authorized');
  if (!root.onFarm) { if (!root.paintVisible) return waiting('native_appearance_control_unavailable'); await step('enter_paint', 'generic'); }
  if (!state().menu && !state().paintParentKey) {
    const blocked = new Set<string>(); let pans = 0;
    for (;;) { const request = constructionCameraRequest(latest.query, pos, blocked); if (!request) break;
      if (pans++ >= maxPan || blocked.has(request.direction) || !ready() || steps + 5 >= maxUi) return waiting('appearance_camera_or_resource_limit');
      const r = await step('pan', 'generic', request); if (r.panDelta?.x === 0 && r.panDelta?.y === 0) blocked.add(request.direction); else blocked.clear(); }
  }
  for (let i = 0; i < 2 && !state().menu; i++) {
    if (steps + 5 >= maxUi || !ready()) return waiting('open_step_or_resource_limit');
    const r = await step('open'); if (!r.skinOpened && !r.paintOpened) return waiting('native_appearance_rejected');
  }
  const s = state(); if (!s.menu) return waiting('native_skin_menu_unavailable');
  const matches = s.menu.offers.filter((o: ObjectValue) => o.id === args.skinId); if (matches.length !== 1) return waiting('target_not_in_actual_filtered_offers');
  const from = s.menu.offers.find((o: ObjectValue) => o.key === s.menu.selectedKey).index, to = matches[0].index, count = s.menu.offers.length;
  const paths = ['next', 'previous'].map(direction => {
    const distance = direction === 'next' ? (to - from + count) % count : (from - to + count) % count;
    let days = s.building.constructionDays, id = s.building.skinId, valid = distance <= maxCatalogue;
    const visits: ObjectValue[] = [];
    for (let i = 1; i <= distance; i++) { const o = s.menu.offers[(from + (direction === 'next' ? i : count - i)) % count];
      if (o.id !== id && days === s.data.baseBuildDays) days = o.buildDays ?? s.data.baseBuildDays;
      if (days > args.maxConstructionDays) valid = false; id = o.id; visits.push(o); }
    return { direction, distance, valid, visits };
  }).filter(p => p.valid).sort((a, b) => a.distance - b.distance);
  if (!paths.length) return waiting('all_native_paths_exceed_duration_or_catalogue_limit');
  const offers = JSON.stringify(s.menu.offers);
  for (const next of paths[0].visits) {
    if (!ready() || steps + 4 >= maxUi || (io.port.remainingActions?.() ?? 0) < 5) return waiting('selection_or_cleanup_budget_limit');
    requireFact(JSON.stringify(state().menu?.offers) === offers, '实际外观选项改变，不沿用旧路径。'); await step(paths[0].direction, 'skin', { expectedNextSkinId: next.id });
  }
  requireFact(state().building.skinId === args.skinId, '实际目标外观未确认。'); observed(false);
  return await cleanup() ? 'completed' : 'waiting';
}

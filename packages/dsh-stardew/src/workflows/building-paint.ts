import { validConstructionColors as colors } from './construction-colors.js';
import { object, positionOf, requireFact, type ObjectValue, type WorkflowIO } from '../workflow-context.js';
import { inventoryDelta, verifyInventoryChanges } from './inventory-receipt.js';
import { constructionMenu, enterConstructionCatalogue, readConstructionFrame } from './construction.js';
import { constructionCameraRequest } from './construction-camera.js';

const int = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && Number(v) >= lo && Number(v) <= hi;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const guid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v) && /[1-9a-f]/.test(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const position = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: { locationId: { type: 'string' }, x: { type: 'integer', minimum: 0, maximum: 10000 }, y: { type: 'integer', minimum: 0, maximum: 10000 } } };
export const BUILDING_PAINT_WORKFLOW = {
  name: 'building_paint', title: '准确建筑分区的原生默认色与H/S/L调色', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_construction', 'dsh_construction', 'dsh_construction_paint', 'stardew_query_inventory'],
  conditionalTools: { counter: ['dsh_construction_entry', 'stardew_navigate'] },
  parameters: { type: 'object', additionalProperties: false, required: ['builder', 'buildingGuid', 'position', 'regions'], properties: {
    builder: { type: 'string', enum: ['Robin', 'Wizard'] }, buildingGuid: { type: 'string', format: 'uuid' }, position,
    regions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['id', 'mode'], properties: {
      id: { type: 'string', description: '实际原生分区ID，不能按本地化显示名猜索引' }, mode: { type: 'string', enum: ['default', 'custom'] },
      hue: { type: 'integer', minimum: -10000, maximum: 10000 }, saturation: { type: 'integer', minimum: -10000, maximum: 10000 }, lightness: { type: 'integer', minimum: -10000, maximum: 10000 },
    } } },
    allowTintReset: { type: 'boolean', default: false, description: '原生打开画笔会把旧式tint重置为白色；非白色时必须明确true。调色即时生效，关闭不会撤销。' },
    entry: { type: 'string', enum: ['current', 'counter'], default: 'current' }, entryPosition: position, maxEntrySteps: { type: 'integer', minimum: 1, maximum: 32, default: 16 },
    maxPanSteps: { type: 'integer', minimum: 0, maximum: 32, default: 16 }, maxUiSteps: { type: 'integer', minimum: 4, maximum: 64, default: 32 }, closeAfter: { type: 'boolean', default: true },
  } },
  scope: '当前已加载地点、准确建筑GUID/原格，复用原生木匠/巫师入口、画笔模式与真实调色子菜单。读取实际分区/滑条范围，默认色或完整H/S/L按原生点击/拖动回调设置；不能精确到达的值拒绝，不取近似值。按分区保留已核对的部分进度，关闭不回滚。不选择外观/共享色板保存按钮；换皮、全部专用设施、跨进程pending恢复和实机验收仍缺。',
  postconditions: ['准确GUID/分区的实际Default或H/S/L终值匹配，其他分区、其他建筑颜色与结构不变', '独立完整背包/金币/主角资源和明确内部/住户/出口保护字段不变，子菜单操作不改共享色板', '旧式tint重置单列且需许可；原生编辑即时生效，不把关闭当撤销，未知不补偿/重放', '主人具体审核、原日预算/pending/F9保留，无可复用调色授权；所有实机验收pending'],
};

export async function buildingPaint(args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  requireFact(object(args) && Object.keys(args).every(k => ['builder', 'buildingGuid', 'position', 'regions', 'allowTintReset', 'entry', 'entryPosition', 'maxEntrySteps', 'maxPanSteps', 'maxUiSteps', 'closeAfter'].includes(k))
    && ['Robin', 'Wizard'].includes(args.builder) && guid(args.buildingGuid) && Array.isArray(args.regions) && args.regions.length > 0 && args.regions.length <= 3
    && args.regions.every((r: unknown) => object(r) && Object.keys(r).every(k => ['id', 'mode', 'hue', 'saturation', 'lightness'].includes(k)) && text(r.id)
      && (r.mode === 'default' ? r.hue === undefined && r.saturation === undefined && r.lightness === undefined : r.mode === 'custom' && ['hue', 'saturation', 'lightness'].every(c => int(r[c], -10000, 10000))))
    && new Set(args.regions.map((r: ObjectValue) => r.id)).size === args.regions.length, '调色必须明确准确建筑、原格和唯一实际分区ID；custom需完整H/S/L，default不接受猜测色值。');
  const pos = positionOf(args.position), entry = args.entry ?? 'current', entryPosition = args.entryPosition === undefined ? undefined : positionOf(args.entryPosition);
  const maxPan = args.maxPanSteps ?? 16, maxUi = args.maxUiSteps ?? 32, closeAfter = args.closeAfter ?? true, allowTintReset = args.allowTintReset ?? false;
  requireFact(['current', 'counter'].includes(entry) && (entry === 'counter' ? entryPosition : entryPosition === undefined) && int(args.maxEntrySteps ?? 16, 1, 32)
    && int(maxPan, 0, 32) && int(maxUi, 4, 64) && typeof closeAfter === 'boolean' && typeof allowTintReset === 'boolean', '调色入口、操作上限或旧式染色许可无效。');
  io.needs(BUILDING_PAINT_WORKFLOW.requiredTools); if (entry === 'counter') io.needs(BUILDING_PAINT_WORKFLOW.conditionalTools.counter);
  const read = () => readConstructionFrame(pos.locationId, io, entryPosition, undefined, args.buildingGuid);
  let latest = await read(), steps = 0;
  const paint = (): ObjectValue => {
    const p = latest.query.paint; requireFact(object(p) && p.available === true && p.complete === true && sha(p.revision) && object(p.state), '没有完整原生建筑调色快照。');
    const s = p.state, b = s.building;
    requireFact(object(b) && b.buildingGuid === args.buildingGuid && b.x === pos.x && b.y === pos.y && b.isMoving === false && b.constructionDays === 0 && b.upgradeDays === 0
      && latest.query.structures.some((row: ObjectValue) => JSON.stringify(row) === JSON.stringify(b)) && colors(s.colors) && int(s.legacyTint, 0, 4294967295) && sha(s.preservationDigest)
      && Array.isArray(s.colorRoster) && s.colorRoster.length === latest.query.structures.length && s.colorRoster.every((r: unknown) => object(r) && guid(r.guid) && key(r.key) && int(r.tint, 0, 4294967295) && colors(r.colors))
      && new Set(s.colorRoster.map((r: ObjectValue) => r.guid)).size === s.colorRoster.length
      && latest.query.structures.every((b: ObjectValue) => s.colorRoster.some((r: ObjectValue) => r.guid === b.buildingGuid && r.key === b.buildingKey))
      && s.colorRoster.some((r: ObjectValue) => r.guid === args.buildingGuid && r.tint === s.legacyTint && JSON.stringify(r.colors) === JSON.stringify(s.colors)), '建筑身份/原位/颜色/其他建筑或保护字段不完整。');
    if (s.ui !== null) {
      const u = s.ui; requireFact(object(u) && key(u.key) && latest.query.menu?.childKey === u.key && latest.query.menu?.childType === 'StardewValley.Menus.BuildingPaintMenu'
        && s.rootKey === latest.query.menu.menuKey && u.activeSliderKey === null && int(u.currentRegion, 0, 2) && sha(u.paletteDigest)
        && Array.isArray(u.regions) && u.regions.length > 0 && u.regions.length <= 3 && u.currentRegion < u.regions.length
        && u.regions.every((r: unknown, i: number) => object(r) && r.index === i && text(r.id)) && new Set(u.regions.map((r: ObjectValue) => r.id)).size === u.regions.length
        && Array.isArray(u.sliders) && u.sliders.length === 3 && ['hue', 'saturation', 'lightness'].every(c => u.sliders.filter((r: ObjectValue) => r.channel === c && key(r.key)
          && int(r.min, -10000, 10000) && int(r.max, r.min + 1, 10000) && int(r.value, r.min, r.max) && Array.isArray(r.reachableValues)
          && r.reachableValues.length <= 20003 && r.reachableValues.every((v: unknown) => int(v, r.min, r.max))
          && new Set(r.reachableValues).size === r.reachableValues.length).length === 1), '原生分区/活动拖动/真实滑条范围/可达值/共享色板不完整。');
    }
    return s;
  };
  const protection = paint().preservationDigest, initialColors = paint().colors, initialTint = paint().legacyTint;
  if (entry === 'counter' && !paint().ui && latest.query.menu?.onFarm !== true) {
    const opened = await enterConstructionCatalogue(args, io, read, latest, entryPosition!); if (!opened) return 'waiting'; latest = opened;
  }
  const root = latest.query.menu, menuKey = root?.menuKey, targetKey = latest.query.target.locationKey;
  requireFact(object(root) && key(menuKey) && root.builder === args.builder && root.targetLocationId === pos.locationId && root.targetLocationKey === targetKey && root.freeze === false && root.readOnly === false
    && (root.onFarm ? root.action === 3 : root.action === 0 && root.childType === null) && (entry !== 'counter' || root.builderLocationId === entryPosition!.locationId), '不是该建造者/地点的目录、画笔模式或准确调色子菜单。');
  const ready = () => { const s = io.port.current(); return s.timeOfDay < 2200 && s.player.health >= 20 && s.player.energy >= 30; };
  const step = async (operation: string, extra: ObjectValue = {}, generic = false): Promise<ObjectValue> => {
    const before = latest, capture = paint(), old = before.query.menu, cleanup = ['done', 'cancel', 'close'].includes(operation);
    requireFact(steps < maxUi && (io.port.remainingActions?.() ?? 0) >= (cleanup ? 1 : 4) && (cleanup || ready()), '没有原日剩余动作/流程预算或已到资源收尾条件，保留实际颜色，不回滚。');
    requireFact(old?.menuKey === menuKey && old.builder === args.builder && before.query.target.locationKey === targetKey && capture.preservationDigest === protection, '调色会话或保护字段已变。');
    const common = { operation, locationId: pos.locationId, menuKey, revision: before.query.revision, structureDigest: before.query.structureDigest, inventoryDigest: before.query.state.inventoryDigest, expectedGold: before.query.state.money };
    const outcome = await io.port.call(generic ? 'dsh_construction' : 'dsh_construction_paint', generic ? { ...common, blueprintKey: old.selected.blueprintKey, planDigest: old.planDigest, ...extra }
      : { ...common, buildingGuid: args.buildingGuid, position: pos, paintRevision: before.query.paint.revision, preservationDigest: protection,
        ...(capture.ui ? { regionId: capture.ui.regions[capture.ui.currentRegion].id } : {}), ...extra }); steps++;
    io.observed('building_paint_native_receipt', { operation, status: outcome.status, output: outcome.output, error: outcome.error });
    if (outcome.status === 'failed') throw new Error('调色预检/接口拒绝，不重试或自动恢复颜色。');
    if (outcome.status !== 'succeeded' || !object(outcome.output)) return io.uncertain('调色结果未知，颜色可能已即时改变；不重放或回滚。');
    const r = outcome.output; requireFact(r.nativeActionSubmitted !== false, '原生调色在输入前停止。');
    try {
      requireFact(r.confirmedEffect === true && r.completedWorkflow === true && r.completionUncertain === false && r.nativeActionSubmitted === true && r.operation === operation
        && r.before?.revision === before.query.revision && r.goldBefore === before.query.state.money && r.goldAfter === r.goldBefore, '原生调色缺少准确步骤/资源收据。');
      latest = await read(); const after = paint();
      requireFact(latest.query.target.locationKey === targetKey && latest.query.state.inventoryDigest === r.after?.state?.inventoryDigest && latest.query.state.money === r.goldAfter
        && latest.query.state.health === before.query.state.health && Math.abs(latest.query.state.energy - before.query.state.energy) <= 0.001 && after.preservationDigest === protection
        && JSON.stringify(latest.query.structures) === JSON.stringify(before.query.structures), '独立完整资源/建筑或内部保护字段不符合收据。');
      verifyInventoryChanges(before.inventory, latest.inventory, r.inventoryChanges); requireFact(inventoryDelta(before.inventory, latest.inventory).size === 0, '调色改变了背包物品。');
      const expected = { name: capture.colors.name, regions: capture.colors.regions.map((r: ObjectValue) => ({ ...r })) };
      if (!generic) {
        requireFact(r.buildingGuid === args.buildingGuid && r.preservationVerified === true && r.before?.paint?.revision === before.query.paint.revision
          && JSON.stringify(r.colorsBefore) === JSON.stringify(capture.colors) && JSON.stringify(r.colorsAfter) === JSON.stringify(after.colors) && r.tintBefore === capture.legacyTint && r.tintAfter === after.legacyTint
          && (operation === 'open' ? typeof r.openRejected === 'boolean' && typeof r.paintOpened === 'boolean' && (!r.openRejected || r.paintOpened === false && after.ui === null)
            : r.paletteUnchanged === true), '调色目标、颜色/旧式染色或共享色板收据不符。');
        if (operation === 'default') expected.regions[capture.ui.currentRegion].default = true;
        if (operation === 'slider') {
          const values = Object.fromEntries(capture.ui.sliders.map((s: ObjectValue) => [s.channel, s.channel === extra.channel ? extra.value : s.value]));
          expected.regions[capture.ui.currentRegion] = { index: capture.ui.currentRegion, default: false, hue: values.hue, saturation: values.saturation, lightness: values.lightness };
        }
      }
      requireFact(JSON.stringify(after.colors) === JSON.stringify(expected) && after.legacyTint === (!generic && operation === 'open' && !r.openRejected ? 4294967295 : capture.legacyTint)
        && JSON.stringify(after.colorRoster.filter((b: ObjectValue) => b.guid !== args.buildingGuid)) === JSON.stringify(capture.colorRoster.filter((b: ObjectValue) => b.guid !== args.buildingGuid))
        && (!capture.ui || !after.ui || after.ui.paletteDigest === capture.ui.paletteDigest), '实际分区/其他建筑/旧式染色或色板变化不符合批准的操作。');
      return r;
    } catch { return io.uncertain('调色输入已提交但完整独立收据未确认；保留现场，不回滚或重放。'); }
  };
  const close = async () => {
    if (!closeAfter) return;
    if (paint().ui) await step('done');
    if (latest.query.menu?.menuKey === menuKey && latest.query.menu.childType === null && latest.query.menu.onFarm) await step('cancel', {}, true);
    if (latest.query.menu?.menuKey === menuKey && latest.query.menu.childType === null && !latest.query.menu.onFarm) await step('close', {}, true);
  };
  const waiting = async (reason: string): Promise<'waiting'> => {
    const needed = paint().ui ? 3 : latest.query.menu?.childType ? 0 : latest.query.menu?.onFarm ? 2 : 1;
    if (closeAfter && steps + needed <= maxUi && (io.port.remainingActions?.() ?? 0) >= needed) await close();
    io.observed('building_paint_waiting', { buildingGuid: args.buildingGuid, reason,
      immediateChangesRemain: JSON.stringify(paint().colors) !== JSON.stringify(initialColors) || paint().legacyTint !== initialTint }); return 'waiting';
  };
  if (!ready()) return waiting('day_or_resource_limit');
  if (!paint().ui && paint().legacyTint !== 4294967295 && !allowTintReset) return waiting('legacy_tint_reset_not_authorized');
  if (!root.onFarm) { constructionMenu(latest); if (!root.paintVisible) return waiting('native_paint_control_unavailable'); await step('enter_paint', {}, true); }
  if (!paint().ui) {
    if (latest.query.menu?.childType !== null) return waiting('unexpected_native_child');
    const blocked = new Set<string>(); let pans = 0;
    for (;;) {
      const request = constructionCameraRequest(latest.query, pos, blocked); if (!request) break;
      if (pans++ >= maxPan || blocked.has(request.direction) || !ready() || steps + 4 >= maxUi) return waiting('paint_camera_or_resource_limit');
      const r = await step('pan', request, true); if (r.panDelta?.x === 0 && r.panDelta?.y === 0) blocked.add(request.direction); else blocked.clear();
    }
    const r = await step('open', { allowTintReset });
    if (r.tintBefore !== r.tintAfter) io.observed('building_legacy_tint_reset_verified', { buildingGuid: args.buildingGuid, position: pos, before: r.tintBefore, after: r.tintAfter });
    if (!r.paintOpened || !paint().ui) return waiting('native_paint_ineligible_or_appearance_menu');
  }
  for (const wanted of args.regions) {
    let s = paint(), u = s.ui; const matches = u.regions.filter((r: ObjectValue) => r.id === wanted.id);
    if (matches.length !== 1) return waiting('requested_native_region_unavailable');
    const index = matches[0].index, before = s.colors.regions[index];
    while (u.currentRegion !== index) {
      if (steps + 4 >= maxUi || !ready()) return waiting('region_step_or_resource_limit');
      const n = u.regions.length, forward = (index - u.currentRegion + n) % n, back = (u.currentRegion - index + n) % n;
      await step(forward <= back ? 'next' : 'previous'); s = paint(); u = s.ui;
    }
    if (wanted.mode === 'default') {
      if (!s.colors.regions[index].default) { if (!ready() || steps + 3 >= maxUi) return waiting('default_step_or_resource_limit'); await step('default'); }
    } else {
      for (const c of ['hue', 'saturation', 'lightness']) { const slider = u.sliders.find((r: ObjectValue) => r.channel === c);
        if (!int(wanted[c], slider.min, slider.max) || !slider.reachableValues.includes(wanted[c])) return waiting('requested_value_outside_actual_region_range_or_geometry'); }
      // A default region whose stored sliders already equal the requested HSL
      // needs one explicit native nudge; an unchanged slider never calls back.
      if (s.colors.regions[index].default && u.sliders.every((r: ObjectValue) => r.value === wanted[r.channel])) {
        const h = u.sliders.find((r: ObjectValue) => r.channel === 'hue');
        const nudge = h.reachableValues.filter((v: number) => v !== h.value).sort((a: number, b: number) => Math.abs(a - h.value) - Math.abs(b - h.value))[0]; if (nudge === undefined) return waiting('no_exact_activation_value_in_actual_geometry');
        if (!ready() || steps + 5 >= maxUi) return waiting('activation_step_or_resource_limit');
        await step('slider', { channel: 'hue', value: nudge });
      }
      for (const channel of ['hue', 'saturation', 'lightness']) {
        const current = paint().ui.sliders.find((r: ObjectValue) => r.channel === channel);
        if (current.value !== wanted[channel]) { if (!ready() || steps + 3 >= maxUi) return waiting('channel_step_or_resource_limit'); await step('slider', { channel, value: wanted[channel] }); }
      }
    }
    const actual = paint().colors.regions[index];
    requireFact(wanted.mode === 'default' ? actual.default === true : actual.default === false && ['hue', 'saturation', 'lightness'].every(c => actual[c] === wanted[c]), '实际分区终值未确认。');
    io.observed('building_paint_region_verified', { buildingGuid: args.buildingGuid, position: pos, regionId: wanted.id, ...actual,
      changedDuringWorkflow: JSON.stringify(before) !== JSON.stringify(actual), preservationVerified: true, immediateEffect: true });
  }
  await close(); return 'completed';
}

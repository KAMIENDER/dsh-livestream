import { constructionCameraRequest } from './construction-camera.js';
import { object, positionOf, requireFact, samePosition, type ObjectValue, type WorkflowIO } from '../workflow-context.js';
import { inventoryDelta, verifyInventoryChanges, verifyNativeInventory } from './inventory-receipt.js';

const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const guid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000';
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\x00-\x1f]/.test(v);
const itemId = (v: unknown): v is string => typeof v === 'string' && /^\(O\)[^\s\x00-\x1f]{1,128}$/.test(v);
const skin = (v: unknown) => v === null || v === '' || text(v);
const positionSchema = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: {
  locationId: { type: 'string' }, x: { type: 'integer', minimum: 0, maximum: 10000 }, y: { type: 'integer', minimum: 0, maximum: 10000 },
} };
export const CONSTRUCTION_WORKFLOW = {
  name: 'building_construct', title: '真实木匠菜单建造/升级、材料扣款与施工收据', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_construction', 'dsh_construction', 'stardew_query_inventory', 'dsh_query_dialogue', 'dsh_dialogue'],
  conditionalTools: { counter: ['dsh_construction_entry', 'stardew_navigate'] },
  parameters: { type: 'object', additionalProperties: false,
    required: ['mode', 'builder', 'blueprintId', 'skinId', 'position', 'maxGold', 'materialBudget'], properties: {
      mode: { type: 'string', enum: ['build', 'upgrade'] }, builder: { type: 'string', enum: ['Robin', 'Wizard'] }, blueprintId: { type: 'string' }, skinId: { type: ['string', 'null'] }, position: positionSchema,
      buildingGuid: { type: 'string', format: 'uuid', description: 'upgrade必填当前实际建筑持久GUID；build禁止' }, maxGold: { type: 'integer', minimum: 0, maximum: 1000000000 },
      materialBudget: { type: 'array', maxItems: 128, items: { type: 'object', additionalProperties: false, required: ['itemId', 'quality', 'maxCount'], properties: {
        itemId: { type: 'string' }, quality: { type: 'integer', minimum: 0, maximum: 4 }, maxCount: { type: 'integer', minimum: 1, maximum: 10000 },
      } } }, entry: { type: 'string', enum: ['current', 'counter'], default: 'current' }, entryPosition: positionSchema,
      maxEntrySteps: { type: 'integer', minimum: 1, maximum: 32, default: 16 },
      maxCatalogueSteps: { type: 'integer', minimum: 0, maximum: 128, default: 64 }, maxPanSteps: { type: 'integer', minimum: 0, maximum: 32, default: 16 }, closeAfter: { type: 'boolean', default: true },
    } },
  scope: 'current复用已打开真实菜单；counter从当前地点已查询的Robin柜台/WizardBook正常导航/交互，经真实Construct和有界地点分页打开对应菜单，不绕过营业/施工/墨水条件。选择实际图纸/皮肤、有限放置镜头，在明确格新建或升级准确建筑GUID。预算/原生扣款/独立收据，仍施工waiting并保存持久GUID；不赶工。搬移/涂色/换皮另有源码流程。跨地图路线、所有房屋升级、拆除和持久中断续接仍待做。',
  postconditions: ['实际菜单/建造者/可用图纸/材料与地点绑定，不创建菜单、图纸、建筑或原料来探测', '预算覆盖原生按ID索引的所有可能品质分配，实际扣款/完整库存/其他建筑核对', '一次正常原生点击，等待锁回调、真实建筑变化和返回建造者地点；未知不重下', '施工开始与最终建成分开；仅真实0施工/升级计时且目标类型符合才记ready，主人具体审核，无可复用建造授权'],
};
export const CONSTRUCTION_FOLLOWUP = {
  name: 'building_followup', title: '按持久建筑GUID复查施工/升级与实际就绪', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_construction', 'stardew_query_inventory'],
  parameters: { type: 'object', additionalProperties: false, required: ['buildingGuid', 'blueprintId', 'position'], properties: {
    buildingGuid: { type: 'string', format: 'uuid' }, blueprintId: { type: 'string' }, position: positionSchema,
  } },
  scope: '只读当前实际加载地点和持久建筑GUID，不使用旧菜单/实例key执行操作；可依据已核对的施工经历跨天/重载复查。当前就绪不证明这次复查造成建造，也不伪造历史扣款或消除未确认的旧pending动作。',
  postconditions: ['新Native与独立MCP完整背包/资源一致，准确建筑GUID、类型和位置匹配', '0施工/升级计时才ready；仍施工waiting，缺失/替换/位置变化不自动建第二座'],
};
interface Frame { query: ObjectValue; inventory: ObjectValue }
async function frame(locationId: string, io: WorkflowIO, entryPosition?: ObjectValue, move?: { buildingGuid: string; position: ObjectValue }, paintBuildingGuid?: string, skinBuildingGuid?: string, demolishBuildingGuid?: string): Promise<Frame> {
  const query = { locationId, ...(entryPosition ? { entryPosition } : {}), ...(move ? { moveBuildingGuid: move.buildingGuid, movePosition: move.position } : {}), ...(paintBuildingGuid ? { paintBuildingGuid } : {}), ...(skinBuildingGuid ? { skinBuildingGuid } : {}), ...(demolishBuildingGuid ? { demolishBuildingGuid } : {}) };
  const first = await io.call('dsh_query_construction', query), inventory = await io.inventory(), q = await io.call('dsh_query_construction', query);
  requireFact(q.available === true && q.complete === true && sha(q.revision) && first.revision === q.revision && object(q.state)
    && first.entry?.revision === q.entry?.revision && (!move || first.move?.preservationDigest === q.move?.preservationDigest
      && first.move?.groundDigest === q.move?.groundDigest && first.move?.exitDigest === q.move?.exitDigest)
    && (!paintBuildingGuid || first.paint?.revision === q.paint?.revision)
    && (!skinBuildingGuid || first.skin?.revision === q.skin?.revision)
    && (!demolishBuildingGuid || first.demolition?.revision === q.demolition?.revision)
    && sha(q.state.inventoryDigest) && sha(q.structureDigest) && object(q.target) && q.target.locationId === locationId && key(q.target.locationKey)
    && int(q.target.width, 1, 10000) && int(q.target.height, 1, 10000) && Array.isArray(q.structures) && q.structures.length <= 256,
  '实际木匠/完整建筑/背包快照缺失或在独立读取期间变化。');
  const p = io.port.current().player;
  const actorPosition = positionOf(q.actorPosition), scenePosition = positionOf(q.state.position);
  // Carpenter placement changes the viewed scene and viewingLocation before a
  // real return warp. Keep both actual native positions explicit; a UI view is
  // not proof that the actor navigated to the farm. Adapters can project the
  // actor or that native scene only while this exact viewing state is observed.
  const viewing = q.menu?.onFarm === true && q.viewingLocation === q.menu.targetLocationId && scenePosition.locationId === q.menu.targetLocationId;
  requireFact(p.money === String(q.state.money) && p.health === q.state.health && Number.isFinite(q.state.energy) && Math.abs(p.energy - q.state.energy) <= 0.001
    && (samePosition(p.position, actorPosition) || viewing && samePosition(p.position, scenePosition))
    && (viewing || samePosition(actorPosition, scenePosition)) && q.state.eventUp === false && q.state.fading === false, '独立主角资源/位置与Native建造/实际查看场景不符。');
  verifyNativeInventory(inventory, q.state.inventoryCounts);
  requireFact(q.structures.every((b: unknown) => object(b) && guid(b.buildingGuid) && key(b.buildingKey) && text(b.type) && text(b.nativeType) && b.native === true
    && skin(b.skinId) && (b.upgradeName === null || b.upgradeName === '' || text(b.upgradeName)) && int(b.x, 0, 10000) && int(b.y, 0, 10000)
    && int(b.width, 1, 128) && int(b.height, 1, 128) && int(b.constructionDays, 0, 10000) && int(b.upgradeDays, 0, 10000) && typeof b.owner === 'string' && typeof b.isMoving === 'boolean')
    && new Set(q.structures.map((b: ObjectValue) => b.buildingGuid)).size === q.structures.length, '建筑GUID重复、缺字段、超限或含未知原生类型。');
  return { query: q, inventory };
}

// Relocation reuses the exact entry and independent inventory/state readers;
// selecting a different workflow does not invent another carpenter session.
export { frame as readConstructionFrame, menu as constructionMenu, enterCatalogue as enterConstructionCatalogue };
export type { Frame as ConstructionFrame };
function menu(f: Frame): ObjectValue {
  const m = f.query.menu;
  requireFact(object(m) && key(m.menuKey) && text(m.builder) && text(m.builderLocationId) && typeof m.onFarm === 'boolean' && int(m.action, 0, 10)
    && m.active !== false && m.freeze === false && m.readOnly === false && m.fading === false && (m.childType === null || m.childType === undefined) && key(m.targetLocationKey) && sha(m.planDigest) && m.previewNative === true
    && object(m.selected) && key(m.selected.blueprintKey) && int(m.selected.index, 0, 255) && text(m.selected.id) && skin(m.selected.skinId)
    && int(m.selected.cost, -1, 2147483647) && int(m.selected.days, -1, 10000) && int(m.selected.width, 1, 128) && int(m.selected.height, 1, 128)
    && typeof m.selected.upgrade === 'boolean' && Array.isArray(m.offers) && m.offers.length > 0 && m.offers.length <= 256
    && m.offers.every((o: unknown) => object(o) && key(o.blueprintKey) && int(o.index, 0, m.offers.length - 1) && text(o.id) && skin(o.skinId))
    && new Set(m.offers.map((o: ObjectValue) => o.index)).size === m.offers.length && new Set(m.offers.map((o: ObjectValue) => o.blueprintKey)).size === m.offers.length
    && m.offers.some((o: ObjectValue) => o.blueprintKey === m.selected.blueprintKey && o.index === m.selected.index && o.id === m.selected.id && o.skinId === m.selected.skinId)
    && Array.isArray(m.materials) && m.materials.length <= 128 && m.materials.every((r: unknown) => object(r) && itemId(r.itemId) && int(r.amount, 1, 1280000))
    && new Set(m.materials.map((r: ObjectValue) => r.itemId)).size === m.materials.length, '没有实际、完整、可操作的原生木匠菜单/图纸和已创建的材料模板。');
  return m;
}
const identity = (b: ObjectValue) => ({ buildingGuid: b.buildingGuid, type: b.type, skinId: b.skinId, upgradeName: b.upgradeName,
  x: b.x, y: b.y, width: b.width, height: b.height, constructionDays: b.constructionDays, upgradeDays: b.upgradeDays });

/** A native business/constructor selector is not an NPC dialogue attribution.
 * Its dedicated adapter verifies the actual key and cached callback, and never
 * chooses an arbitrary response or directly invokes a constructor. */
async function enterCatalogue(args: ObjectValue, io: WorkflowIO, read: () => Promise<Frame>, initial: Frame, entryPosition: ReturnType<typeof positionOf>): Promise<Frame | null> {
  let latest = initial, writes = 0, opened = false, selectorDigest = '';
  const cap = args.maxEntrySteps ?? 16, visitedPages = new Set<string>();
  const waiting = (reason: string) => { io.observed('construction_entry_waiting', { reason, writes, targetCatalogueVerified: false }); return null; };
  const invoke = async (operation: string, extra: ObjectValue): Promise<ObjectValue | null> => {
    requireFact((io.port.remainingActions?.() ?? 0) >= (operation === 'leave' ? 1 : 5), '保留原日入口操作及取消/后续建造预算。');
    const before = latest, e = before.query.entry;
    const result = await io.port.call('dsh_construction_entry', { operation, builder: args.builder, targetLocationId: args.position.locationId,
      revision: e.revision, inventoryDigest: before.query.state.inventoryDigest, structureDigest: before.query.structureDigest,
      expectedGold: before.query.state.money, ...extra }); writes++;
    io.observed('construction_entry_native_receipt', { operation, status: result.status, output: result.output, error: result.error });
    if (result.status === 'failed') return null; // Native Prepare rejects before input; no implicit retry.
    if (result.status !== 'succeeded' || !object(result.output)) return io.uncertain('建造入口/选项结果未知，可能已交互；不重放。');
    const r = result.output;
    if (r.nativeActionSubmitted === false && r.completionUncertain === false) return null;
    try {
      requireFact(r.confirmedEffect === true && r.completedWorkflow === true && r.completionUncertain === false && r.nativeInputSubmitted === true
        && r.operation === operation && r.builder === args.builder && r.targetLocationId === args.position.locationId && typeof r.entryAvailable === 'boolean'
        && r.before?.entry?.revision === e.revision && r.goldBefore === before.query.state.money && r.goldAfter === r.goldBefore && object(r.after?.state),
      '原生建造入口/精确选项、零消费收据不完整。');
      latest = await read();
      requireFact(latest.query.state.inventoryDigest === r.after.state.inventoryDigest && latest.query.state.money === before.query.state.money
        && latest.query.state.health === before.query.state.health && Math.abs(latest.query.state.energy - before.query.state.energy) <= 0.001
        && JSON.stringify(latest.query.structures) === JSON.stringify(before.query.structures), '独立资源/完整建筑状态与入口收据不一致。');
      verifyInventoryChanges(before.inventory, latest.inventory, r.inventoryChanges);
      requireFact(inventoryDelta(before.inventory, latest.inventory).size === 0, '入口/翻页/选项发生非预期物品变化。'); return r;
    } catch { return io.uncertain('入口操作已提交，但独立零消费/建筑结果未完整确认，停止接管不重放。'); }
  };
  // Poll readiness separately from the approved input count. Native typing and
  // animation are observations, never extra clicks or a fresh action budget.
  for (let polls = 0; polls < 96; polls++) {
    if (latest.query.menu) {
      const m = menu(latest);
      if (m.builder !== args.builder || m.builderLocationId !== entryPosition.locationId || m.targetLocationId !== args.position.locationId || m.onFarm || m.action !== 0)
        return waiting('native_catalogue_does_not_match_target');
      io.observed('construction_entry_verified', { builder: m.builder, sourceLocationId: m.builderLocationId,
        targetLocationId: m.targetLocationId, targetCatalogueVerified: true, reusedWithoutEntryInput: writes === 0, writes, goldSpent: 0, constructionStarted: false }); return latest;
    }
    const e = latest.query.entry;
    requireFact(object(e) && sha(e.revision) && key(e.sourceLocationKey) && e.sourceLocationId === entryPosition.locationId
      && int(e.sourceWidth, 1, 10000) && int(e.sourceHeight, 1, 10000) && Array.isArray(e.stations), '实际入口地点或原生入口能力缺失/改变。');
    if (writes >= cap) return waiting('entry_input_cap');
    if (!io.port.current().ui.menuOpen) {
      if (opened) return waiting('native_entry_did_not_open_constructor');
      io.ready(entryPosition.locationId);
      const station = e.stations.find((s: ObjectValue) => s.builder === args.builder && samePosition(positionOf(s.position), entryPosition));
      requireFact(station && station.clear === true && sha(station.stationDigest) && (args.builder === 'Robin' ? station.action === 'Carpenter' && station.approach === 'south_adjacent'
        : station.action === 'WizardBook' && station.approach === 'adjacent'), '没有准确、未被占用的真实木匠入口；不按名字或屏幕外观猜。');
      const p = io.port.current().player.position;
      const adjacent = args.builder === 'Robin' ? p.x === entryPosition.x && p.y === entryPosition.y + 1
        : Math.abs(p.x - entryPosition.x) + Math.abs(p.y - entryPosition.y) === 1;
      if (!adjacent) {
        requireFact((io.port.remainingActions?.() ?? 0) >= 6, '保留导航、入口及后续取消/建造的原日预算。');
        const before = latest, destination = args.builder === 'Robin' ? { ...entryPosition, y: entryPosition.y + 1 } : entryPosition;
        requireFact(destination.y < e.sourceHeight, '柜台南侧站位越界，未导航。');
        const outcome = await io.port.call('stardew_navigate', { position: destination, arrival: args.builder === 'Robin' ? 'exact' : 'adjacent' }); writes++;
        io.observed('construction_entry_navigation_receipt', { status: outcome.status, output: outcome.output, error: outcome.error });
        if (outcome.status !== 'succeeded') return outcome.status === 'failed' ? waiting('native_entry_navigation_rejected') : io.uncertain('建造入口导航结果未知，不重走。');
        try {
          latest = await read(); const actual = io.port.current().player.position;
          requireFact(actual.locationId === entryPosition.locationId && (args.builder === 'Robin' ? samePosition(actual, destination)
            : Math.abs(actual.x - entryPosition.x) + Math.abs(actual.y - entryPosition.y) === 1)
            && [...inventoryDelta(before.inventory, latest.inventory).values()].every(n => n >= 0) && latest.query.state.money >= before.query.state.money
            && latest.query.state.health >= before.query.state.health && latest.query.state.energy + 0.001 >= before.query.state.energy
            && JSON.stringify(latest.query.structures) === JSON.stringify(before.query.structures), '入口导航实际到达或资源/建筑结果不同。');
        } catch { return io.uncertain('导航已提交但真实入口到达/资源收据未确认，不重走或交互。'); }
        continue;
      }
      const r = await invoke('open', { position: entryPosition, stationDigest: station.stationDigest }); opened = true;
      if (!r) return waiting('native_entry_precondition_rejected');
      if (!r.entryAvailable) return waiting('native_business_or_unlock_unavailable');
      continue;
    }
    if (e.builder !== args.builder || !['service_question', 'location_question'].includes(e.phase)) return waiting('native_feedback_is_not_a_known_construction_question');
    const d = e.dialogue;
    requireFact(object(d) && d.open === true && d.isQuestion === true && sha(d.revision) && typeof d.text === 'string'
      && typeof d.revealed === 'boolean' && typeof d.choicesReady === 'boolean' && Array.isArray(d.options) && d.options.length <= 256
      && d.options.every((o: unknown) => object(o) && typeof o.key === 'string' && typeof o.text === 'string' && typeof o.visible === 'boolean'),
    '原生入口问题或完整可见选项缺失。');
    if (!d.ready || d.revealed && !d.choicesReady) { await new Promise(resolve => setTimeout(resolve, 100)); latest = await read(); continue; }
    let operation = 'reveal', responseKey: string | undefined;
    if (d.revealed) {
      if (e.phase === 'service_question') { operation = 'choose_construct'; responseKey = 'Construct'; }
      else {
        requireFact(sha(e.pagedDigest) && int(e.page, 0, 512) && Array.isArray(e.locationIds) && e.locationIds.length <= 512
          && e.locationIds.every(text) && new Set(e.locationIds).size === e.locationIds.length, '原生地点缓存/回调或页码不完整。');
        selectorDigest ||= e.pagedDigest; requireFact(selectorDigest === e.pagedDigest, '实际地点构造回调/完整列表改变，未沿用旧选项。');
        if (!e.locationIds.includes(args.position.locationId)) {
          if (args.closeAfter !== false && d.options.some((o: ObjectValue) => o.key === 'cancel' && o.visible === true)) {
            const cancel = d.options.find((o: ObjectValue) => o.key === 'cancel' && o.visible === true);
            await invoke('leave', { expectedText: d.text, responseKey: cancel.key, responseText: cancel.text });
          }
          return waiting('target_location_not_offered');
        }
        if (d.options.some((o: ObjectValue) => o.key === args.position.locationId && o.visible === true)) { operation = 'choose_location'; responseKey = args.position.locationId; }
        else {
          const stamp = `${e.pagedDigest}:${e.page}`; if (visitedPages.has(stamp)) return waiting('native_location_page_cycle'); visitedPages.add(stamp);
          const visible = d.options.filter((o: ObjectValue) => o.visible === true && e.locationIds.includes(o.key)).map((o: ObjectValue) => e.locationIds.indexOf(o.key));
          if (!visible.length) return waiting('no_actual_visible_location_rows');
          const previous = e.locationIds.indexOf(args.position.locationId) < Math.min(...visible);
          operation = previous ? 'previous_page' : 'next_page'; responseKey = previous ? 'previousPage' : 'nextPage';
        }
      }
    }
    const row = responseKey === undefined ? undefined : d.options.find((o: ObjectValue) => o.key === responseKey && o.visible === true);
    if (responseKey && (!row || typeof row.text !== 'string')) return waiting('required_native_response_not_visible');
    const r = await invoke(operation, { expectedText: d.text, ...(row ? { responseKey: row.key, responseText: row.text } : {}) });
    if (!r) return waiting('native_question_changed_before_input');
    if (!r.entryAvailable) return waiting('native_constructor_target_unavailable');
  }
  return waiting('native_entry_readiness_timeout');
}

export async function buildingFollowup(args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  requireFact(object(args) && Object.keys(args).every(k => ['buildingGuid', 'blueprintId', 'position'].includes(k)) && guid(args.buildingGuid) && text(args.blueprintId), '复查需要持久建筑GUID、预期类型和原始位置。');
  const position = positionOf(args.position); io.needs(CONSTRUCTION_FOLLOWUP.requiredTools);
  const f = await frame(position.locationId, io), b = f.query.structures.find((b: ObjectValue) => b.buildingGuid === args.buildingGuid);
  requireFact(b && b.x === position.x && b.y === position.y && (b.type === args.blueprintId || b.upgradeName === args.blueprintId), '原建筑缺失、移动、替换或升级目标不符；没有提交建造或补偿动作。');
  const ready = b.type === args.blueprintId && b.constructionDays === 0 && b.upgradeDays === 0;
  io.observed('building_status_verified', { locationId: position.locationId, ...identity(b), ready, observationOnly: true, constructionCauseVerified: false });
  return ready ? 'completed' : 'waiting';
}
export async function buildingConstruct(args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  requireFact(object(args) && Object.keys(args).every(k => ['mode', 'builder', 'blueprintId', 'skinId', 'position', 'buildingGuid', 'maxGold', 'materialBudget', 'entry', 'entryPosition', 'maxEntrySteps', 'maxCatalogueSteps', 'maxPanSteps', 'closeAfter'].includes(k))
    && ['build', 'upgrade'].includes(args.mode) && ['Robin', 'Wizard'].includes(args.builder) && text(args.blueprintId) && skin(args.skinId)
    && (args.mode === 'upgrade' ? guid(args.buildingGuid) : args.buildingGuid === undefined) && int(args.maxGold, 0, 1000000000)
    && Array.isArray(args.materialBudget) && args.materialBudget.length <= 128, '建造需要实际建造者、明确图纸/皮肤、准确位置、升级GUID及金币/材料预算。');
  const position = positionOf(args.position), maxCatalogue = args.maxCatalogueSteps ?? 64, maxPan = args.maxPanSteps ?? 16, closeAfter = args.closeAfter ?? true;
  const entry = args.entry ?? 'current', entryPosition = args.entryPosition === undefined ? undefined : positionOf(args.entryPosition);
  requireFact(['current', 'counter'].includes(entry) && int(args.maxEntrySteps ?? 16, 1, 32) && (entry === 'counter' ? entryPosition : entryPosition === undefined), 'counter入口必须给实际当前位置的入口坐标；current不接受另一个入口。');
  requireFact(int(maxCatalogue, 0, 128) && int(maxPan, 0, 32) && typeof closeAfter === 'boolean', '目录/镜头操作上限和关闭选项无效。');
  const limits = new Map<string, number>();
  for (const r of args.materialBudget) {
    requireFact(object(r) && Object.keys(r).every(k => ['itemId', 'quality', 'maxCount'].includes(k)) && itemId(r.itemId) && int(r.quality, 0, 4) && int(r.maxCount, 1, 10000), '材料预算必须是准确ID/品质与有界份数。');
    const k = JSON.stringify([r.itemId, r.quality]); requireFact(!limits.has(k), '材料预算不可重复。'); limits.set(k, r.maxCount);
  }
  io.needs(CONSTRUCTION_WORKFLOW.requiredTools);
  if (entry === 'counter') io.needs(CONSTRUCTION_WORKFLOW.conditionalTools.counter);
  const resourceReady = () => { const s = io.port.current(); requireFact(s.timeOfDay < 2200 && s.player.health >= 20 && s.player.energy >= 30, '已到日终/资源收尾条件，未开始新的建造。'); };
  const read = () => frame(position.locationId, io, entryPosition);
  resourceReady(); let latest = await read();
  if (entry === 'counter') { const opened = await enterCatalogue(args, io, read, latest, entryPosition!); if (!opened) return 'waiting'; latest = opened; }
  let m = menu(latest);
  requireFact(m.builder === args.builder && !m.onFarm && m.action === 0 && m.targetLocationId === position.locationId && m.targetLocationKey === latest.query.target.locationKey,
    '先通过真实建造者交互打开对应原生木匠菜单；未创建菜单或采用不同放置模式。');
  const menuKey = m.menuKey, offerSet = JSON.stringify(m.offers), targetKey = latest.query.target.locationKey;
  const step = async (operation: string, extra: ObjectValue = {}): Promise<ObjectValue> => {
    const before = latest, old = menu(before);
    requireFact(old.menuKey === menuKey && old.builder === args.builder && before.query.target.locationKey === targetKey, '实际建造会话/地点改变，未点击。');
    requireFact((io.port.remainingActions?.() ?? 0) >= (['cancel', 'close'].includes(operation) ? 1 : 3), '保留原日提交和原生取消/关闭动作预算。');
    if (!['cancel', 'close'].includes(operation)) resourceReady();
    const outcome = await io.port.call('dsh_construction', { operation, locationId: position.locationId, revision: before.query.revision, menuKey,
      blueprintKey: old.selected.blueprintKey, planDigest: old.planDigest, structureDigest: before.query.structureDigest,
      inventoryDigest: before.query.state.inventoryDigest, expectedGold: before.query.state.money, ...extra });
    io.observed('construction_native_receipt', { operation, status: outcome.status, output: outcome.output, error: outcome.error });
    if (outcome.status === 'failed') throw new Error('原生建造预检拒绝，未自动重试。');
    if (outcome.status !== 'succeeded' || !object(outcome.output)) return io.uncertain('建造界面操作结果未知，可能有延迟回调；不重放。');
    const r = outcome.output;
    requireFact(r.nativeActionSubmitted !== false, '原生操作在输入前停止；没有提交本步，不自动重试。');
    try {
      requireFact(r.confirmedEffect === true && r.completedWorkflow === true && r.completionUncertain === false && r.nativeActionSubmitted === true && r.operation === operation
        && r.goldBefore === before.query.state.money && r.before?.revision === before.query.revision && object(r.after?.state), '原生建造单步没有完整确认。');
      latest = await read();
      requireFact(latest.query.target.locationKey === targetKey && latest.query.state.inventoryDigest === r.after.state.inventoryDigest
        && latest.query.state.money === r.goldAfter && latest.query.state.health === before.query.state.health && Math.abs(latest.query.state.energy - before.query.state.energy) <= 0.001
        && JSON.stringify(latest.query.structures) === JSON.stringify(r.after.structures), '新的独立背包/资源/建筑列表与原生建造收据不同。');
      verifyInventoryChanges(before.inventory, latest.inventory, r.inventoryChanges);
      if (operation !== 'commit') requireFact(inventoryDelta(before.inventory, latest.inventory).size === 0 && r.goldAfter === r.goldBefore
        && JSON.stringify(before.query.structures) === JSON.stringify(latest.query.structures), '非提交界面操作改变了物品、金币或建筑。');
      return r;
    } catch { return io.uncertain('建造操作已返回，但独立库存/金币/建筑没有完整匹配；不补偿或重放。'); }
  };
  const stopWithoutCommit = async (reason: string): Promise<'waiting'> => {
    if (closeAfter && latest.query.menu?.menuKey === menuKey) {
      if (latest.query.menu.onFarm) await step('cancel');
      if (latest.query.menu?.menuKey === menuKey && !latest.query.menu.onFarm) await step('close');
    }
    io.observed('construction_waiting', { reason, committed: false }); return 'waiting';
  };
  const wanted = m.offers.filter((o: ObjectValue) => o.id === args.blueprintId && o.skinId === args.skinId);
  requireFact(wanted.length === 1, '真实可用图纸中没有唯一的目标ID/皮肤；未按显示名猜或生成图纸。');
  let catalogueSteps = 0;
  while (m.selected.blueprintKey !== wanted[0].blueprintKey) {
    if (catalogueSteps++ >= maxCatalogue) return stopWithoutCommit('catalogue_step_cap');
    const n = m.offers.length, next = (wanted[0].index - m.selected.index + n) % n, previous = (m.selected.index - wanted[0].index + n) % n;
    await step(next <= previous ? 'next' : 'previous'); m = menu(latest);
    requireFact(JSON.stringify(m.offers) === offerSet, '原生图纸集合改变，未改用另一份报价。');
  }
  requireFact(m.selected.upgrade === (args.mode === 'upgrade') && int(m.selected.cost, 0, args.maxGold) && latest.query.state.money >= m.selected.cost
    && (args.mode === 'upgrade' || position.x + m.selected.width <= latest.query.target.width && position.y + m.selected.height <= latest.query.target.height), '图纸模式、实际费用、余额或新建占地越界。');
  const plan = m.selected, materials = m.materials, beforeStructures = latest.query.structures;
  for (const material of materials) {
    const rows = latest.inventory.slots.filter((s: ObjectValue) => s.item?.qualifiedItemId === material.itemId), qualities = new Map<number, number>();
    for (const r of rows) qualities.set(r.item.quality, (qualities.get(r.item.quality) ?? 0) + r.item.stack);
    requireFact([...qualities.values()].reduce((a, b) => a + b, 0) >= material.amount && [...qualities].every(([q, amount]) => (limits.get(JSON.stringify([material.itemId, q])) ?? 0) >= Math.min(amount, material.amount)),
      '材料不足，或逐品质预算不能覆盖原生按ID索引的最坏取料；未猜测槽位消耗顺序。');
  }
  if (args.mode === 'upgrade') {
    const b = beforeStructures.find((b: ObjectValue) => b.buildingGuid === args.buildingGuid);
    requireFact(b && b.type === plan.upgradeFrom && b.constructionDays === 0 && b.upgradeDays === 0 && position.x >= b.x && position.x < b.x + b.width
      && position.y >= b.y && position.y < b.y + b.height, '准确升级目标已变、仍在施工或位置不在其占地内。');
  }
  io.observed('construction_preflight', { mode: args.mode, builder: args.builder, blueprintId: args.blueprintId, skinId: args.skinId, position,
    buildingGuid: args.buildingGuid ?? null, actualCost: plan.cost, materialRequirements: materials, materialBudget: args.materialBudget, maxGold: args.maxGold });
  await step('enter_placement'); m = menu(latest);
  requireFact(m.onFarm === true && m.action === (args.mode === 'upgrade' ? 4 : 0) && m.selected.blueprintKey === plan.blueprintKey, '原生放置模式/图纸没有匹配。');
  let panSteps = 0; const blockedPan = new Set<string>();
  for (;;) {
    const request = constructionCameraRequest(latest.query, position, blockedPan); if (!request) break;
    if (panSteps++ >= maxPan) return stopWithoutCommit('camera_pan_cap');
    if (blockedPan.has(request.direction)) return stopWithoutCommit('native_camera_did_not_reach_clickable_tile');
    const r = await step('pan', request);
    if (r.panDelta?.x === 0 && r.panDelta?.y === 0) blockedPan.add(request.direction); else blockedPan.clear();
  }
  if ((io.port.remainingActions?.() ?? 0) < (closeAfter ? 13 : 3)) return stopWithoutCommit('reserve_commit_and_bounded_native_conclusion');
  const beforeCommit = latest;
  const receipt = await step('commit', { position, ...(args.mode === 'upgrade' ? { buildingGuid: args.buildingGuid } : {}), maxGold: args.maxGold, materialBudget: args.materialBudget });
  try {
    const b = receipt.result;
    requireFact(receipt.constructionStarted === true && object(b) && guid(b.buildingGuid) && latest.query.structures.some((row: ObjectValue) => JSON.stringify(row) === JSON.stringify(b))
      && receipt.goldBefore - receipt.goldAfter === plan.cost && plan.cost <= args.maxGold && typeof receipt.constructionReady === 'boolean', '未确认真实新增/升级建筑及准确扣款。');
    if (args.mode === 'build') requireFact(!beforeStructures.some((old: ObjectValue) => old.buildingGuid === b.buildingGuid) && latest.query.structures.length === beforeStructures.length + 1
      && b.type === args.blueprintId && b.skinId === beforeCommit.query.menu.previewSkinId && b.x === position.x && b.y === position.y, '新建筑GUID、类型/实际预览皮肤、位置或数量不符。');
    else requireFact(b.buildingGuid === args.buildingGuid && latest.query.structures.length === beforeStructures.length
      && (b.type === args.blueprintId && b.upgradeDays === 0 || b.type === plan.upgradeFrom && b.upgradeName === args.blueprintId && b.upgradeDays === Math.max(1, plan.days)), '准确建筑升级目标或原生计时不符。');
    requireFact(JSON.stringify(beforeStructures.filter((old: ObjectValue) => old.buildingGuid !== args.buildingGuid)) === JSON.stringify(latest.query.structures.filter((row: ObjectValue) => row.buildingGuid !== b.buildingGuid)), '其他建筑发生非预期变化。');
    const actual = [...inventoryDelta(beforeCommit.inventory, latest.inventory)].map(([k, delta]) => { const [itemId, quality] = JSON.parse(k); return { itemId, quality, amount: -delta }; });
    requireFact(actual.every(r => r.amount > 0 && r.amount <= (limits.get(JSON.stringify([r.itemId, r.quality])) ?? 0) && materials.some((m: ObjectValue) => m.itemId === r.itemId))
      && materials.every((m: ObjectValue) => actual.filter(r => r.itemId === m.itemId).reduce((n, r) => n + r.amount, 0) === m.amount), '完整独立库存的实际逐ID/品质扣料不符合原生材料/批准上限。');
    const ready = b.type === args.blueprintId && b.constructionDays === 0 && b.upgradeDays === 0;
    requireFact(ready === receipt.constructionReady, '原生施工开始与建成状态冲突。');
    io.observed('building_construction_verified', { mode: args.mode, builder: args.builder, locationId: position.locationId, blueprintId: args.blueprintId,
      ...identity(b), goldSpent: plan.cost, materialsConsumed: actual, ready, constructionCauseVerified: false });
    if (!closeAfter) return ready ? 'completed' : 'waiting';
    // The native success path returns to its builder and may show a normal
    // conclusion. Reuse the exact dialogue protocol; never select a question.
    for (let i = 0; i < 12; i++) {
      const d = await io.call('dsh_query_dialogue', {});
      if (d.open === false) return ready ? 'completed' : 'waiting';
      if (d.npcName !== args.builder || d.isQuestion !== false || !sha(d.revision) || typeof d.text !== 'string') return 'waiting';
      if (!d.ready) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
      requireFact((io.port.remainingActions?.() ?? 0) >= 1, '没有剩余原日动作关闭原生结语。');
      const before = latest;
      const r = await io.call('dsh_dialogue', { npcName: args.builder, revision: d.revision, expectedText: d.text, operation: d.revealed ? 'advance' : 'reveal' });
      latest = await read(); verifyInventoryChanges(before.inventory, latest.inventory, r.inventoryChanges);
      requireFact(inventoryDelta(before.inventory, latest.inventory).size === 0 && latest.query.state.money === before.query.state.money
        && JSON.stringify(latest.query.structures) === JSON.stringify(before.query.structures), '原生结语产生未批准物品、金币或建筑变化。');
    }
    return 'waiting';
  } catch { return io.uncertain('建造/升级已提交但完整后续收据未确认；可能已扣款/施工，不重建或补偿。'); }
}

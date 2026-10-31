import { constructionCameraRequest as cameraRequest } from './construction-camera.js';
import { object, positionOf, requireFact, samePosition, type ObjectValue, type WorkflowIO } from '../workflow-context.js';
import { inventoryDelta, verifyInventoryChanges } from './inventory-receipt.js';
import { constructionMenu, enterConstructionCatalogue, readConstructionFrame } from './construction.js';

const int = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && Number(v) >= lo && Number(v) <= hi;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const guid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v) && /[1-9a-f]/.test(v);
const position = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: {
  locationId: { type: 'string' }, x: { type: 'integer', minimum: 0, maximum: 10000 }, y: { type: 'integer', minimum: 0, maximum: 10000 },
} };
export const BUILDING_MOVE_WORKFLOW = {
  name: 'building_move', title: '正常拿起、放置准确建筑GUID并核对保留状态', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_construction', 'dsh_construction_move', 'stardew_query_inventory'],
  conditionalTools: { counter: ['dsh_construction_entry', 'stardew_navigate'] },
  parameters: { type: 'object', additionalProperties: false, required: ['builder', 'buildingGuid', 'origin', 'position', 'groundPolicy', 'onBlocked'], properties: {
    builder: { type: 'string', enum: ['Robin', 'Wizard'] }, buildingGuid: { type: 'string', format: 'uuid' }, origin: position, position,
    groundPolicy: { type: 'string', enum: ['preserve', 'native_clear'], description: 'preserve要求所有实际占地/附加格无对象和地形；native_clear明确允许原生在这些格删除对象/地形，逐格列收据。选择放回时同样应用于原位。' },
    onBlocked: { type: 'string', enum: ['hold', 'return_origin'], description: '拿起后取消无效。hold保留真实手持状态；return_origin明确授权已知阻挡/镜头上限后正常放回原格。未知结果仍不补偿。' },
    entry: { type: 'string', enum: ['current', 'counter'], default: 'current' }, entryPosition: position,
    maxEntrySteps: { type: 'integer', minimum: 1, maximum: 32, default: 16 },
    maxPanSteps: { type: 'integer', minimum: 0, maximum: 32, default: 16 }, maxReturnPanSteps: { type: 'integer', minimum: 0, maximum: 32, default: 16 },
    closeAfter: { type: 'boolean', default: true },
  } },
  scope: '同一已加载地点、准确持久GUID和原格、真实Robin/Wizard菜单/入口。正常move按钮、有限镜头、一次拿起/目标放置；完整列出的建筑/内部物品与住户字段、其他建筑、全背包/金币及实际占地地面变化核对。原生自行检查Farmhouse可达性和放置规则并更新出口。地面策略与阻挡处理必须显式选择。全部字段序列化、跨地图路线和跨进程pending恢复仍未完成。',
  postconditions: ['同一建筑GUID与实例到准确目标格且isMoving=false，真实菜单不再持有建筑；其他建筑及金币/完整背包不变',
    '实际保护摘要逐步不变；地面只能在批准的原生占地范围发生声明的删除，记录前后逐格状态',
    '已知拒绝与成功分开；批准放回仅正常原位放置一次，记为waiting而非目标搬移成功；结果未知不重放',
    '具体主人审核，无可复用搬移授权，F9/原日动作预算/日终限制保留；保护摘要只证明明确列出的观察字段'],
};

function groundFits(rows: ObjectValue[], policy: string): boolean {
  return policy === 'native_clear' || rows.every(c => c.objectKey === null && c.terrainKey === null);
}
function groundAllowed(before: ObjectValue[], after: ObjectValue[], clear: boolean): boolean {
  return before.length === after.length && before.every((b, i) => {
    const a = after[i]; if (!a || a.x !== b.x || a.y !== b.y) return false;
    const objectUnchanged = ['objectKey', 'objectType', 'itemId', 'stack', 'quality'].every(k => a[k] === b[k]);
    const objectRemoved = clear && ['objectKey', 'objectType', 'itemId', 'stack', 'quality'].every(k => a[k] === null);
    const terrainUnchanged = a.terrainKey === b.terrainKey && a.terrainType === b.terrainType;
    return (objectUnchanged || objectRemoved) && (terrainUnchanged || clear && a.terrainKey === null && a.terrainType === null);
  });
}

export async function buildingMove(args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  requireFact(object(args) && Object.keys(args).every(k => ['builder', 'buildingGuid', 'origin', 'position', 'groundPolicy', 'onBlocked', 'entry', 'entryPosition', 'maxEntrySteps', 'maxPanSteps', 'maxReturnPanSteps', 'closeAfter'].includes(k))
    && ['Robin', 'Wizard'].includes(args.builder) && guid(args.buildingGuid) && ['preserve', 'native_clear'].includes(args.groundPolicy)
    && ['hold', 'return_origin'].includes(args.onBlocked), '搬移必须明确真实建造者、建筑持久GUID、原格/目标格、地面处理与阻挡处理策略。');
  const origin = positionOf(args.origin), destination = positionOf(args.position), entry = args.entry ?? 'current';
  const entryPosition = args.entryPosition === undefined ? undefined : positionOf(args.entryPosition), maxPan = args.maxPanSteps ?? 16, maxReturn = args.maxReturnPanSteps ?? 16, closeAfter = args.closeAfter ?? true;
  requireFact(origin.locationId === destination.locationId && !samePosition(origin, destination) && ['current', 'counter'].includes(entry)
    && (entry === 'counter' ? entryPosition : entryPosition === undefined) && int(args.maxEntrySteps ?? 16, 1, 32)
    && int(maxPan, 0, 32) && int(maxReturn, 0, 32) && typeof closeAfter === 'boolean', '原位和目标必须在同一地点且不同；入口/镜头上限无效。');
  io.needs(BUILDING_MOVE_WORKFLOW.requiredTools); if (entry === 'counter') io.needs(BUILDING_MOVE_WORKFLOW.conditionalTools.counter);
  const resourceReady = () => { const s = io.port.current(); return s.timeOfDay < 2200 && s.player.health >= 20 && s.player.energy >= 30; };
  let activePosition = destination;
  const read = () => readConstructionFrame(destination.locationId, io, entryPosition, { buildingGuid: args.buildingGuid, position: activePosition });
  let latest = await read();
  const move = (): ObjectValue => {
    const q = latest.query.move;
    requireFact(object(q) && q.available === true && q.complete === true && sha(q.preservationDigest) && sha(q.groundDigest) && sha(q.exitDigest) && object(q.protection)
      && object(q.building) && q.building.buildingGuid === args.buildingGuid && samePosition(positionOf(q.position), activePosition)
      && Array.isArray(q.ground) && q.ground.length > 0 && q.ground.length <= 32768
      && q.ground.every((c: unknown) => object(c) && int(c.x, 0, latest.query.target.width - 1) && int(c.y, 0, latest.query.target.height - 1)
        && ['objectKey', 'objectType', 'itemId', 'terrainKey', 'terrainType'].every(k => c[k] === null || typeof c[k] === 'string')
        && (c.stack === null || int(c.stack, 1, 10000)) && (c.quality === null || int(c.quality, 0, 4)))
      && new Set(q.ground.map((c: ObjectValue) => `${c.x},${c.y}`)).size === q.ground.length && Array.isArray(q.exits) && q.exits.length <= 256
      && q.exits.every((e: unknown) => object(e) && typeof e.key === 'string' && /^[a-f0-9]{32}$/.test(e.key) && typeof e.targetName === 'string'
        && int(e.x, -10000, 10000) && int(e.y, -10000, 10000) && int(e.targetX, -10000, 10000) && int(e.targetY, -10000, 10000))
      && new Set(q.exits.map((e: ObjectValue) => e.key)).size === q.exits.length && object(q.door) && int(q.door.x, -128, 128) && int(q.door.y, -128, 128), '搬移保护/实际占地地面/内部出口快照不完整。');
    const b = latest.query.structures.find((b: ObjectValue) => b.buildingGuid === args.buildingGuid);
    requireFact(b && JSON.stringify(b) === JSON.stringify(q.building) && b.x === origin.x && b.y === origin.y && b.constructionDays === 0 && b.upgradeDays === 0,
      '搬移前原建筑身份/位置已变或仍在施工升级。'); return q;
  };
  const initialProtection = move().preservationDigest;
  if (entry === 'counter' && latest.query.menu?.onFarm !== true) {
    if (!resourceReady()) return 'waiting';
    const opened = await enterConstructionCatalogue(args, io, read, latest, entryPosition!); if (!opened) return 'waiting'; latest = opened;
  }
  const m = constructionMenu(latest), menuKey = m.menuKey, targetKey = latest.query.target.locationKey;
  requireFact(m.builder === args.builder && m.targetLocationId === destination.locationId && m.targetLocationKey === targetKey
    && (m.onFarm ? m.action === 2 && (m.movingBuildingGuid === null || m.movingBuildingGuid === args.buildingGuid) : m.action === 0 && m.movingBuildingGuid === null), '不是同一建造者/目标地点的目录或原生搬移模式。');
  requireFact(move().preservationDigest === initialProtection, '入口期间保护字段改变，未拿起建筑。');
  const step = async (operation: string, extra: ObjectValue = {}, recovery = false): Promise<ObjectValue> => {
    const before = latest, old = constructionMenu(before), capture = before.query.move;
    requireFact(old.menuKey === menuKey && old.builder === args.builder && before.query.target.locationKey === targetKey && capture?.preservationDigest === initialProtection,
      '实际搬移会话/保护状态改变，未点击。');
    requireFact((io.port.remainingActions?.() ?? 0) >= (recovery || ['cancel', 'close'].includes(operation) ? 1 : 3), '没有足够的原日剩余动作；不补发预算。');
    if (!recovery && !['cancel', 'close'].includes(operation)) requireFact(resourceReady(), '已到资源收尾条件，未提交新的搬移输入。');
    const outcome = await io.port.call('dsh_construction_move', { operation, locationId: destination.locationId, menuKey, revision: before.query.revision,
      buildingGuid: args.buildingGuid, origin, position: activePosition, structureDigest: before.query.structureDigest, inventoryDigest: before.query.state.inventoryDigest,
      expectedGold: before.query.state.money, preservationDigest: capture.preservationDigest, groundDigest: capture.groundDigest, exitDigest: capture.exitDigest, groundPolicy: args.groundPolicy,
      ...(recovery ? { returnToOrigin: true } : {}), ...extra });
    io.observed('building_move_native_receipt', { operation, status: outcome.status, output: outcome.output, error: outcome.error });
    if (outcome.status === 'failed') throw new Error('搬移接口拒绝，未自动重试或补偿；保留实际手持状态。');
    if (outcome.status !== 'succeeded' || !object(outcome.output)) return io.uncertain('搬移操作结果未知，可能已经拿起/放置；不重放或自动放回。');
    const r = outcome.output;
    requireFact(r.nativeActionSubmitted !== false, '搬移在输入前停止，没有提交本步。');
    try {
      requireFact(r.confirmedEffect === true && r.completedWorkflow === true && r.completionUncertain === false && r.nativeActionSubmitted === true && r.operation === operation
        && r.buildingGuid === args.buildingGuid && r.preservationVerified === true && r.before?.revision === before.query.revision
        && r.before?.move?.preservationDigest === initialProtection && r.before?.move?.groundDigest === capture.groundDigest && r.before?.move?.exitDigest === capture.exitDigest && r.exitsVerified === true
        && r.goldBefore === before.query.state.money && r.goldAfter === r.goldBefore && r.groundPolicy === args.groundPolicy && r.returnToOrigin === recovery,
      '缺少确切的原生搬移身份/资源/保护收据。');
      latest = await read(); const after = latest.query.move;
      requireFact(after?.available === true && after.complete === true && after.preservationDigest === initialProtection && latest.query.target.locationKey === targetKey
        && latest.query.state.inventoryDigest === r.after?.state?.inventoryDigest && latest.query.state.money === r.goldBefore && latest.query.state.health === before.query.state.health
        && Math.abs(latest.query.state.energy - before.query.state.energy) <= 0.001 && JSON.stringify(latest.query.structures) === JSON.stringify(r.after.structures)
        && JSON.stringify(after.ground) === JSON.stringify(r.groundAfter) && JSON.stringify(capture.ground) === JSON.stringify(r.groundBefore)
        && JSON.stringify(after.exits) === JSON.stringify(r.exitsAfter) && JSON.stringify(capture.exits) === JSON.stringify(r.exitsBefore), '独立背包/资源/建筑/保护/地面或出口与原生收据不同。');
      verifyInventoryChanges(before.inventory, latest.inventory, r.inventoryChanges);
      requireFact(inventoryDelta(before.inventory, latest.inventory).size === 0 && groundAllowed(capture.ground, after.ground, operation === 'place' && args.groundPolicy === 'native_clear'), '搬移发生未批准的物品或地面变化。');
      const oldBuilding = before.query.structures.find((b: ObjectValue) => b.buildingGuid === args.buildingGuid);
      const expected = { ...oldBuilding, ...(operation === 'pick' && r.pickAccepted === true ? { isMoving: true }
        : operation === 'place' && r.placementAccepted === true ? { x: activePosition.x, y: activePosition.y, isMoving: false } : {}) };
      const actual = latest.query.structures.find((b: ObjectValue) => b.buildingGuid === args.buildingGuid);
      const expectedExits = capture.exits.map((e: ObjectValue) => operation === 'place' && r.placementAccepted === true && e.targetName === destination.locationId
        ? { ...e, targetX: activePosition.x + capture.door.x, targetY: activePosition.y + capture.door.y + 1 } : e);
      requireFact(JSON.stringify(after.exits) === JSON.stringify(expectedExits), '内部出口未按原生门偏移更新，或其他出口发生变化；未声称出口可通行。');
      requireFact(JSON.stringify(actual) === JSON.stringify(expected) && JSON.stringify(actual) === JSON.stringify(r.result)
        && latest.query.structures.length === before.query.structures.length
        && JSON.stringify(latest.query.structures.filter((b: ObjectValue) => b.buildingGuid !== args.buildingGuid)) === JSON.stringify(before.query.structures.filter((b: ObjectValue) => b.buildingGuid !== args.buildingGuid)), '同一建筑实际位置/手持状态或其他建筑不符合本步。');
      if (operation === 'pick') requireFact(typeof r.pickAccepted === 'boolean' && (r.pickAccepted ? latest.query.menu?.movingBuildingGuid === args.buildingGuid : latest.query.menu?.movingBuildingGuid === null), '原生拿起/拒绝状态不符。');
      if (operation === 'place') requireFact(typeof r.placementAccepted === 'boolean' && (r.placementAccepted ? latest.query.menu?.movingBuildingGuid === null : latest.query.menu?.movingBuildingGuid === args.buildingGuid), '原生放置/拒绝状态不符。');
      return r;
    } catch { return io.uncertain('已提交搬移，但完整独立收据没有确认；不修改建筑或自动放回。'); }
  };
  let panSteps = 0, returnPans = 0;
  const panTo = async (p: ReturnType<typeof positionOf>, recovery = false): Promise<boolean> => {
    const blocked = new Set<string>();
    for (;;) {
      const request = cameraRequest(latest.query, p, blocked); if (!request) return true;
      if (blocked.has(request.direction) || (recovery ? returnPans >= maxReturn : panSteps >= maxPan || !resourceReady()) || (io.port.remainingActions?.() ?? 0) < 3) return false;
      if (recovery) returnPans++; else panSteps++;
      const r = await step('pan', request, recovery);
      if (r.panDelta?.x === 0 && r.panDelta?.y === 0) blocked.add(request.direction); else blocked.clear();
    }
  };
  const close = async () => {
    if (!closeAfter) return;
    if (latest.query.menu?.menuKey === menuKey && latest.query.menu.onFarm && latest.query.menu.movingBuildingGuid === null) await step('cancel');
    if (latest.query.menu?.menuKey === menuKey && !latest.query.menu.onFarm) await step('close');
  };
  const stop = async (reason: string): Promise<'waiting'> => {
    let returned = false;
    if (latest.query.menu?.movingBuildingGuid === args.buildingGuid && args.onBlocked === 'return_origin') {
      activePosition = origin; latest = await read(); const q = move();
      if (q.preservationDigest === initialProtection && groundFits(q.ground, args.groundPolicy) && await panTo(origin, true)) {
        const receipt = await step('place', {}, true); returned = receipt.placementAccepted === true;
        if (returned) io.observed('building_returned_to_origin_verified', { buildingGuid: args.buildingGuid, locationId: origin.locationId, origin, reason,
          builder: args.builder, type: receipt.result.type, skinId: receipt.result.skinId, groundPolicy: args.groundPolicy,
          groundBefore: receipt.groundBefore, groundAfter: receipt.groundAfter, preservationVerified: true, exitUpdatesVerified: true,
          trackedExitCount: receipt.exitsAfter.length, targetMoveCompleted: false });
      }
    }
    if (latest.query.menu?.movingBuildingGuid === null) await close();
    io.observed('building_move_waiting', { buildingGuid: args.buildingGuid, reason, returnedToOrigin: returned,
      heldBuildingGuid: latest.query.menu?.movingBuildingGuid ?? null, targetMoveCompleted: false }); return 'waiting';
  };
  if (!groundFits(move().ground, args.groundPolicy)) return stop('approved_ground_policy_blocks_destination');
  if (!resourceReady()) return stop('day_or_resource_limit');
  if (!m.onFarm) { if (!m.moveVisible) return stop('native_move_control_unavailable'); await step('enter'); }
  if (latest.query.menu?.movingBuildingGuid === null) {
    // Reserve the declared remaining camera cap plus one place/cancel/close and
    // optional return attempt. Every actual step still spends the same budget.
    if ((io.port.remainingActions?.() ?? 0) < Math.max(0, maxPan - panSteps) + (args.onBlocked === 'return_origin' ? maxReturn + 1 : 0) + 4) return stop('reserve_pick_place_and_declared_recovery_budget');
    if (move().canMove !== true || !await panTo(origin)) return stop('source_permission_or_camera_unavailable');
    const picked = await step('pick'); if (!picked.pickAccepted) return stop('native_pick_rejected');
  }
  if (!resourceReady() || !await panTo(destination)) return stop('destination_camera_or_resource_limit');
  if ((io.port.remainingActions?.() ?? 0) < (closeAfter ? 3 : 1)) return stop('reserve_place_and_close_budget');
  const receipt = await step('place'); if (!receipt.placementAccepted) return stop('native_placement_rejected');
  io.observed('building_move_verified', { buildingGuid: args.buildingGuid, builder: args.builder, locationId: origin.locationId, origin, position: destination,
    type: receipt.result.type, skinId: receipt.result.skinId, groundPolicy: args.groundPolicy, groundBefore: receipt.groundBefore, groundAfter: receipt.groundAfter,
    preservationVerified: true, exitUpdatesVerified: true, trackedExitCount: receipt.exitsAfter.length, goldSpent: 0, targetMoveCompleted: true });
  await close(); return 'completed';
}

import { object, requireFact, type ObjectValue, type WorkflowIO } from '../workflow-context.js';
import { readConstructionFrame } from './construction.js';
import { inventoryDelta } from './inventory-receipt.js';

const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const guid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v) && /[1-9a-f]/.test(v);
export const BUILDING_DEMOLITION_PREFLIGHT = {
  name: 'building_demolition_preflight', title: '只读拆除前的建筑/小屋帮手/地下室与原生锁状态', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_construction', 'stardew_query_inventory'],
  parameters: { type: 'object', additionalProperties: false, required: ['locationId', 'buildingGuid'], properties: {
    locationId: { type: 'string', minLength: 1, maxLength: 160 }, buildingGuid: { type: 'string', format: 'uuid' },
  } },
  scope: '只读已加载地点的准确GUID。查询列出的内部/箱/持有产物/任务物品标记、帮手背包/装备、已加载地下室、失物招领基线与原生待执行锁/确认来源。声明的集合有界，卸载地下室与未解析帮手不当空。不是全角色备份、完整损失预测、可拆资格结论或拆除操作；executionReady/lossModelComplete保持false。',
  postconditions: ['两轮原生版本与独立MCP完整背包/资源一致，准确建筑存在或明确缺失；没有提交任何写操作',
    '房屋/数量/施工规则仅列观察，原生资格未执行；任务物品复制、最低级工具移除、帮手删除/地下室重排和子类钩子仍待执行模型与收据',
    '已排队原生锁回调可在控制器停止后继续执行；本查询不取消回调或回答确认，不写已拆除经历'],
};
export async function buildingDemolitionPreflight(args: unknown, io: WorkflowIO): Promise<'completed'> {
  requireFact(object(args) && Object.keys(args).every(k => ['locationId', 'buildingGuid'].includes(k)) && typeof args.locationId === 'string' && args.locationId.length > 0 && args.locationId.length <= 160 && guid(args.buildingGuid), '拆除检查需要实际加载地点和准确持久建筑GUID。');
  io.needs(BUILDING_DEMOLITION_PREFLIGHT.requiredTools);
  const read = () => readConstructionFrame(args.locationId, io, undefined, undefined, undefined, undefined, args.buildingGuid);
  const first = await read(), second = await read(), q = second.query.demolition;
  requireFact(object(q) && q.available === true && q.observedCollectionsComplete === true && sha(q.revision) && first.query.demolition?.revision === q.revision && object(q.state), '拆除前状态缺失、不完整或在独立读取期间变化。');
  const s = q.state, b = second.query.structures.find((b: ObjectValue) => b.buildingGuid === args.buildingGuid);
  requireFact(s.buildingGuid === args.buildingGuid && typeof s.exists === 'boolean' && s.exists === Boolean(b) && (b ? JSON.stringify(s.building) === JSON.stringify(b) : s.building === undefined)
    && s.executionReady === false && s.lossModelComplete === false && object(s.nativeLock) && typeof s.nativeLock.requested === 'boolean' && typeof s.nativeLock.callbackPending === 'boolean'
    && typeof s.nativeLock.nativeCallback === 'boolean' && (s.nativeLock.buildingGuid === null || guid(s.nativeLock.buildingGuid))
    && Array.isArray(s.farmhandRoster) && s.farmhandRoster.length <= 256 && s.farmhandRoster.every((f: unknown) => object(f) && typeof f.farmerId === 'string' && /^-?\d+$/.test(f.farmerId) && key(f.key))
    && new Set(s.farmhandRoster.map((f: ObjectValue) => f.farmerId)).size === s.farmhandRoster.length
    && Array.isArray(s.returnedDonationsBefore) && s.returnedDonationsBefore.length <= 512, '建筑存在性、原生锁、帮手名册或失物招领集合不完整；不能据此启用拆除。');
  if (b) {
    requireFact(object(s.buildingContents) && Array.isArray(s.exits) && s.exits.length <= 256 && object(s.observedRules) && s.observedRules.nativeEligibilityEvaluated === false
      && (s.interior === null || object(s.interior)) && (s.cabin === null || object(s.cabin) && typeof s.cabin.ownerDefined === 'boolean' && typeof s.cabin.ownerResolved === 'boolean'
        && s.cabin.recoveryPredictionComplete === false && object(s.cabin.cellar) && typeof s.cabin.cellar.complete === 'boolean' && typeof s.cabin.cellar.loaded === 'boolean'), '室内/小屋/地下室观察缺失，未把未知状态当作空。');
    requireFact(object(s.effectDispatch) && Array.isArray(s.effectDispatch.building) && (s.effectDispatch.interior === null || Array.isArray(s.effectDispatch.interior))
      && [...s.effectDispatch.building, ...(s.effectDispatch.interior ?? [])].every((r: unknown) => object(r) && typeof r.method === 'string' && typeof r.declaringType === 'string'
        && /^0x[0-9a-f]{8}$/.test(r.token) && /^0x[0-9a-f]{8}$/.test(r.baseToken) && typeof r.native === 'boolean' && r.modeled === false), '实际拆除派发方法未完整列出，不能默认所有建筑都只有基类效果。');
    requireFact(object(s.questItems) && Array.isArray(s.questItems.candidates) && s.questItems.nativeTraversalComplete === false && s.questItems.recoveryPredictionComplete === false
      && s.questItems.returnedDonationsReceiptVerified === false && s.questItems.candidates.every((r: unknown) => object(r) && key(r.key) && typeof r.itemId === 'string'
        && Number.isSafeInteger(r.stack) && r.stack > 0 && Number.isSafeInteger(r.quality) && Array.isArray(r.paths) && r.paths.every((p: unknown) => typeof p === 'string')), '任务物品观察不能冒充原生完整遍历或已进入失物招领。');
    if (s.cabin?.owner) {
      const owner = s.cabin.owner, r = owner.bagRecovery;
      requireFact(Array.isArray(owner.slots) && object(r) && r.filterModelComplete === true && r.filterModelVerifiedInGame === false && r.recoveredChestVerified === false
        && r.fullDemolitionRecoveryModelComplete === false && Array.isArray(r.retainedBagRoots) && Array.isArray(r.removedFromRecoveryChest), '缺少小屋背包原生过滤投影，未宣称已回收。');
      const rows = [...r.retainedBagRoots, ...r.removedFromRecoveryChest], occupied = owner.slots.filter((v: unknown) => v !== null);
      requireFact(r.observedNonNullRootCount === occupied.length && rows.length === occupied.length && new Set(rows.map(row => row.sourceSlot)).size === rows.length
        && rows.every(row => object(row) && Number.isSafeInteger(row.sourceSlot) && row.sourceSlot >= 0 && row.sourceSlot < owner.slots.length
          && owner.slots[row.sourceSlot]?.key === row.key && owner.slots[row.sourceSlot]?.id === row.itemId && owner.slots[row.sourceSlot]?.stack === row.stack
          && owner.slots[row.sourceSlot]?.quality === row.quality && owner.slots[row.sourceSlot]?.type === row.type), '过滤投影没有逐件覆盖原背包，不能据此授权损失或回收。');
    }
    if (s.stableHorse !== null) requireFact(object(s.stableHorse) && s.stableHorse.horseId === b.buildingGuid && s.stableHorse.loadedScopeComplete === true
      && s.stableHorse.nativeFindHorseParityVerified === false && s.stableHorse.removalReceiptVerified === false && Array.isArray(s.stableHorse.matches)
      && s.stableHorse.matches.length <= 16 && s.stableHorse.matches.every((h: unknown) => object(h) && key(h.key) && h.horseId === b.buildingGuid && typeof h.locationId === 'string'
        && typeof h.ownerId === 'string' && typeof h.riderDefined === 'boolean'), '马厩删除马匹的副作用未列出，未把未找到当作不存在。');
  }
  requireFact(first.query.state.inventoryDigest === second.query.state.inventoryDigest && first.query.state.money === second.query.state.money
    && first.query.state.health === second.query.state.health && Math.abs(first.query.state.energy - second.query.state.energy) <= 0.001
    && JSON.stringify(first.query.structures) === JSON.stringify(second.query.structures) && inventoryDelta(first.inventory, second.inventory).size === 0, '只读检查期间库存/金币/资源或建筑发生变化；没有提交拆除。');
  io.observed('building_demolition_preflight_observed', { buildingGuid: args.buildingGuid, locationId: args.locationId, revision: q.revision,
    observationOnly: true, demolitionSubmitted: false, executionReady: false, lossModelComplete: false, snapshot: s });
  return 'completed'; // Inspection completed; no demolition outcome is claimed.
}

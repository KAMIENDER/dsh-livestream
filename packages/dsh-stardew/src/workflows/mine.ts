import { object, positionOf, requireFact, type ObjectValue, type WorkflowIO } from '../workflow-context.js';
import { inventoryDelta, verifyNativeInventory, verifyInventoryChanges } from './inventory-receipt.js';

const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
export const MINE_WORKFLOW = {
  name: 'mine_route', title: '已有矿梯、电梯、竖井与返地面', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_mine', 'dsh_mine_travel', 'stardew_navigate', 'stardew_query_inventory'],
  parameters: { type: 'object', additionalProperties: false, required: ['mode', 'fromLevel', 'maxLevel', 'healthFloor', 'maxHealthLoss'], properties: {
    mode: { type: 'string', enum: ['descend', 'leave', 'elevator'] }, fromLevel: { type: 'integer', minimum: 1, maximum: 1000000 },
    transitions: { type: 'integer', minimum: 1, maximum: 8, default: 1, description: '仅descend；逐次新读生成的实际楼层，优先普通矿梯' },
    maxLevel: { type: 'integer', minimum: 1, maximum: 1000000 }, destinationLevel: { type: 'integer', minimum: 0, maximum: 120, description: '仅elevator；实际按钮必须存在，0返回普通矿山入口' },
    allowShaft: { type: 'boolean', default: false, description: '仅descend。每次允许最多15层随机下落并须预留45点原生掉血；不预测RNG或补血' },
    healthFloor: { type: 'integer', minimum: 20, maximum: 1000 }, maxHealthLoss: { type: 'integer', minimum: 0, maximum: 1000, description: '本流程观察到的生命下降累计上限；恢复不返还额度，不声称量得未观察帧的总受伤' },
  } },
  scope: '已在真实原生MineShaft内，完整扫描最多256×256地图/256个已存在出口。每跳正常导航、一次操作键及原生明确问题/按钮，核对实际新楼层、金币、完整背包和生命。没有造梯、直接传送、开采、杀怪或入口大厅/火山适配；无梯时waiting，不冒充完成探索。',
  postconditions: ['真实存活地点实例、矿层与完整出口扫描，候选不是旧层坐标或文字Action猜测', '普通矿梯恰好+1层，电梯准确实际按钮楼层，返地面核对Mine/SkullCave，竖井核对原生实际下落层数及落地提示关闭', '新MCP全背包与原生变化一致，金币不变、无物品减少、独立生命/资源核对，8帧原生稳定后再接受', '原日预算/pending与明确主人审核不变；未知、资源超限或失配不重做，部分跳数单列'],
};

interface Frame { query: ObjectValue; state: ObjectValue; exits: ObjectValue[]; inventory: ObjectValue }
async function frame(io: WorkflowIO, mineRequired = true, account = () => {}): Promise<Frame> {
  const first = (await io.call('dsh_query_mine', {})).travel;
  account();
  const inventory = await io.inventory();
  account();
  const last = (await io.call('dsh_query_mine', {})).travel;
  account();
  requireFact(object(first) && object(last) && object(first.state) && object(last.state) && first.state.locationKey === last.state.locationKey
    && first.state.level === last.state.level && first.state.inventoryDigest === last.state.inventoryDigest && first.state.money === last.state.money, '矿层/背包/金币在独立读取期间变化；未沿用旧出口。');
  const s = last.state, current = io.port.current();
  requireFact(key(s.locationKey) && sha(s.inventoryDigest) && s.canMove === true && s.menuType === null && s.eventUp === false && s.fading === false
    && int(s.health, 1, 1000) && Number.isFinite(s.energy) && int(s.money, 0, 2147483647)
    && current.player.health === s.health && current.player.energy === s.energy && current.player.money === String(s.money)
    && current.player.position.locationId === s.locationId, '独立主角资源、菜单或位置与矿层读取不一致。');
  verifyNativeInventory(inventory, s.inventoryCounts);
  if (mineRequired) requireFact(last.available === true && last.complete === true && int(s.level, 1, 1000000)
    && int(last.width, 1, 256) && int(last.height, 1, 256) && Array.isArray(last.exits) && last.exits.length <= 256, '当前不是已适配的完整原生矿层，或地图/出口超限。');
  const exits = mineRequired ? last.exits.map((e: unknown) => {
    requireFact(object(e) && sha(e.targetKey) && sha(e.digest) && typeof e.blocked === 'boolean' && ['descend', 'leave', 'shaft', 'elevator'].includes(e.kind)
      && e.locationId === s.locationId && int(e.x, 0, last.width - 1) && int(e.y, 0, last.height - 1)
      && e.tileIndex === ({ descend: 173, leave: 115, shaft: 174, elevator: 112 } as Record<string, number>)[e.kind], '矿层出口事实无效。');
    return e;
  }) : [];
  requireFact(new Set(exits.map((e: ObjectValue) => e.targetKey)).size === exits.length, '矿层出现重复出口引用。');
  return { query: last, state: s, exits, inventory };
}

export async function mineRoute(args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  requireFact(object(args) && Object.keys(args).every(k => ['mode', 'fromLevel', 'transitions', 'maxLevel', 'destinationLevel', 'allowShaft', 'healthFloor', 'maxHealthLoss'].includes(k))
    && ['descend', 'leave', 'elevator'].includes(args.mode) && int(args.fromLevel, 1, 1000000) && int(args.maxLevel, 1, 1000000)
    && int(args.healthFloor, 20, 1000) && int(args.maxHealthLoss, 0, 1000) && (args.allowShaft === undefined || typeof args.allowShaft === 'boolean'), 'mine_route需要明确模式、起始楼层、最大楼层、生命下限和观察损失预算。');
  const count = args.mode === 'descend' ? args.transitions ?? 1 : 1;
  requireFact(int(count, 1, 8) && (args.mode === 'descend' || args.transitions === undefined && args.allowShaft === undefined)
    && (args.mode === 'elevator' ? int(args.destinationLevel, 0, 120) && args.destinationLevel % 5 === 0 && args.destinationLevel !== args.fromLevel : args.destinationLevel === undefined), '跳数/竖井只能用于descend；电梯需要明确且不同的5层倍数目标。');
  io.needs(MINE_WORKFLOW.requiredTools); io.ready();
  let usedLoss = 0, lastHealth = io.port.current().player.health;
  const account = () => {
    const health = io.port.current().player.health;
    usedLoss += Math.max(0, lastHealth - health); lastHealth = health;
    requireFact(health >= args.healthFloor && usedLoss <= args.maxHealthLoss, '观察生命损失或生命下限已触及；停止后续转层，恢复不返还损失预算。');
  };
  account();
  let latest = await frame(io, true, account);
  requireFact(latest.state.level === args.fromLevel && (args.mode !== 'descend' || args.fromLevel !== 77377), '实际起始楼层变化或采石场不是普通下行路线。');
  requireFact(args.mode !== 'elevator' || args.fromLevel <= 120 && int(latest.query.lowestLevelReached, 0, 1000000)
    && args.destinationLevel <= Math.floor(Math.min(120, latest.query.lowestLevelReached) / 5) * 5, '电梯目标未在真实进度中解锁，未尝试打开或解锁它。');
  io.observed('mine_route_preflight', { fromLevel: args.fromLevel, mode: args.mode, transitions: count, maxLevel: args.maxLevel, healthFloor: args.healthFloor, maxHealthLoss: args.maxHealthLoss, allowShaft: args.allowShaft === true });
  for (let hop = 0; hop < count; hop++) {
    io.ready(latest.state.locationId); account();
    const exitReserve = args.mode === 'leave' || args.mode === 'elevator' && args.destinationLevel === 0 ? 0 : 2;
    requireFact((io.port.remainingActions?.() ?? 0) >= 2 * (count - hop) + exitReserve, '原日剩余动作不足以完成导航/转层并预留2次退出动作，没有重领额度；预留不保证已找到可达出口。');
    const candidates = latest.exits.filter(e => !e.blocked && (args.mode === 'descend' ? e.kind === 'descend' || args.allowShaft === true && e.kind === 'shaft' : e.kind === args.mode))
      .sort((a, b) => (a.kind === 'shaft' ? 1 : 0) - (b.kind === 'shaft' ? 1 : 0)
        || Math.abs(a.x - io.port.current().player.position.x) + Math.abs(a.y - io.port.current().player.position.y) - Math.abs(b.x - io.port.current().player.position.x) - Math.abs(b.y - io.port.current().player.position.y)
        || a.y - b.y || a.x - b.x);
    if (!candidates.length) { io.observed('mine_route_waiting', { completedTransitions: hop, level: latest.state.level, reason: 'no_matching_existing_exit', explorationCompleted: false }); return 'waiting'; }
    const chosen = candidates[0], from = latest.state.level;
    const projected = chosen.kind === 'shaft' ? from + 15 : chosen.kind === 'descend' ? from + 1 : chosen.kind === 'leave' ? 0 : args.destinationLevel;
    requireFact(projected <= args.maxLevel && (chosen.kind !== 'shaft' || args.maxHealthLoss - usedLoss >= 45 && lastHealth >= args.healthFloor + 45), '下一跳/竖井最坏15层或45点掉血超出明确预算。');
    const target = positionOf(chosen);
    await io.call('stardew_navigate', { position: target, arrival: 'adjacent' }); account(); io.ready(target.locationId);
    const ready = await frame(io, true, account);
    requireFact(ready.state.level === from && ready.state.locationKey === latest.state.locationKey
      && ready.exits.some(e => e.targetKey === chosen.targetKey && e.digest === chosen.digest && e.kind === chosen.kind)
      && Math.abs(io.port.current().player.position.x - target.x) + Math.abs(io.port.current().player.position.y - target.y) === 1, '导航后的实际矿层实例、出口或相邻站位改变，未操作另一出口。');
    const budget = args.maxHealthLoss - usedLoss;
    requireFact(chosen.kind !== 'shaft' || budget >= 45 && lastHealth >= args.healthFloor + 45, '导航后不再具备竖井预算，未确认跳井。');
    const result = await io.call('dsh_mine_travel', { operation: chosen.kind, position: target, locationKey: ready.state.locationKey,
      targetKey: chosen.targetKey, targetDigest: chosen.digest, expectedFromLevel: from, maxLevelAfter: args.maxLevel,
      expectedHealth: ready.state.health, expectedMoney: ready.state.money, inventoryDigest: ready.state.inventoryDigest,
      healthFloor: args.healthFloor, maxHealthLoss: budget, ...(args.mode === 'elevator' ? { destinationLevel: args.destinationLevel } : {}) });
    io.observed('mine_native_transition', result);
    try {
      requireFact(result.completedWorkflow === true && result.operation === chosen.kind && result.nativeActionSubmitted === true
        && object(result.before) && object(result.after) && result.before.level === from && result.before.locationKey === ready.state.locationKey
        && result.before.health === lastHealth && int(result.observedHealthLoss, 0, budget) && int(result.after.health, 1, 1000)
        && result.observedHealthLoss >= Math.max(0, result.before.health - result.after.health), '没有完整原生转层与逐帧观察生命收据。');
      usedLoss += result.observedHealthLoss; lastHealth = result.after.health; account();
      const exiting = chosen.kind === 'leave' || chosen.kind === 'elevator' && args.destinationLevel === 0;
      const after = await frame(io, !exiting, account);
      requireFact(result.after.locationKey === after.state.locationKey && after.state.locationKey !== ready.state.locationKey && result.after.level === after.state.level
        && result.beforeGold === ready.state.money && result.afterGold === after.state.money && result.afterGold === result.beforeGold
        && result.after.health === after.state.health && result.after.energy === after.state.energy
        && Array.isArray(result.inventoryChanges) && result.inventoryChanges.every((c: ObjectValue) => int(c.amount, 1, 1000000000)), '独立目的地、资源或原生物品收据不一致。');
      verifyInventoryChanges(ready.inventory, after.inventory, result.inventoryChanges);
      const delta = [...inventoryDelta(ready.inventory, after.inventory)].map(([idQuality, amount]) => {
        const [itemId, quality] = JSON.parse(idQuality); return { itemId, quality, amount };
      });
      requireFact(delta.every(c => c.amount >= 0), '转层出现未批准物品减少。');
      requireFact(exiting ? after.state.level === null && after.state.locationId === (from > 120 && from !== 77377 ? 'SkullCave' : 'Mine')
        : after.state.level <= args.maxLevel && (chosen.kind === 'descend' ? after.state.level === from + 1 : chosen.kind === 'elevator' ? after.state.level === args.destinationLevel
          : int(result.nativeFallLevels, 1, 15) && after.state.level === from + result.nativeFallLevels), '实际目的楼层/入口不符合批准路线。');
      io.observed('mine_transition_verified', { operation: chosen.kind, fromLevel: from, toLevel: after.state.level, destination: after.state.locationId,
        healthBefore: result.before.health, healthAfter: after.state.health, observedHealthLossUsed: usedLoss, fallLevels: result.nativeFallLevels ?? null,
        incidentalPickups: delta, moneyUnchanged: true, explorationCompleted: false });
      latest = after;
    } catch { return io.uncertain('原生转层后的独立楼层/资源/背包未完整确认；可能已经进入新层，不重走或重选。'); }
  }
  io.observed('mine_route_completed', { transitions: count, level: latest.state.level, locationId: latest.state.locationId, observedHealthLossUsed: usedLoss, explorationCompleted: false });
  return 'completed';
}

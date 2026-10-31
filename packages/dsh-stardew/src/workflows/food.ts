import { object, requireFact, WorkflowIO, type ObjectValue } from '../workflow-context.js';
import { verifyInventoryChanges } from './inventory-receipt.js';

export const FOOD_WORKFLOW = {
  name: 'consume_food', title: '原生食用一份明确背包食物并核对结束状态', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_food', 'dsh_consume', 'stardew_query_inventory'],
  parameters: { type: 'object', additionalProperties: false, required: ['itemId', 'quality'], properties: {
    itemId: { type: 'string', description: '当前背包可食物的完整(O)…ID；不是显示名' }, quality: { type: 'integer', minimum: 0, maximum: 4 },
    allowNegativeEdibility: { type: 'boolean', default: false }, maxHealthLoss: { type: 'integer', minimum: 0, maximum: 1000, default: 0 },
    maxEnergyLoss: { type: 'integer', minimum: 0, maximum: 5000, default: 0 }, durationMs: { type: 'integer', minimum: 1000, maximum: 20000, default: 15000 },
  } },
  scope: '当前背包已有的一份明确ID/品质普通Object食物或饮料；原生禁食挑战/姿态/恶心/饱食/饮水限制生效，不强制恢复。可在低资源或晚间补给，但不重领日动作。负食用值须明确允许并预留可能基础损失；增益按游戏原生替换，未知自定义Object另需适配。',
  postconditions: ['指定物品恰好减少1份，全背包增减与新MCP背包一致', '实际生命/体力/上限和金币独立核对，不把基础恢复量当作最终增量', '普通动画结束且原生可操作才completed；星之果实专用提示waiting，已消耗不再吃一份'],
};
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const close = (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= .001;

export async function consumeFood(args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  requireFact(object(args) && Object.keys(args).every(k => ['itemId', 'quality', 'allowNegativeEdibility', 'maxHealthLoss', 'maxEnergyLoss', 'durationMs'].includes(k))
    && typeof args.itemId === 'string' && /^\(O\)[^\s\x00-\x1f]{1,128}$/.test(args.itemId) && whole(args.quality, 0, 4), 'consume_food需要真实完整物品ID和品质。');
  const allowNegativeEdibility = args.allowNegativeEdibility ?? false, maxHealthLoss = args.maxHealthLoss ?? 0, maxEnergyLoss = args.maxEnergyLoss ?? 0, durationMs = args.durationMs ?? 15000;
  requireFact(typeof allowNegativeEdibility === 'boolean' && whole(maxHealthLoss, 0, 1000) && whole(maxEnergyLoss, 0, 5000) && whole(durationMs, 1000, 20000), '负食用值、损失核对上限或等待期限不符合workflows声明。');
  io.needs(FOOD_WORKFLOW.requiredTools);
  const before = await io.inventory(), current = io.port.current();
  requireFact(current.player.canMove && !current.ui.menuOpen && current.player.health > 0 && current.timeOfDay < 2600, '当前不是可食用的空闲世界；不强关菜单、解除姿态或跳过死亡。');
  const source = before.slots.find((s: ObjectValue) => s.item?.qualifiedItemId === args.itemId && s.item.quality === args.quality && s.item.stack > 0);
  requireFact(source && whole(source.index, 0, 255), '指定品质食物不在当前实际背包中。');
  const query = await io.call('dsh_query_food', { inventorySlot: source.index, offset: 0, limit: 1 });
  requireFact(object(query.player) && /^[a-f0-9]{64}$/.test(query.inventoryDigest) && Array.isArray(query.items) && query.items.length === 1 && query.nextOffset === null, '缺少唯一真实背包食物及状态。');
  const food = query.items[0];
  requireFact(object(food) && food.inventorySlot === source.index && food.itemId === args.itemId && food.quality === args.quality && food.eligible === true && /^[a-f0-9]{64}$/.test(food.digest), '食物/品质/槽位已变，或原生挑战/姿态/状态不允许；未食用。');
  requireFact(typeof food.edibility === 'number' && Number.isInteger(food.edibility) && (food.edibility >= 0 || allowNegativeEdibility), '食用值缺失或负食用值未明确允许，不能当作普通恢复补给。');
  requireFact(typeof food.nativeBaseEnergy === 'number' && Number.isFinite(food.nativeBaseEnergy) && maxEnergyLoss >= Math.max(0, -food.nativeBaseEnergy), '必须先预留可能的原生基础体力损失，未事后扩大预算。');
  io.observed('food_preflight', { food, player: query.player, buffs: query.buffs, buffsTruncated: query.buffsTruncated });
  const result = await io.call('dsh_consume', { inventorySlot: source.index, expectedItemId: args.itemId, expectedQuality: args.quality,
    foodDigest: food.digest, inventoryDigest: query.inventoryDigest, maxCount: 1, allowNegativeEdibility, maxHealthLoss, maxEnergyLoss, durationMs });
  io.observed('food_native_receipt', result);
  if (result.confirmedConsumption !== true && result.outcome === 'rejected') throw new Error('原生拒绝本次食用，没有当作吃下或自动再吃。');
  try {
    requireFact(result.confirmedConsumption === true && result.foodItemId === args.itemId && result.quality === args.quality && result.consumedCount === 1
      && ['consumed', 'consumed_waiting_ui'].includes(result.outcome) && object(result.beforePlayer) && object(result.afterPlayer)
      && result.beforePlayer.health - result.afterPlayer.health <= maxHealthLoss && result.beforePlayer.energy - result.afterPlayer.energy <= maxEnergyLoss + .001
      && result.beforeGold === result.afterGold && Array.isArray(result.beforeBuffs) && typeof result.beforeBuffsTruncated === 'boolean'
      && Array.isArray(result.afterBuffs) && typeof result.buffsTruncated === 'boolean'
      && Array.isArray(result.inventoryChanges) && result.inventoryChanges.length === 1
      && result.inventoryChanges[0].itemId === args.itemId && result.inventoryChanges[0].quality === args.quality && result.inventoryChanges[0].amount === -1, '原生结束、单份消耗或损失上限未完整确认。');
    verifyInventoryChanges(before, await io.inventory(), result.inventoryChanges);
    const after = await io.call('dsh_query_food', { offset: 0, limit: 1 }), snapshot = io.port.current();
    requireFact(after.isEating === false && Array.isArray(after.buffs) && typeof after.buffsTruncated === 'boolean'
      && object(after.player) && after.player.health === result.afterPlayer.health && after.player.maxHealth === result.afterPlayer.maxHealth
      && close(after.player.energy, result.afterPlayer.energy) && after.player.maxEnergy === result.afterPlayer.maxEnergy && after.player.baseMaxEnergy === result.afterPlayer.baseMaxEnergy
      && after.player.exhausted === result.afterPlayer.exhausted && snapshot.player.health === after.player.health && snapshot.player.maxHealth === after.player.maxHealth
      && close(snapshot.player.energy, after.player.energy) && close(snapshot.player.maxEnergy, after.player.maxEnergy)
      && String(result.afterGold) === snapshot.player.money, '新原生/MCP状态未确认实际生命、体力、上限及余额。');
    if (result.outcome === 'consumed') requireFact(result.completedWorkflow === true && result.nativeIdle === true && snapshot.player.canMove && !snapshot.ui.menuOpen, '普通食用未回到可操作世界。');
    else requireFact(args.itemId === '(O)434' && result.completedWorkflow === false && result.afterPlayer.baseMaxEnergy === result.beforePlayer.baseMaxEnergy + 34 && snapshot.ui.menuOpen, '专用食物提示没有完整的独立消耗及上限结果。');
    io.observed('food_consumption_verified', { itemId: args.itemId, quality: args.quality, count: 1, outcome: result.outcome,
      beforePlayer: result.beforePlayer, afterPlayer: result.afterPlayer, beforeBuffs: result.beforeBuffs, beforeBuffsTruncated: result.beforeBuffsTruncated,
      buffsAtNativeFinish: result.afterBuffs, buffsNow: after.buffs,
      buffsAtNativeFinishTruncated: result.buffsTruncated, buffsNowTruncated: after.buffsTruncated,
      note: 'Buff计时可自然推进；两份快照是不同观察时刻，不假设旧Buff仍持续。基础恢复不是最终恢复。' });
    if (result.outcome === 'consumed_waiting_ui') {
      io.report.reason = '星之果实单份消耗及原生上限变化已确认，专用提示仍待处理；不再食用或强关界面。'; return 'waiting';
    }
    return 'completed';
  } catch { return io.uncertain('食用后的独立背包、原生结束或生命/体力/Buff观察无法确认。'); }
}

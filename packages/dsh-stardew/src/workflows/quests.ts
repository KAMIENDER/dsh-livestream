import { object, requireFact, WorkflowIO, type ObjectValue } from '../workflow-context.js';
import { verifyInventoryChanges } from './inventory-receipt.js';

const keySchema = { type: 'string', minLength: 1, maxLength: 1024, description: '当前原生查询返回的完整key；普通任务key绑定实际对象，重载后失效' };
const tools = ['dsh_query_quest_ui', 'dsh_quest_ui', 'stardew_query_inventory'];
const acceptance = { type: 'object', additionalProperties: false, required: ['targetKey', 'contractDigest'], properties: {
  targetKey: keySchema, contractDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
} };
export const DAILY_ACCEPT_WORKFLOW = {
  name: 'quest_accept_daily', title: '从当前真实每日任务板接受明确求助', sourceStatus: 'implemented_unverified', requiredTools: tools, parameters: acceptance,
  scope: '正常打开的原生每日任务板。绑定具体实例key与合同指纹，点真实接受按钮；原生记录当天接受状态、两天期限和任务日志，再正常关闭板。不是生成或完成任务，不代替到任务板的路线。',
  postconditions: ['实际同一任务对象加入日志、accepted/daily=true、daysLeft=2', 'acceptedDailyQuest=true；金币和全部背包数量不变', '关闭已确认任务板后返回正常可操作世界'],
};
export const ORDER_ACCEPT_WORKFLOW = {
  name: 'special_order_accept', title: '从当前真实订单板接受一个明确订单', sourceStatus: 'implemented_unverified', requiredTools: [...tools, 'dsh_query_orders'], parameters: acceptance,
  scope: '原生普通/Qi订单板的明确一侧，key含类型/任务key/生成种子，指纹绑定期限、目标与奖励原始字段。原生接受可能锁定同类型另一选项，须具体主人审核。不是完成、捐物或领取所有订单奖励。',
  postconditions: ['真实团队订单出现相同key/种子/合同，acceptedSpecialOrderTypes包含该类型', '金币和全部背包数量不变；独立新订单查询核对', '正常关闭已确认的板，返回可操作世界'],
};
export const QUEST_MONEY_WORKFLOW = {
  name: 'quest_claim_money', title: '打开日志定位并领取一个已完成任务的准确金币奖励', sourceStatus: 'implemented_unverified', requiredTools: tools,
  parameters: { type: 'object', additionalProperties: false, required: ['targetKey', 'expectedReward'], properties: {
    targetKey: keySchema, expectedReward: { type: 'integer', minimum: 1, maximum: 2147483647 },
  } },
  scope: '从空闲世界正常打开原生日志，或使用已打开的同一日志；最多64页。精确定位普通任务/订单，核对已完成、待领和金币额，点击原生奖励。返回列表让游戏清理任务，再正常关闭。不取消任务、不调用Grant/金币/完成标记写入。',
  postconditions: ['金币恰好增加expectedReward，独立MCP运行状态余额一致，全部背包总量不变', '普通任务moneyReward=0且destroy=true/原生清理；订单当前参与者已退出领取名单', '返回列表、关闭日志；奖励已确认与界面清理分开记录，不重领'],
};
export const QUEST_WORKFLOWS = [DAILY_ACCEPT_WORKFLOW, ORDER_ACCEPT_WORKFLOW, QUEST_MONEY_WORKFLOW];
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
async function read(io: WorkflowIO): Promise<ObjectValue> {
  const value = await io.call('dsh_query_quest_ui', {});
  requireFact(['world', 'daily_board', 'special_board', 'quest_log', 'other'].includes(value.mode) && /^[a-f0-9]{64}$/.test(value.revision)
    && object(value.state) && Array.isArray(value.state.quests) && Array.isArray(value.state.orders) && whole(value.state.money, 0, 2147483647), '原生任务界面/账本不完整。');
  return value;
}
async function step(operation: string, args: ObjectValue, io: WorkflowIO, goldDelta = 0): Promise<{ receipt: ObjectValue; fresh: ObjectValue }> {
  const before = await io.inventory(), page = await read(io);
  const receipt = await io.call('dsh_quest_ui', { operation, revision: page.revision, ...args });
  io.observed(`quest_${operation}_native`, receipt);
  if (receipt.submitted === false && receipt.stale === true) throw new Error('任务界面已变化，未点击旧目标；重新查询，不自动重复请求。');
  try {
    requireFact(receipt.submitted === true && receipt.confirmedEffect === true && receipt.operation === operation
      && receipt.afterGold - receipt.beforeGold === goldDelta && receipt.beforeGold === page.state.money
      && Array.isArray(receipt.inventoryChanges) && receipt.inventoryChanges.length === 0, '原生任务步骤或准确金币增量未确认。');
    verifyInventoryChanges(before, await io.inventory(), receipt.inventoryChanges);
    const fresh = await read(io);
    // Runtime money is an exact integer string in the original bridge. Do not parse
    // formatted display text or accept an approximate balance as reward evidence.
    const wallet = io.port.current().player.money;
    requireFact(typeof wallet === 'string' && /^\d+$/.test(wallet) && wallet === String(receipt.afterGold) && fresh.state.money === receipt.afterGold, '独立MCP余额与原生领奖/无支出收据不一致。');
    io.observed(`quest_${operation}_independent`, { wallet, state: fresh.state });
    return { receipt, fresh };
  } catch { return io.uncertain('任务界面操作后金币、背包或真实账本无法核对。'); }
}
function onlyTarget(facts: ObjectValue[], key: string): ObjectValue {
  const matches = facts.filter(f => f.key === key);
  requireFact(matches.length === 1, '实际账本没有唯一的这个任务/订单实例；未按空ID或列表索引猜测。'); return matches[0];
}
function waiting(io: WorkflowIO, reason: string): 'waiting' { io.report.reason = reason; return 'waiting'; }

export async function questWorkflow(workflow: string, args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  const definition = QUEST_WORKFLOWS.find(w => w.name === workflow);
  requireFact(definition && object(args) && typeof args.targetKey === 'string' && args.targetKey.length > 0 && args.targetKey.length <= 1024 && !/[\x00-\x1f]/.test(args.targetKey), '需要当前真实任务实例/订单key。');
  io.needs(definition.requiredTools);
  const claiming = workflow === QUEST_MONEY_WORKFLOW.name;
  requireFact(Object.keys(args).every(k => ['targetKey', claiming ? 'expectedReward' : 'contractDigest'].includes(k)), '流程参数与workflows目录不符。');
  requireFact(claiming ? whole(args.expectedReward, 1, 2147483647) : typeof args.contractDigest === 'string' && /^[a-f0-9]{64}$/.test(args.contractDigest), '需要准确奖励额，或本次具体任务板合同指纹。');
  let page = await read(io);
  requireFact(page.eventUp === false, '剧情事件需独立流程，当前任务流程不推进事件。');
  if (!claiming) {
    requireFact(object(page.content) && page.mode === (workflow === DAILY_ACCEPT_WORKFLOW.name ? 'daily_board' : 'special_board'), '必须先正常走到并打开对应原生任务板，不能从模型文字生成任务板。');
    const offers = workflow === DAILY_ACCEPT_WORKFLOW.name ? [page.content.candidate] : [page.content.left, page.content.right];
    const candidate = onlyTarget(offers.filter(object), args.targetKey);
    requireFact(candidate.contractDigest === args.contractDigest && candidate.nativeType === true, '任务板候选合同与批准目标不符。');
    const result = await step(workflow === DAILY_ACCEPT_WORKFLOW.name ? 'accept_daily' : 'accept_order', args, io);
    try {
      const facts = onlyTarget(workflow === DAILY_ACCEPT_WORKFLOW.name ? result.fresh.state.quests : result.fresh.state.orders, args.targetKey);
      const accepted = workflow === DAILY_ACCEPT_WORKFLOW.name
        ? result.fresh.state.acceptedDailyQuest === true && facts.quest?.accepted === true && facts.quest.daily === true && facts.quest.daysLeft === 2
        : facts.contractDigest === args.contractDigest && Array.isArray(result.fresh.state.acceptedSpecialOrderTypes) && result.fresh.state.acceptedSpecialOrderTypes.includes(facts.order?.orderType);
      requireFact(accepted, '接取后缺少准确目标及原生接受标记。');
    } catch { await io.uncertain('接取按钮后没有独立确认所批准的准确任务/订单及原生接受标记。'); }
    if (workflow === ORDER_ACCEPT_WORKFLOW.name) {
      try {
        const orders = await io.call('dsh_query_orders', { targetKey: args.targetKey, offset: 0, limit: 2 });
        requireFact(Array.isArray(orders.items) && orders.items.length === 1 && orders.nextOffset === null && orders.items[0].contractDigest === args.contractDigest, '独立新订单查询不一致。');
      } catch { await io.uncertain('订单接取后无法独立确认目标合同。'); }
    }
    io.report.quest = { operation: 'accepted', targetKey: args.targetKey, receipt: result.receipt };
    const closed = await step('close', {}, io);
    return closed.fresh.mode === 'world' && io.port.current().player.canMove ? 'completed' : waiting(io, '任务接受已确认，界面尚未恢复可操作世界；不重新接受。');
  }
  if (page.mode === 'world') { io.ready(); page = (await step('open_log', {}, io)).fresh; }
  requireFact(page.mode === 'quest_log' && object(page.content), '当前有其他界面，未强关或改用原始输入领奖。');
  if (page.content.selectedIndex >= 0) requireFact(page.content.shown?.key === args.targetKey, '日志正在显示其他任务；未自动离开它以避免隐含原生清理。');
  else {
    requireFact(page.content.pagesTruncated === false && Array.isArray(page.content.pageKeys) && whole(page.content.pageCount, 1, 64), '当前日志超过本次64页覆盖，未猜测隐藏目标。');
    const matches = page.content.pageKeys.flatMap((keys: string[], index: number) => keys.filter(key => key === args.targetKey).map(() => index));
    requireFact(matches.length === 1, '当前原生日志没有唯一目标；已领奖/重载后的旧引用不会再次领取。');
    const targetPage = matches[0];
    for (let i = 0; i < 64 && page.content.page !== targetPage; i++) {
      page = (await step(page.content.page < targetPage ? 'next_page' : 'previous_page', {}, io)).fresh;
      requireFact(page.mode === 'quest_log' && object(page.content), '翻页后原生日志已变化。');
    }
    requireFact(page.content.page === targetPage, '未到准确任务所在页，未选择其他任务。');
    page = (await step('select', { targetKey: args.targetKey }, io)).fresh;
  }
  requireFact(page.content?.shown?.key === args.targetKey, '所显示任务不匹配，未领奖。');
  const shown = page.content.shown;
  if (shown.moneyReward === null) return waiting(io, '原生奖励总额尚未加载；重新查询当前日志，不推算或生成奖励。');
  requireFact(shown.nativeType === true && shown.moneyClaimable === true && shown.moneyReward === args.expectedReward, '任务未完成、已领奖或实际奖励额与批准不符。');
  const result = await step('claim_money', { targetKey: args.targetKey, expectedReward: args.expectedReward }, io, args.expectedReward);
  const target = result.receipt.targetAfter;
  const cleared = (fact: ObjectValue) => fact.quest ? fact.quest.completed === true && fact.quest.destroyed === true && fact.quest.moneyRewardField === 0 : fact.order?.participating === false;
  const freshTargets = [...result.fresh.state.quests, ...result.fresh.state.orders].filter((f: ObjectValue) => f.key === args.targetKey);
  // Native journal cleanup may already remove this exact completed object. Its actual
  // click receipt must show the cleared claim, and any surviving ledger row must agree.
  if (!(target?.key === args.targetKey && cleared(target) && freshTargets.length <= 1 && freshTargets.every(cleared))) await io.uncertain('金币变化后独立任务奖励或订单参与者状态未确认。');
  io.report.quest = { operation: 'money_claimed', targetKey: args.targetKey, receipt: result.receipt };
  io.observed('money_reward_confirmed_not_replayed', { targetKey: args.targetKey, amount: args.expectedReward });
  await step('back_to_list', { targetKey: args.targetKey }, io);
  page = (await step('close', {}, io)).fresh;
  return page.mode === 'world' && io.port.current().player.canMove ? 'completed' : waiting(io, '金币奖励已确认，界面未完全恢复；不重新领奖。');
}

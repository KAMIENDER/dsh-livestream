import { object, positionOf, requireFact, WorkflowIO, type ObjectValue } from '../workflow-context.js';
import { inventoryDelta as delta, verifyInventoryChanges as verifyChanges } from './inventory-receipt.js';

const nameSchema = { type: 'string', minLength: 1, maxLength: 128, description: '实际查询返回的NPC内部名，区分大小写' };
const target = { locationId: { type: 'string' }, npcName: nameSchema };
const offer = { itemId: { type: 'string', description: '背包实际(O)…完整ID' }, quality: { type: 'integer', minimum: 0, maximum: 4 } };
const commonTools = ['dsh_query_npc', 'dsh_query_dialogue', 'dsh_dialogue', 'stardew_query_inventory'];
const actorTools = [...commonTools, 'stardew_navigate', 'dsh_npc_action'];
const offerTools = [...actorTools, 'dsh_query_inventory', 'dsh_split_stack'];
const failure = '只确认本次原生效果；问题/其他菜单/事件返回waiting，不自动选答案、不重送礼或重交物。未知资源变化停止接管。';
export const NPC_TALK_WORKFLOW = {
  name: 'npc_talk', title: '与明确NPC交谈并读完普通对话', sourceStatus: 'implemented_unverified', requiredTools: actorTools,
  parameters: { type: 'object', additionalProperties: false, required: ['locationId', 'npcName'], properties: target },
  scope: '当前地点一个实际醒着的NPC；选择空/工具槽避免误送手持物，最多重新定位两次。只自动揭示/推进同一说话人的普通页；不推进事件、不替问题选答案。',
  postconditions: ['原生checkAction启动交互并核对独立背包与关系账本', '普通对话实际结束才completed；TalkedToToday另列事实，不把任意交互等同每日聊天'], failure,
};
export const NPC_GIFT_WORKFLOW = {
  name: 'npc_gift', title: '给明确村民一份普通礼物', sourceStatus: 'implemented_unverified', requiredTools: offerTools,
  parameters: { type: 'object', additionalProperties: false, required: ['locationId', 'npcName', 'itemId', 'quality'], properties: { ...target, ...offer } },
  scope: '已见面村民、指定ID/品质的1份普通物品；原生每日/每周/生日条件。过大堆叠先守恒分拆。拒绝花束、吊坠、电影票、星之果实茶及目标专属特殊交付；任务/订单会接管的物品不能冒充礼物。',
  postconditions: ['原生tryToReceiveActiveObject接受、指定物品减少1且今日/周礼物次数各加1', '新背包和真实玩家账本独立核对；对话问题waiting不重新赠礼'], failure,
};
export const NPC_DELIVER_WORKFLOW = {
  name: 'npc_deliver', title: '按真实任务引用交付普通物品求助任务', sourceStatus: 'implemented_unverified', requiredTools: [...offerTools, 'dsh_query_quests'],
  parameters: { type: 'object', additionalProperties: false, required: ['locationId', 'npcName', 'itemId', 'quality', 'maxOfferCount'], oneOf: [{ required: ['targetKey'] }, { required: ['questId'] }], properties: {
    ...target, ...offer, questId: { type: 'string', minLength: 1, maxLength: 128 }, maxOfferCount: { type: 'integer', minimum: 1, maximum: 10000 },
    targetKey: { type: 'string', minLength: 1, maxLength: 1024, description: '当前真实任务实例key；每日任务可没有原生ID，推荐用此项，不能跨存档重载复用' },
  } },
  scope: '一个实际未完成的原生ItemDeliveryQuest及其目标/物品/数量；只用一个足量堆叠，过量先分拆。不覆盖特殊订单、提交箱、其他类型剧情任务或领奖。',
  postconditions: ['任务自己的OnItemOfferedToNpc检查并消耗准确数量，completed=true', '新背包与任务日志核对，普通赠礼次数不变；完成交付不代表金币奖励已领取'], failure,
};
export const NPC_DIALOGUE_WORKFLOW = {
  name: 'npc_dialogue', title: '继续当前NPC对话或回答一个明确可见问题', sourceStatus: 'implemented_unverified', requiredTools: commonTools,
  parameters: { type: 'object', additionalProperties: false, required: ['npcName'], properties: {
    npcName: nameSchema, resumeWorkflowId: { type: 'string', description: '本连接最近waiting社交流程的真实id；可选，仅续读，不重放其动作' },
    answer: { type: 'object', additionalProperties: false, required: ['revision', 'expectedText', 'responseKey', 'responseText'], properties: {
      revision: { type: 'string' }, expectedText: { type: 'string' }, responseKey: { type: 'string' }, responseText: { type: 'string' },
    }, description: '选择答案须与当前可见问题及完整选项精确匹配，并由直播主人具体审核；省略则停在问题前' },
  } },
  scope: '仅当前实际对话，最多32个原生页操作。续读收据仅限本连接最近的waiting流程；不持久恢复旧UI引用。没有原收据时只报告对话结束，不能补认赠礼或交付。',
  postconditions: ['每步绑定真实说话人、原生菜单身份、当前文本/选项语义revision', '回答仅一次；后续新问题再次waiting', '资源变化核对；普通揭示/推进不可静默花钱或消耗物品'], failure,
};
export const SOCIAL_WORKFLOWS = [NPC_TALK_WORKFLOW, NPC_GIFT_WORKFLOW, NPC_DELIVER_WORKFLOW, NPC_DIALOGUE_WORKFLOW];

const whole = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const nameValid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value);
const keys = (v: ObjectValue, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
const fingerprint = (v: unknown): string => JSON.stringify(v);
async function ledger(npcName: string, io: WorkflowIO): Promise<ObjectValue> {
  const value = await io.call('dsh_query_npc', { npcName, stateOnly: true });
  requireFact(value.npcName === npcName && value.stateOnly === true && Array.isArray(value.quests) && object(value.date) && whole(value.money, 0, 2147483647), '无法读取真实玩家关系/任务账本。');
  return value;
}
async function verifyEffect(npcName: string, before: ObjectValue, receipt: ObjectValue, io: WorkflowIO): Promise<ObjectValue> {
  try {
    const after = await io.inventory(), state = await ledger(npcName, io);
    verifyChanges(before, after, receipt.inventoryChanges);
    requireFact(receipt.npcName === npcName && state.money === receipt.afterGold && fingerprint(state.friendship) === fingerprint(receipt.afterFriendship)
      && fingerprint(state.quests) === fingerprint(receipt.afterQuests), '独立玩家账本与原生NPC效果收据不一致。');
    io.observed('social_independent_receipt', { state, inventoryChanges: receipt.inventoryChanges });
    return state;
  } catch { return io.uncertain('社交动作后背包、关系、任务或金币无法独立确认。'); }
}
async function boundedOffer(args: ObjectValue, count: number, io: WorkflowIO): Promise<void> {
  const before = await io.inventory(), inventory = await io.call('dsh_query_inventory', {});
  requireFact(Array.isArray(inventory.slots) && /^[a-f0-9]{64}$/.test(inventory.digest), '原生背包槽位/digest缺失。');
  const candidates = inventory.slots.filter((s: ObjectValue) => s.item?.qualifiedItemId === args.itemId && s.item.quality === args.quality && s.item.stack >= count);
  const source = candidates.find((s: ObjectValue) => s.item.stack === count) ?? candidates[0];
  requireFact(source && whole(source.index, 0, 255), '需要一个足量实际物品堆叠；当前流程不自动合并多个来源。');
  if (source.item.stack === count) return;
  const empty = inventory.slots.find((s: ObjectValue) => s.item === null && whole(s.index, 0, 255));
  requireFact(empty, '需要真实空槽将交付堆叠限制到准确数量；不自动丢弃或出货腾位。');
  const result = await io.call('dsh_split_stack', { digest: inventory.digest, sourceSlot: source.index, destinationSlot: empty.index, quantity: count,
    expectedItemId: args.itemId, expectedQuality: args.quality });
  io.observed('social_offer_split', result);
  try {
    requireFact(result.completedWorkflow === true && delta(before, await io.inventory()).size === 0, '分拆未确认全部物品总量守恒。');
  } catch { await io.uncertain('交付物分拆后总量无法独立确认。'); }
}
async function actor(args: ObjectValue, io: WorkflowIO): Promise<ObjectValue> {
  const value = await io.call('dsh_query_npc', { npcName: args.npcName });
  requireFact(value.npcName === args.npcName && value.locationId === args.locationId && positionOf(value.position).locationId === args.locationId
    && /^[a-f0-9]{64}$/.test(value.digest) && /^[a-f0-9]{64}$/.test(value.inventoryDigest) && value.canTalk === true && value.sleeping === false && value.invisible === false, '没有在当前地点确认唯一可交互NPC。');
  return value;
}
async function approach(args: ObjectValue, io: WorkflowIO): Promise<ObjectValue> {
  for (let attempt = 0; attempt < 3; attempt++) {
    io.ready(args.locationId); const value = await actor(args, io), p = io.port.current().player.position, t = positionOf(value.position);
    if (Math.abs(p.x - t.x) + Math.abs(p.y - t.y) <= 1) return value;
    if (attempt === 2) break;
    await io.call('stardew_navigate', { position: t, arrival: 'adjacent' });
  }
  throw new Error('NPC持续移动，未朝旧坐标连续交互。');
}
function waiting(io: WorkflowIO, reason: string, dialogue: ObjectValue): 'waiting' {
  io.report.reason = reason; io.observed('social_waiting', dialogue); return 'waiting';
}
async function drain(npcName: string, io: WorkflowIO, answer?: ObjectValue): Promise<'completed' | 'waiting'> {
  let pendingAnswer = answer;
  let witnessedInteraction = !!io.report.social;
  for (let step = 0; step < 32; step++) {
    const page = await io.call('dsh_query_dialogue', {});
    if (page.eventUp === true) return waiting(io, '剧情事件需独立流程，当前普通对话流程不自动推进事件。', page);
    if (page.open === false) {
      requireFact(!pendingAnswer, '当前没有所批准的问题，未选择答案。');
      if (page.otherMenu || page.eventUp || io.port.current().ui.menuOpen || !io.port.current().player.canMove) return waiting(io, '原生事件或其他界面仍在继续。', page);
      requireFact(witnessedInteraction, '当前没有实际对话或可信续读收据；空界面不等于完成过交谈。');
      io.observed('npc_dialogue_finished', { npcName, talkCredit: (await ledger(npcName, io)).friendship?.talkedToToday ?? null }); return 'completed';
    }
    requireFact(page.open === true && page.npcName === npcName && /^[a-f0-9]{64}$/.test(page.revision) && typeof page.text === 'string'
      && typeof page.isQuestion === 'boolean' && typeof page.revealed === 'boolean', '当前说话人或语义对话身份不明确；未点击。');
    witnessedInteraction = true;
    if (pendingAnswer) requireFact(page.isQuestion === true && page.revision === pendingAnswer.revision && page.text === pendingAnswer.expectedText
      && Array.isArray(page.options) && page.options.some((o: ObjectValue) => o.visible === true && o.key === pendingAnswer!.responseKey && o.text === pendingAnswer!.responseText), '问题或完整选项已变化，原批准不能套到新问题。');
    const operation = !page.revealed ? 'reveal' : page.isQuestion ? pendingAnswer ? 'choose' : null : 'advance';
    if (!operation) return waiting(io, '问题需要按当前文本和可见选项具体审核；没有自动选答案。', page);
    const before = await io.inventory();
    const result = await io.call('dsh_dialogue', { npcName, revision: page.revision, expectedText: page.text, operation,
      ...(operation === 'choose' ? { responseKey: pendingAnswer!.responseKey, responseText: pendingAnswer!.responseText } : {}) });
    io.observed('npc_dialogue_step', result);
    if (result.stale === true && result.submitted === false) return waiting(io, '菜单/页已变，未点击旧目标；重新读取当前问题。', result.after ?? {});
    if (!(result.submitted === true && result.stale === false && object(result.before) && result.before.npcName === npcName)) await io.uncertain('没有明确原生对话提交收据。');
    await verifyEffect(npcName, before, { ...result, npcName }, io);
    if (io.report.social) io.report.social.dialogueSteps++;
    if (operation === 'choose') pendingAnswer = undefined;
  }
  return waiting(io, '已达到本次32步对话上限；不重放先前礼物/交付。', await io.call('dsh_query_dialogue', {}));
}

export async function socialWorkflow(workflow: string, args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  const definition = SOCIAL_WORKFLOWS.find(w => w.name === workflow);
  requireFact(definition && object(args) && nameValid(args.npcName), '需要workflows目录中的明确NPC内部名和参数。');
  io.needs(definition.requiredTools);
  if (workflow === 'npc_dialogue') {
    requireFact(keys(args, ['npcName', 'resumeWorkflowId', 'answer']), 'npc_dialogue只接受说话人、可选真实续读ID和明确答案。');
    if (args.resumeWorkflowId !== undefined) {
      const previous = io.port.previousWorkflow;
      requireFact(previous && previous.id === args.resumeWorkflowId && previous.status === 'waiting' && previous.social && previous.social.npcName === args.npcName, '只可续读本连接最近的waiting社交流程，不能自报旧收据。');
      const state = await ledger(args.npcName, io);
      requireFact(fingerprint(state.date) === fingerprint(previous.social.receipt.verifiedState?.date), '日期已改变；旧社交效果不作为今天完成的收据。');
      io.report.social = JSON.parse(JSON.stringify(previous.social));
      io.observed('social_continuation_no_reoffer', { previousWorkflowId: previous.id });
    }
    if (args.answer !== undefined) requireFact(object(args.answer) && keys(args.answer, ['revision', 'expectedText', 'responseKey', 'responseText'])
      && /^[a-f0-9]{64}$/.test(args.answer.revision) && ['expectedText', 'responseKey', 'responseText'].every(k => typeof args.answer[k] === 'string'), 'answer需要当前问题revision/全文及选项key/全文。');
    return drain(args.npcName, io, args.answer);
  }
  const operation = workflow === 'npc_talk' ? 'talk' : workflow === 'npc_gift' ? 'gift' : 'deliver';
  requireFact(keys(args, operation === 'talk' ? ['locationId', 'npcName'] : operation === 'gift' ? ['locationId', 'npcName', 'itemId', 'quality']
    : ['locationId', 'npcName', 'questId', 'targetKey', 'itemId', 'quality', 'maxOfferCount']) && nameValid(args.locationId), '社交流程参数与目录不符。');
  io.ready(args.locationId);
  let count = 0;
  let deliveryKey: string | undefined;
  if (operation !== 'talk') {
    requireFact(typeof args.itemId === 'string' && /^\(O\)[^\s\x00-\x1f]{1,128}$/.test(args.itemId) && whole(args.quality, 0, 4), '必须指定真实物体ID及品质。');
    const npc = await actor(args, io);
    requireFact(npc.villager === true, '普通赠礼/交付只处理真实村民。');
    count = 1;
    if (operation === 'gift') requireFact(Array.isArray(npc.giftCandidates) && npc.giftCandidates.some((c: ObjectValue) => c.itemId === args.itemId && c.quality === args.quality && c.count > 0), '指定物品不是当前普通礼物候选，特殊物品另走专用流程。');
    else {
      const hasKey = typeof args.targetKey === 'string' && args.targetKey.length > 0 && args.targetKey.length <= 1024 && !/[\x00-\x1f]/.test(args.targetKey);
      requireFact((hasKey && args.questId === undefined || args.targetKey === undefined && nameValid(args.questId)) && whole(args.maxOfferCount, 1, 10000), '普通交付需要当前任务实例key或唯一原生ID，及准确数量上限。');
      const page = await io.call('dsh_query_quests', { ...(hasKey ? { targetKey: args.targetKey } : { questId: args.questId }), state: 'active', offset: 0, limit: 2 });
      requireFact(Array.isArray(page.items) && page.items.length === 1 && page.nextOffset === null, '未确认唯一活动任务。');
      const q = page.items[0];
      requireFact(q.type === 'StardewValley.Quests.ItemDeliveryQuest' && q.completed === false && q.destroyed === false && q.delivery?.npcName === args.npcName
        && q.delivery.itemId === args.itemId && whole(q.delivery.count, 1, args.maxOfferCount), '任务类型/目标/物品/数量与所批准交付不符。');
      requireFact(typeof q.key === 'string' && q.key.length > 0, '缺少当前真实任务实例key。');
      deliveryKey = q.key; count = q.delivery.count; io.observed('delivery_contract', q);
    }
    await boundedOffer(args, count, io);
  }
  const npc = await approach(args, io), before = await io.inventory();
  // Requery immediately before the native action. Neither an old location nor a model
  // claim about friendship/quest completion is an actor or inventory authority.
  const inventory = operation === 'talk' ? null : await io.call('dsh_query_inventory', {});
  const source = inventory?.slots?.find((s: ObjectValue) => s.item?.qualifiedItemId === args.itemId && s.item.quality === args.quality && s.item.stack === count);
  requireFact(operation === 'talk' || source && whole(source.index, 0, 255), '准确交付堆叠已变化；未递出更大的堆叠。');
  const fresh = await actor(args, io);
  requireFact(positionOf(fresh.position).locationId === npc.locationId && (operation === 'talk' || fresh.inventoryDigest === inventory!.digest), '交互前NPC或背包发生变化。');
  const receipt = await io.call('dsh_npc_action', { operation, npcName: args.npcName, actorDigest: fresh.digest, inventoryDigest: fresh.inventoryDigest,
    ...(operation === 'talk' ? {} : { inventorySlot: source.index, expectedItemId: args.itemId, expectedQuality: args.quality, maxOfferCount: count }),
    ...(operation === 'deliver' ? { targetKey: deliveryKey } : {}) });
  io.observed('social_native_receipt', receipt);
  const state = await verifyEffect(args.npcName, before, receipt, io);
  if (receipt.confirmedEffect !== true) {
    if (!['rejected', 'not_started'].includes(receipt.outcome)) await io.uncertain('原生社交没有明确接受或拒绝结果。');
    throw new Error(`原生社交结果为${receipt.outcome}；未当作赠礼/交付成功，也没有重试。`);
  }
  const valid = receipt.operation === operation && (operation === 'talk' ? receipt.outcome === 'interaction_started'
    : receipt.outcome === (operation === 'gift' ? 'gifted' : 'delivered') && receipt.amountConsumed === count
      && receipt.offeredItemId === args.itemId && receipt.offeredQuality === args.quality
      && (operation !== 'deliver' || receipt.targetKey === deliveryKey && state.quests.some((q: ObjectValue) => q.key === deliveryKey && q.completed === true)));
  if (!valid) await io.uncertain('社交收据没有确认所请求操作、物品或任务。');
  io.report.social = { npcName: args.npcName, operation, receipt: { ...receipt, verifiedState: state }, dialogueSteps: 0, originWorkflowId: io.report.id };
  return drain(args.npcName, io);
}

import type { MachineInput, MachineJob } from '../production.js';
import { object, positionOf, requireFact, WorkflowIO, WorkflowStepError, type ObjectValue } from '../workflow-context.js';

const positionSchema = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: { locationId: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } } };
export const MACHINE_WORKFLOW = {
  name: 'machine_cycle', title: '原生机器投料、持久等待、收取一轮产物', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_inventory', 'dsh_query_machine', 'dsh_split_stack', 'dsh_machine', 'stardew_navigate'],
  parameters: { type: 'object', additionalProperties: false, properties: {
    jobId: { type: 'string', description: '已有production/workflow返回的ID；续接时只传jobId，不改变原目标或预算' },
    position: positionSchema, expectedMachineItemId: { type: 'string', description: '实际查询到的机器完整物品ID' },
    allowHopperReload: { type: 'boolean', default: false, description: '收取可能触发原生漏斗继续消耗其中物料；此项与背包材料预算分开，续接时不能扩大' },
    input: { type: 'object', additionalProperties: false, required: ['itemId', 'quality', 'maxInputCount', 'materialBudgets'], properties: {
      itemId: { type: 'string' }, quality: { type: 'integer', minimum: 0, maximum: 4 }, maxInputCount: { type: 'integer', minimum: 1, maximum: 10000 },
      materialBudgets: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['itemId', 'maxCount'], properties: { itemId: { type: 'string' }, maxCount: { type: 'integer', minimum: 1, maximum: 10000 } } } },
    }, description: '省略时只接手当前真实processing/ready的一轮，不声称本次投入了原料' },
  } },
  scope: '当前地点普通Data/Machines生产器；原料堆叠按上限分拆，总量守恒；不包含孵化器、带专用InteractMethod界面或缺少机器数据的旧类。原生条件不满足时停止，不改时间或直接写产物。',
  postconditions: ['投料只确认processing/ready及实际耗材，随后持久记录为waiting', '生产内容指纹匹配后才收取；计时变化允许，内容变化停止', '收取核对原生库存增量和旧产物释放；随机重算产物保留实际收据', '跨天/会话不重放loading/collecting/uncertain动作'],
};
export const MACHINE_STOP_WORKFLOW = {
  name: 'machine_stop_tracking', title: '停止跟踪一项已知生产记录', sourceStatus: 'implemented_unverified', requiredTools: [] as string[],
  parameters: { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: { type: 'string' } } },
  scope: '只关闭prepared/waiting记录的跟踪；游戏中的机器继续原生产，不退款、不清空产物。结果未知的记录不能用此入口抹掉。',
  postconditions: ['已知生产记录标为stopped并保留历史；无游戏动作'],
};
const qualified = (value: unknown): value is string => typeof value === 'string' && /^\([A-Za-z]+\)[^\s\x00-\x1f]{1,128}$/.test(value);
function inputOf(value: unknown): MachineInput {
  requireFact(object(value) && Object.keys(value).every(key => ['itemId', 'quality', 'maxInputCount', 'materialBudgets'].includes(key))
    && qualified(value.itemId) && value.itemId.startsWith('(O)') && Number.isInteger(value.quality) && value.quality >= 0 && value.quality <= 4
    && Number.isInteger(value.maxInputCount) && value.maxInputCount >= 1 && value.maxInputCount <= 10000
    && Array.isArray(value.materialBudgets) && value.materialBudgets.length <= 16, 'input需要实际物体原料ID、品质、投入上限和明确额外材料预算。');
  const budgets = value.materialBudgets.map((budget: unknown) => {
    requireFact(object(budget) && Object.keys(budget).every(key => ['itemId', 'maxCount'].includes(key)) && qualified(budget.itemId)
      && Number.isInteger(budget.maxCount) && budget.maxCount >= 1 && budget.maxCount <= 10000, '材料预算需要实际物品ID及1–10000上限。');
    return { itemId: budget.itemId, maxCount: budget.maxCount };
  });
  requireFact(new Set(budgets.map(budget => budget.itemId)).size === budgets.length, '额外材料预算不能重复同一个ID。');
  return { itemId: value.itemId, quality: value.quality, maxInputCount: value.maxInputCount, materialBudgets: budgets };
}
function observe(job: MachineJob, machine: ObjectValue): void {
  job.lastObserved = { state: machine.state, minutesUntilReady: machine.minutesUntilReady, output: machine.output, observedAt: new Date().toISOString() };
}

export async function machineCycle(args: unknown, io: WorkflowIO): Promise<'waiting' | 'completed'> {
  requireFact(object(args), 'machine_cycle需要workflows声明的JSON对象。');
  const store = io.port.jobs;
  requireFact(store, '需要当前真实存档身份和生产记录库，未通过普通按键代替生产恢复。');
  io.needs(MACHINE_WORKFLOW.requiredTools);
  let job: MachineJob;
  const query = async (position: unknown, itemId: string): Promise<{ machine: ObjectValue; inventoryDigest: string }> => {
    const value = await io.call('dsh_query_machine', { position });
    requireFact(object(value.machine) && value.machine.machineItemId === itemId && /^[a-f0-9]{64}$/.test(value.machine.contentsKey)
      && /^[a-f0-9]{64}$/.test(value.machine.digest) && Number.isInteger(value.machine.minutesUntilReady)
      && /^[a-f0-9]{64}$/.test(value.inventoryDigest), '机器身份、内容指纹或计时事实不完整。');
    requireFact(value.machine.dataMachine === true && value.machine.incubator === false && !value.machine.machineData?.interactMethod, '这个对象需要独立专用流程；不是当前普通数据机器。');
    return { machine: value.machine, inventoryDigest: value.inventoryDigest };
  };
  if (args.jobId !== undefined) {
    requireFact(typeof args.jobId === 'string' && Object.keys(args).every(key => key === 'jobId'), '续接只接受真实jobId，不能改变原位置、原料或预算。');
    job = store.get(args.jobId); store.assertBuild(job);
  } else {
    requireFact(Object.keys(args).every(key => ['position', 'expectedMachineItemId', 'input', 'allowHopperReload'].includes(key)) && qualified(args.expectedMachineItemId)
      && (args.allowHopperReload === undefined || typeof args.allowHopperReload === 'boolean'), '新生产需要实际position、expectedMachineItemId及可选漏斗权限。');
    const position = positionOf(args.position), input = args.input === undefined ? null : inputOf(args.input);
    const value = await query(position, args.expectedMachineItemId); io.ready(position.locationId);
    requireFact(input ? value.machine.state === 'idle' : ['processing', 'ready'].includes(value.machine.state), input ? '机器不是空闲状态，未重复投料。' : '没有可接手的真实生产或成熟产物。');
    job = store.create(position, args.expectedMachineItemId, input, io.port.runId, args.allowHopperReload === true);
    if (!input) { job.phase = 'waiting'; job.contentsKey = value.machine.contentsKey; observe(job, value.machine); store.put(job); }
    io.observed('production_registered', { jobId: job.id, phase: job.phase, adoptedExistingCycle: !input });
  }
  if (job.phase === 'completed') { io.observed('already_completed_no_replay', { jobId: job.id, receipt: job.receipt }); return 'completed'; }
  requireFact(job.phase !== 'stopped', '该生产跟踪已关闭，没有重新领取或重放原动作。');
  if (['loading', 'collecting', 'uncertain'].includes(job.phase)) {
    throw new Error(`生产记录${job.id}停在${job.phase}，此前动作未完整确认；先核对现场，不能自动重放。`);
  }
  job.lastRunId = io.port.runId;
  let submitted: 'load' | 'collect' | 'split' | null = null;
  const approach = async (): Promise<void> => {
    io.ready(job.position.locationId);
    const at = io.port.current().player.position;
    if (Math.abs(at.x - job.position.x) + Math.abs(at.y - job.position.y) > 1) await io.call('stardew_navigate', { position: job.position, arrival: 'adjacent' });
    io.ready(job.position.locationId);
  };
  try {
    if (job.phase === 'prepared' && !job.requestedInput) {
      // Registration can be interrupted before saving its observed-cycle fingerprint.
      // No native action was submitted in this phase: adopt only a fresh actual cycle.
      const existing = await query(job.position, job.machineItemId); io.ready(job.position.locationId);
      requireFact(['processing', 'ready'].includes(existing.machine.state), '接手登记中断后没有真实生产可继续，未投料或伪造原周期。');
      job.phase = 'waiting'; job.contentsKey = existing.machine.contentsKey; observe(job, existing.machine); store.put(job);
      io.observed('adopted_native_cycle', { jobId: job.id, observed: job.lastObserved });
    }
    if (job.phase === 'prepared') {
      requireFact(job.requestedInput, '准备态缺少原料记录，未猜测投入。');
      const input = inputOf(job.requestedInput);
      await approach();
      let inventory = await io.call('dsh_query_inventory', {});
      requireFact(Array.isArray(inventory.slots) && /^[a-f0-9]{64}$/.test(inventory.digest), '扩展背包快照不完整。');
      const matches = (slot: ObjectValue) => slot.item?.qualifiedItemId === input.itemId && slot.item.quality === input.quality && Number.isInteger(slot.item.stack) && slot.item.stack > 0;
      let selected = inventory.slots.filter((slot: ObjectValue) => matches(slot) && slot.item.stack <= input.maxInputCount)
        .sort((a: ObjectValue, b: ObjectValue) => b.item.stack - a.item.stack)[0];
      const large = inventory.slots.find((slot: ObjectValue) => matches(slot) && slot.item.stack > input.maxInputCount);
      const empty = inventory.slots.find((slot: ObjectValue) => slot.item === null);
      // Prefer a full bounded stack where possible: choosing an earlier one-item remnant
      // could reject a valid five-ore recipe even while a larger stack is owned.
      if (!selected || selected.item.stack < input.maxInputCount && large && empty) {
        requireFact(large && empty, '没有符合预算的实际原料堆叠，或没有空槽进行守恒分拆；未丢弃物品。');
        submitted = 'split';
        const split = await io.call('dsh_split_stack', { digest: inventory.digest, sourceSlot: large.index, destinationSlot: empty.index,
          quantity: input.maxInputCount, expectedItemId: input.itemId, expectedQuality: input.quality });
        io.observed('input_stack_split', split);
        requireFact(split.completedWorkflow === true, '原料分拆没有得到守恒确认，停止且不重复分拆。');
        inventory = await io.call('dsh_query_inventory', {});
        requireFact(Array.isArray(inventory.slots), '分拆后的背包无法确认。');
        selected = inventory.slots.filter((slot: ObjectValue) => matches(slot) && slot.item.stack <= input.maxInputCount)
          .sort((a: ObjectValue, b: ObjectValue) => b.item.stack - a.item.stack)[0];
        submitted = null;
      }
      requireFact(selected, '没有确认可投入的预算内原料堆叠。');
      const value = await query(job.position, job.machineItemId); io.ready(job.position.locationId);
      requireFact(value.machine.state === 'idle', '机器不再空闲，未覆盖已有产物。');
      job.phase = 'loading'; store.put(job); submitted = 'load';
      const result = await io.call('dsh_machine', { position: job.position, operation: 'load', expectedMachineItemId: job.machineItemId,
        machineDigest: value.machine.digest, inventoryDigest: value.inventoryDigest, inputSlot: selected.index,
        inputItemId: input.itemId, inputQuality: input.quality, maxInputCount: input.maxInputCount, materialBudgets: input.materialBudgets });
      io.observed('machine_load_result', result);
      if (result.completedWorkflow !== true) {
        job.phase = 'prepared'; job.reason = result.reason; store.put(job); submitted = null;
        throw new Error('原生机器没有确认投料；未自动重复。按实际条件/材料规则重新规划。');
      }
      requireFact(object(result.afterMachine) && /^[a-f0-9]{64}$/.test(result.afterMachine.contentsKey) && ['processing', 'ready'].includes(result.afterMachine.state), '投料后机器内容事实不完整。');
      job.phase = 'waiting'; job.contentsKey = result.afterMachine.contentsKey; observe(job, result.afterMachine);
      job.receipt = { load: { runId: io.port.runId, inventoryChanges: result.inventoryChanges, observedOutput: result.afterMachine.output } };
      job.reason = undefined; store.put(job); submitted = null;
    }
    const value = await query(job.position, job.machineItemId); io.ready(job.position.locationId);
    observe(job, value.machine);
    if (value.machine.contentsKey !== job.contentsKey) {
      job.phase = 'uncertain'; job.reason = '机器内容与记录不一致，不能把别的周期归为本次生产。'; store.put(job);
      throw new Error(job.reason);
    }
    if (value.machine.state === 'processing') {
      store.put(job); io.report.status = 'waiting';
      io.report.continuation = { jobId: job.id, workflow: MACHINE_WORKFLOW.name, minutesUntilReady: value.machine.minutesUntilReady, position: job.position };
      io.observed('production_waiting', { jobId: job.id, observed: job.lastObserved,
        waitCondition: value.machine.machineData?.onlyCompleteOvernight === true ? 'native_overnight_update' : 'native_game_minutes',
        note: '游戏分钟，不是承诺的墙钟时间；可先做其他事，再用相同jobId查询。不推进时间或重复投料。' });
      return 'waiting';
    }
    requireFact(value.machine.state === 'ready' && value.machine.inventoryCanAcceptOutput === true, '产物未成熟或背包不能完整接收；保留waiting记录，不清空机器或丢弃物品。');
    requireFact(value.machine.hopperMayReload !== true || job.allowHopperReload, '该机器收取后可能由漏斗继续耗材；原记录没有允许此事，保留待办。');
    await approach();
    const fresh = await query(job.position, job.machineItemId);
    requireFact(fresh.machine.contentsKey === job.contentsKey && fresh.machine.state === 'ready', '靠近后产物状态变化，未使用旧观察收取。');
    job.phase = 'collecting'; store.put(job); submitted = 'collect';
    const result = await io.call('dsh_machine', { position: job.position, operation: 'collect', expectedMachineItemId: job.machineItemId,
      machineDigest: fresh.machine.digest, inventoryDigest: fresh.inventoryDigest, allowHopperReload: job.allowHopperReload });
    io.observed('machine_collect_result', result);
    if (result.completedWorkflow !== true) {
      job.phase = 'waiting'; job.reason = result.reason; store.put(job); submitted = null;
      throw new Error('原生收取没有完整确认，保留待办，没有自动再点。');
    }
    requireFact(Array.isArray(result.received) && result.received.length > 0 && result.received.every((item: ObjectValue) => qualified(item.itemId) && Number.isSafeInteger(item.amount) && item.amount > 0), '实际入袋收据不完整。');
    job.phase = 'completed'; job.reason = undefined;
    job.receipt = { ...(object(job.receipt) ? job.receipt : {}), collect: { runId: io.port.runId, received: result.received, inventoryChanges: result.inventoryChanges,
      machineAfter: { state: result.afterMachine?.state, contentsKey: result.afterMachine?.contentsKey, output: result.afterMachine?.output } } };
    observe(job, result.afterMachine); store.put(job); submitted = null;
    io.observed('production_cycle_completed', { jobId: job.id, receipt: job.receipt });
    return 'completed';
  } catch (error) {
    if (submitted) {
      const rejectedBeforeMutation = error instanceof WorkflowStepError && ['dsh_machine', 'dsh_split_stack'].includes(error.tool) && error.result.status === 'failed';
      job.phase = rejectedBeforeMutation ? submitted === 'collect' ? 'waiting' : 'prepared' : 'uncertain';
      job.reason = error instanceof Error ? error.message.slice(0, 600) : '生产动作未完整确认。';
      store.put(job);
    }
    throw error;
  }
}

export function stopMachineTracking(args: unknown, io: WorkflowIO): void {
  requireFact(object(args) && typeof args.jobId === 'string' && Object.keys(args).every(key => key === 'jobId'), '只接受真实jobId。');
  requireFact(io.port.jobs, '没有当前存档的生产记录库。');
  const job = io.port.jobs.get(args.jobId); io.port.jobs.assertBuild(job);
  requireFact(['prepared', 'waiting', 'stopped'].includes(job.phase), '完成或结果未知的记录不能用停止跟踪抹掉。');
  job.phase = 'stopped'; job.lastRunId = io.port.runId; job.reason = '停止跟踪请求；原生生产继续，未退款或清空产物。';
  io.port.jobs.put(job); io.observed('production_tracking_stopped', { jobId: job.id, gameActionsSubmitted: 0, note: job.reason });
}

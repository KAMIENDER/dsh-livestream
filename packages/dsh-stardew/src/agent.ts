import { defineTool } from '@deepseek-ai/dsh-tools';
import { historyFor, recoveryFor, startGame, stopGame, useGame } from './runtime.js';
import { MAX_RUN_DAYS } from './run-options.js';

export const name = 'dsh-stardew-agent';
export const inject = ['tools'];
interface Context {
  get?(name: string): any;
  tools: { register(tool: unknown): () => void };
  effect(effect: () => () => void, label?: string): unknown;
}
interface Exec { agent?: { id: string }; signal: AbortSignal }

const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
async function inSession(exec: Exec, work: (owner: string) => Promise<string>): Promise<string> {
  if (!exec.agent?.id) return '没有 DSH 会话身份，无法接管游戏。';
  try { return await work(exec.agent.id); }
  catch (error) { return error instanceof Error ? error.message : '游戏连接异常，请检查 SMAPI 和控制程序。'; }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_permissions',
    description: '只读查看本会话由主人授予的农活范围、剩余次数、资源预留和启动期限。不创建或修改授权，不允许自报会话、主人或存档身份；失败或未知结果不退额度。',
    parameters: {}, output,
    async execute(_args, exec) { return inSession(exec, async owner => JSON.stringify(ctx.get?.('liveAccess')?.farmPermissionsFor?.(owner) ?? { scopes: [], note: '当前没有直播权限服务；本工具不能授权任何操作。' })); },
  })), 'stardew own permission status');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_recovery',
    description: '只读查询本会话持久接管记录、runId和检查点恢复条件；连接丢失或重启后也可用。不连接游戏、不证明现场一致、不重领天数或重放动作。不能指定其他会话ID。',
    parameters: {}, output,
    async execute(_args, exec) { return inSession(exec, async owner => recoveryFor(owner)); },
  })), 'stardew own recovery status');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_history',
    description: '按本会话真实已保存接管记录读取所属农场经历，连接断开/经营完成后也可用。recoverDays仅从已核对的日终检查点补记遗漏历史，不连接、不重复睡眠、不重领预算、不猜原人物；不能指定其他会话/存档/runId。',
    parameters: {
      offset: { type: 'integer', description: '默认0' }, limit: { type: 'integer', description: '1–20，默认6' },
      recoverDays: { type: 'boolean', description: '默认false；true只补记已保存的正常换日日报。缺失人物绑定保持unbound，不导入当前人物' },
    }, output,
    async execute(args, exec) { return inSession(exec, async owner => historyFor(owner, args.recoverDays === true, args.offset ?? 0, args.limit ?? 6)); },
  })), 'stardew own offline game history');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_start',
    description: '连接已加载的星露谷单人存档，按固定天数自主经营，默认一天。只有主人要求连续经营才设置 days；重复调用不延长预算。不会购买、安装游戏或自动选择存档。',
    parameters: {
      game: { type: 'string', required: true, description: '本预设支持 stardew' },
      days: { type: 'integer', description: `本次经营天数，1–${MAX_RUN_DAYS}；省略为 1。遵守主人指定的天数` },
      goal: { type: 'string', description: '本次目标和主人的约束；每日计划在 plan 中记录' },
    },
    output,
    async execute(args, exec) {
      if (args.game !== 'stardew') return '本预设只接入星露谷，请填 stardew。';
      return inSession(exec, owner => startGame(owner, exec.signal, { days: args.days, goal: args.goal }));
    },
  })), 'stardew start');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_resume',
    description: '显式恢复 report或game_recovery返回的runId。需扩展Mod、相同存档/游戏构建/日期/控制摘要且无结果不明动作；保留原天数和动作预算，不能用于开启新一天或重放旧操作。',
    parameters: { runId: { type: 'string', required: true, description: '此前report或本会话game_recovery返回的UUID；不能猜测' } },
    output,
    async execute(args, exec) { return inSession(exec, owner => startGame(owner, exec.signal, {}, args.runId)); },
  })), 'stardew resume');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_continue',
    description: '观察主角当前日期、时间、体力、位置和背包。游戏时间持续流动；不要无目的轮询。',
    parameters: {},
    output,
    async execute(_args, exec) { return inSession(exec, owner => useGame(owner, game => game.observe(exec.signal))); },
  })), 'stardew observe');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_act',
    description: 'catalog/coverage查接口与完整玩法缺口；workflows查语义流程，workflow执行；production查机器记录；experiences分页读后端已核对历史；schema查参数；plan/remember记模型计划笔记；memory/task/schedule管理历史与任务；report读日报；call执行；end_day核对睡眠；next_day继续。',
    parameters: {
      action: { type: 'string', required: true, enum: ['catalog', 'coverage', 'workflows', 'schema', 'plan', 'remember', 'report', 'production', 'experiences', 'memory', 'task', 'schedule', 'call', 'workflow', 'end_day', 'next_day'] },
      name: { type: 'string', description: 'schema、call 使用的工具名；workflow 使用 workflows 返回的流程名；catalog/coverage 可填返回过的玩法 ID' },
      text: { type: 'string', description: 'call/workflow真实JSON参数，先查schema/workflows；production/experiences分页{offset,limit(1–20)}；memory分页{section(summary/tasks/notes/observations),offset,limit}；task：id?、text、priority(1–5)、dependsOn[]、goldBudget、energyBudget、dueDay?、status(todo/done/blocked)、evidence?、remove?。预算不填为未知；plan/remember使用文字，模型记录不是游戏确认' },
    },
    output,
    async execute(args, exec) {
      return inSession(exec, owner => useGame(owner, game => game.act({
        action: String(args.action ?? ''),
        name: typeof args.name === 'string' ? args.name : undefined,
        text: typeof args.text === 'string' ? args.text : undefined,
      }, exec.signal)));
    },
  })), 'stardew act');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_stop',
    description: '取消当前游戏操作并关闭 AI 控制连接。保留游戏窗口；游戏时间不会因此暂停。',
    parameters: {},
    output,
    async execute(_args, exec) { return inSession(exec, owner => stopGame(owner)); },
  })), 'stardew stop');
}

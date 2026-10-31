import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Agent, Context, Exec } from './host.js';
import { director } from './director.js';

export const name = 'dsh-game-director-agent';
export const inject = ['tools', 'subagents', 'agentPresets', 'workingDirectory', 'llm'];
const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

async function run(exec: Exec, work: (parent: Agent) => Promise<unknown> | unknown): Promise<string> {
  if (!exec.agent) return '没有 DSH 会话身份，无法使用游戏导演。';
  try {
    exec.signal.throwIfAborted();
    return JSON.stringify(await work(exec.agent), null, 2);
  } catch (error) {
    return `游戏导演：${error instanceof Error ? error.message : '操作失败，请检查插件状态。'}`;
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_library',
    description: '查看游戏目录、配置的预设是否可启动、本次选择及任务记录。可启动不等于游戏现场已验证。',
    parameters: {}, output,
    execute: (_args, exec) => run(exec, parent => director().library(ctx, parent.id)),
  })), 'game library');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_choose',
    description: '决定本次想玩的游戏，并记录理由和玩法目标。可提出尚未接入的新游戏；不会因此自动安装或启动它。',
    parameters: {
      game: { type: 'string', required: true, description: '游戏 ID，小写字母、数字和连字符；例如 stardew' },
      title: { type: 'string', description: '新游戏的名称；目录已有则可省略' },
      reason: { type: 'string', required: true, description: '结合主人偏好、可用接口和时间，说明为什么选择它' },
      goal: { type: 'string', required: true, description: '本次有限目标，例如经营一天或完成一局；包括主人的约束' },
    }, output,
    execute: (args, exec) => run(exec, parent => director().choose(parent.id, args.game, args.title, args.reason, args.goal)),
  })), 'game choice');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_develop',
    description: '启动 DeepSeek 开发会话：先查现有接入；没有则阅读真实游戏源码，缺源码时用已安装的 REA 静态分析本机程序，再依据证据写适配。不编译、不测试、不安装、不提交。立即返回任务和 childId，结束后 DSH 通知。',
    parameters: {
      references: { type: 'string', description: '官方文档、已有项目和调查线索，最多 6000 字' },
      source_path: { type: 'string', description: '可选，本机已有游戏源码目录；只读调查，相对路径基于当前工作区' },
      repository: { type: 'string', description: '可选，游戏或 Mod 的公开 HTTPS 源码仓库地址；未提供时开发会话自己查找' },
      artifact_path: { type: 'string', description: '可选，用 REA 静态分析的本机游戏目录或程序集路径；不是源码路径时不要冒充源码' },
    },
    output,
    execute: (args, exec) => run(exec, parent => director().start(ctx, parent, 'develop', exec.signal, {
      references: typeof args.references === 'string' ? args.references : undefined,
      sourcePath: typeof args.source_path === 'string' ? args.source_path : undefined,
      repository: typeof args.repository === 'string' ? args.repository : undefined,
      artifactPath: typeof args.artifact_path === 'string' ? args.artifact_path : undefined,
    })),
  })), 'game adapter development');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_play',
    description: '通过已配置且可用的游戏预设启动一次自主游玩子会话。当前导演对话最多发起一次；现场加载检查由游戏驱动负责。立即返回 childId，完成后 DSH 通知。',
    parameters: {}, output,
    execute: (_args, exec) => run(exec, parent => director().start(ctx, parent, 'play', exec.signal)),
  })), 'game play');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_task',
    description: '查看当前对话的一项任务和开发报告；未传 ID 时查看最近一项。completed 仅指子会话正常结束，不代表源码已验证或游戏目标已完成。',
    parameters: { task: { type: 'string', description: 'game_develop 或 game_play 返回的任务 id' } }, output,
    execute: (args, exec) => run(exec, parent => director().task(parent.id, typeof args.task === 'string' ? args.task : undefined)),
  })), 'game task status');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'game_cancel',
    description: '取消当前对话发起的任务，并通过游戏驱动释放它的控制连接。不会暂停游戏时钟；停止失败时需核对现场。',
    parameters: { task: { type: 'string', description: '要取消的任务 id；省略时使用最近一项' } }, output,
    execute: (args, exec) => run(exec, parent => director().cancel(ctx, parent, typeof args.task === 'string' ? args.task : undefined)),
  })), 'game task cancellation');
}

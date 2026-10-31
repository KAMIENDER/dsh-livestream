import z from '@deepseek-ai/schemastery';
import type { Settings } from './model.js';
import { defaults, enable } from './director.js';

export const name = 'dsh-game-director';
export const Config = z.object({
  playBindings: z.string().default(defaults.playBindings).description('游戏与已安装预设、停止控制服务的绑定，使用 JSON 数组；新增源码不会自动写入这里').volatile(),
  maxDevelopmentAttempts: z.number().min(1).max(5).step(1).default(2).description('同一对话对同一游戏最多发起几次接入开发，默认 2 次').volatile(),
  developerProvider: z.string().default(defaults.developerProvider).description('开发会话的模型提供方；默认使用 DSH 的 DeepSeek 官方提供方，不可用时不会悄悄换模型').volatile(),
  developerModel: z.string().default(defaults.developerModel).description('开发会话的模型 ID，需与 DSH 模型设置中的实际可用模型一致').volatile(),
  reaCommand: z.string().default(defaults.reaCommand).description('已安装的 REA 可执行文件路径或命令名；只填写程序，不填写整条 shell 命令').volatile(),
});
type Cells = { [K in keyof Settings]?: { get(): Settings[K] | undefined } };
interface Context { effect(effect: () => () => Promise<void>, label?: string): unknown }

export function apply(ctx: Context, config: Cells = {}): void {
  ctx.effect(() => enable(() => ({
    playBindings: config.playBindings?.get() ?? defaults.playBindings,
    maxDevelopmentAttempts: config.maxDevelopmentAttempts?.get() ?? defaults.maxDevelopmentAttempts,
    developerProvider: config.developerProvider?.get() ?? defaults.developerProvider,
    developerModel: config.developerModel?.get() ?? defaults.developerModel,
    reaCommand: config.reaCommand?.get() ?? defaults.reaCommand,
  })), 'game director state and owned tasks');
}

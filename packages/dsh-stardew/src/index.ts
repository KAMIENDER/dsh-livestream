import z from '@deepseek-ai/schemastery';
import type { LiveBody } from './game.js';
import type { Settings } from './config.js';
import { bindCharacterMemory, bindSettings, current, currentOwner, settings, stopGame } from './runtime.js';

export const name = 'dsh-stardew';
export const Config = z.object({
  mcpCommand: z.string().default('').description('星露谷控制程序的可执行文件路径；留空自动查找 stardew-valley-mcp').volatile(),
  modConfig: z.string().default('').description('StardewValleyMCP 的 config.json 路径；留空查找 Steam 默认安装目录。密钥直接从文件读取，不需粘贴').volatile(),
  captureWindow: z.string().default('').description('直播时要捕获的游戏窗口。Mac 填 OBS 窗口列表中的完整名称；留空时由你在 OBS 中选取画面').volatile(),
  extensionConfig: z.string().default('').description('DSHStardew 扩展 Mod 的 config.json；留空自动查找。未安装时保留基础农活接口').volatile(),
});

type ConfigCells = { [K in keyof Settings]?: { get(): string | undefined } };
interface Context {
  get?(name: string): any;
  provide(name: string, value: unknown): void;
  effect(effect: () => () => void, label?: string): unknown;
}

export function apply(ctx: Context, config: ConfigCells = {}): void {
  bindCharacterMemory(() => ctx.get?.('characterMemory'));
  bindSettings(() => ({
    mcpCommand: config.mcpCommand?.get() ?? '',
    modConfig: config.modConfig?.get() ?? '',
    captureWindow: config.captureWindow?.get() ?? '',
    extensionConfig: config.extensionConfig?.get() ?? '',
  }));
  // The director releases exactly its child session; it cannot stop another conversation's farm.
  ctx.provide('stardewControl', {
    gameId: 'stardew',
    memorySubjectFor(ownerId: string) { return currentOwner() === ownerId ? current()?.farmId : undefined; },
    autonomyFor(ownerId: string, workflow: string, text: string) {
      return currentOwner() === ownerId ? current()?.autonomyRequest?.(workflow, text) : undefined;
    },
    async stopSession(ownerId: string) {
      if (currentOwner() && currentOwner() !== ownerId) return { stopped: false, message: '另一个会话正在控制星露谷，未停止它。' };
      await stopGame(ownerId);
      return { stopped: true };
    },
  });
  ctx.effect(() => {
    let placed: LiveBody | undefined;
    let window = '';
    const update = () => {
      const live = ctx.get?.('liveBody') as LiveBody | undefined;
      // A standalone farming session must not replace a different game's current live picture.
      const next = live?.onAir && live.gameSessionId === currentOwner() && current()?.active
        ? settings().captureWindow.trim() : '';
      if (placed && (placed !== live || !next)) { placed.showGame(null); placed = undefined; window = ''; }
      if (live && next && (placed !== live || window !== next)) {
        live.showGame({ window: next });
        placed = live;
        window = next;
      }
    };
    const timer = setInterval(update, 1000);
    return () => { clearInterval(timer); placed?.showGame(null); void stopGame(); };
  }, 'dsh-stardew lifecycle and live screen');
}

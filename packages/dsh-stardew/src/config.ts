import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

export interface Settings {
  mcpCommand: string;
  modConfig: string;
  captureWindow: string;
  extensionConfig?: string;
}

const expand = (value: string) => value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;

function defaultModConfig(): string | undefined {
  const home = homedir();
  const steam = process.platform === 'darwin'
    ? [join(home, 'Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS')]
    : process.platform === 'win32'
      ? [join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam/steamapps/common/Stardew Valley')]
      : [join(home, '.local/share/Steam/steamapps/common/Stardew Valley'), join(home, '.steam/steam/steamapps/common/Stardew Valley')];
  return steam.map(dir => join(dir, 'Mods/StardewValleyMCP/config.json')).find(existsSync);
}

/** Read the Mod's own connection file at startup; never return its secret to the model or UI. */
export function connectionSettings(settings: Settings): { command: string; env: Record<string, string>; configPath: string } {
  const configPath = settings.modConfig.trim() ? expand(settings.modConfig.trim()) : defaultModConfig();
  if (!configPath) throw new Error('没有找到星露谷 Mod 配置。先通过 SMAPI 启动一次游戏，或在插件设置中填写 Mod 配置文件。');
  let config: { Host?: unknown; Port?: unknown; SharedSecretBase64?: unknown };
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error('无法读取星露谷 Mod 配置文件，请检查插件设置中的路径和文件格式。');
  }
  if (!config || !['127.0.0.1', 'localhost', '::1'].includes(String(config.Host))) {
    throw new Error('本版本连接本机游戏；Mod 的 Host 需为回环地址。');
  }
  const port = Number(config.Port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof config.SharedSecretBase64 !== 'string' || !config.SharedSecretBase64.trim()) {
    throw new Error('Mod 配置缺少有效端口或共享密钥，请先通过 SMAPI 启动 Mod 完成初始化。');
  }
  const localCommand = join(homedir(), '.local/bin/stardew-valley-mcp');
  const command = settings.mcpCommand.trim()
    ? expand(settings.mcpCommand.trim())
    : existsSync(localCommand) ? localCommand : 'stardew-valley-mcp';
  if (isAbsolute(command) && !existsSync(command)) throw new Error('找不到配置的 MCP 程序，请检查可执行文件路径。');
  return {
    command,
    configPath,
    env: {
      STARDEW_VALLEY_MCP_HOST: String(config.Host),
      STARDEW_VALLEY_MCP_PORT: String(port),
      STARDEW_VALLEY_MCP_SHARED_SECRET: config.SharedSecretBase64,
    },
  };
}

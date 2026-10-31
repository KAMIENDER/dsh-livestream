import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ToolOutcome {
  status: 'succeeded' | 'failed' | 'unknown';
  output?: Record<string, any>;
  error?: { code?: string; message?: string };
}

/** MCP transport only. No game-specific actions, UI assumptions or automatic retries here. */
export class GameMcpClient {
  private client = new Client({ name: 'dsh-stardew', version: '0.0.1' });
  private tools = new Map<string, Tool>();
  private changed = false;

  async connect(command: string, env: Record<string, string>, signal: AbortSignal): Promise<void> {
    const transport = new StdioClientTransport({
      command,
      args: ['serve', '--allow-write'],
      env: { ...getDefaultEnvironment(), ...env },
      stderr: 'pipe',
    });
    // Third-party stderr may contain configuration. Drain it without copying it into DSH logs.
    transport.stderr?.on('data', () => {});
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { this.changed = true; });
    try {
      await this.client.connect(transport, { signal, timeout: 20_000 });
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await this.client.listTools(cursor ? { cursor } : {}, { signal, timeout: 20_000 });
        for (const tool of page.tools) this.tools.set(tool.name, tool);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('Repeated tool cursor');
        if (cursor) cursors.add(cursor);
        if (this.tools.size > 128 || cursors.size > 16) throw new Error('Unexpected tool list');
      } while (cursor);
    } catch {
      await this.close();
      throw new Error('星露谷 MCP 连接失败。请检查可执行文件、SMAPI Mod、已加载的存档和连接配置。');
    }
  }

  tool(name: string): Tool | undefined { return this.tools.get(name); }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal, timeout = 190_000): Promise<ToolOutcome> {
    if (this.changed) throw new Error('游戏控制接口发生变化，请停止本次接管并重新连接。');
    if (!this.tools.has(name)) throw new Error(`游戏没有提供 ${name}。`);
    try {
      const result = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout });
      // StardewValley MCP's public V1 contract uses structuredContent as the authoritative result.
      const value = result.structuredContent as ToolOutcome | undefined;
      if (!value || !['succeeded', 'failed', 'unknown'].includes(value.status) || (result.isError && value.status === 'succeeded')) {
        return { status: 'unknown', error: { code: 'invalid_result', message: '游戏返回了不符合约定的结果，不能确认动作是否完成。' } };
      }
      return value;
    } catch {
      // An interrupted/expired call may already have reached the game. Never submit it again automatically.
      return { status: 'unknown', error: { code: 'connection_interrupted', message: '连接中断、调用取消或超时；结果未知，不能自动重放。' } };
    }
  }

  async close(): Promise<void> { await this.client.close().catch(() => {}); }
}

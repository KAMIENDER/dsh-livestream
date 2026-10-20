/**
 * 舞台服务器：插件自己开一个端口（DSH 网页版和桌面版都能用），OBS 的浏览器源直接打开它。
 *
 *   GET  /?token=…                 舞台页（按当前模板摆好挂件）
 *   GET  /stage.js /stage.css       舞台页的代码（插件包 lib/）
 *   GET  /characters/<id>/<file>   角色包、/templates/<id>/<file> 模板（见 packs.ts）
 *   GET  /events?token=…           舞台事件流（SSE）
 *   POST /said?id=…&token=…        舞台念完一句
 *
 * 所有请求都要带 token（OBS 里填的地址自带），只监听本机。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { StageEvent } from '../stage/protocol';
import type { Packs } from './packs';
import type { Stage } from './stage';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

export interface StageServerOptions {
  port: number;
  token: string;
  /** 插件包目录（有 lib/、stage/） */
  packageDir: string;
  packs: Packs;
  stage: Stage;
  /** 现在用哪个角色、哪个模板 */
  current(): { character: string; template: string };
  log?(level: 'info' | 'warn', message: string): void;
}

export class StageServer {
  private server: Server | null = null;

  constructor(private readonly options: StageServerOptions) {}

  get url(): string {
    return `http://127.0.0.1:${this.options.port}/?token=${this.options.token}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.options.log?.('warn', `舞台请求出错：${(err as Error).message}`);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      server.requestTimeout = 0;
      server.once('error', reject);
      server.listen(this.options.port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
  }

  // ── 请求 ────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('token') !== this.options.token) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('舞台地址不对：请从 DSH 的直播控制台复制完整地址（带 token）。');
      return;
    }
    const path = url.pathname;
    if (req.method === 'POST' && path === '/said') {
      this.options.stage.said(url.searchParams.get('id') ?? '');
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (path === '/events') return this.events(req, res, url);
    if (path === '/' || path === '/index.html') return this.file(res, join(this.options.packageDir, 'stage', 'index.html'));
    if (path === '/stage.js') return this.file(res, join(this.options.packageDir, 'lib', 'stage.js'));
    if (path === '/stage.css') return this.file(res, join(this.options.packageDir, 'stage', 'stage.css'));
    const pack = /^\/(characters|templates)\/([\w-]{1,64})\/(.+)$/.exec(path);
    if (pack) {
      const dir = this.options.packs.dir(pack[1] as 'characters' | 'templates', pack[2]);
      if (dir) return this.file(res, join(dir, decodeURIComponent(pack[3])), dir);
    }
    res.writeHead(404);
    res.end();
  }

  private events(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (event: StageEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const { character, template } = this.options.current();
    const c = this.options.packs.character(character);
    const t = this.options.packs.template(template);
    if (c && t) send({ v: 1, type: 'hello', character: c, template: t, at: Date.now() });
    // ?preview=1：控制台里的预览，静音、不回执
    const unsubscribe = this.options.stage.subscribe(send, url.searchParams.get('preview') !== '1');
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  private file(res: ServerResponse, file: string, within?: string): void {
    const resolved = normalize(file);
    // 只给包里或用户目录里的文件（防 ../ 跳出去）
    if (within && !resolved.startsWith(normalize(within) + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': extname(resolved) === '.html' || extname(resolved) === '.js' ? 'no-store' : 'max-age=3600',
    });
    res.end(readFileSync(resolved));
  }
}

// 实测用：DSH 插件里起 MCP（Streamable HTTP，JSON 响应，不开 SSE），两个入口
//   http://127.0.0.1:<dsh 端口>/livestream/mcp   挂在 DSH webserver 上
//   http://127.0.0.1:3192/mcp                    插件自己开的端口
// 工具 probe_wait 阻塞 seconds 秒；日志记下每次调用、以及客户端提前断开的时刻
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'dsh-livestream-spike';
export const inject = ['webServer'];

const TOKEN = 'spike-token';
const LOG = join(process.env.DSH_HOME ?? '.', 'livestream-spike.log');
const log = (o) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');

const TOOLS = [{
  name: 'probe_wait',
  description: 'Transport test: blocks for `seconds` seconds, then returns how long it actually waited.',
  inputSchema: { type: 'object', properties: { seconds: { type: 'number', description: 'how long to block' } }, required: ['seconds'] },
}];

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

function send(res, status, body) {
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function handle(req, res, via) {
  const ua = req.headers['user-agent'] ?? '';
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { log({ via, ua, event: 'unauthorized', method: req.method }); return send(res, 401, { error: 'unauthorized' }); }
  if (req.method !== 'POST') { log({ via, ua, event: 'non-post', method: req.method }); return send(res, 405); }
  let msg;
  try { msg = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
  if (msg.id === undefined) { log({ via, ua, event: 'notification', method: msg.method }); return send(res, 202); }
  const reply = (result) => send(res, 200, { jsonrpc: '2.0', id: msg.id, result });
  log({ via, ua, event: 'request', method: msg.method, params: msg.method === 'initialize' ? { protocolVersion: msg.params?.protocolVersion, client: msg.params?.clientInfo } : msg.params });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dsh-livestream-spike', version: '0.0.0' } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const seconds = Number(msg.params?.arguments?.seconds ?? 0);
      const start = Date.now();
      let closed = false;
      res.on('close', () => { if (!res.writableEnded) { closed = true; log({ via, ua, event: 'client-closed', afterSeconds: (Date.now() - start) / 1000, asked: seconds }); } });
      await new Promise((r) => setTimeout(r, seconds * 1000));
      if (closed) return;
      const waited = (Date.now() - start) / 1000;
      log({ via, ua, event: 'tool-done', asked: seconds, waited });
      return reply({ content: [{ type: 'text', text: `probe_wait: waited ${waited.toFixed(1)}s via ${via}` }] });
    }
    default:
      return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/livestream/mcp', handler: (req, res) => handle(req, res, 'dsh-webserver') }), 'livestream spike route');
  ctx.effect(() => {
    const server = http.createServer((req, res) => handle(req, res, 'own-port'));
    server.requestTimeout = 0;
    server.listen(3192, '127.0.0.1', () => log({ event: 'own-port listening', port: 3192 }));
    return () => server.close();
  }, 'livestream spike own port');
  log({ event: 'plugin applied' });
}

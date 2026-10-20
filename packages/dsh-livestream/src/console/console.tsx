/**
 * 主人控制台：连直播间、开播下播、OBS 地址、换模板和角色、舞台预览、看弹幕、跟她说话、模拟观众。
 *
 * 开播 = 开一个「大肥鱼直播」会话 + 身体开播（/onair，带上这个会话）。之后往会话里推事情的是身体（宿主端），
 * 这一页关掉也不影响直播。
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

// ── DSH 服务 ──────────────────────────────────────────

interface RemoteResult { ok: boolean; error?: { message: string } }

export interface ConsoleServices {
  workspaces: { list: { getSnapshot(): { items: readonly { workspaceId: string }[] } } };
  uiWorkspace: { openSession(sessionId: string): void };
  sessions: {
    create(opts: { workspaceId: string }): Promise<string>;
    using<T>(target: string, options: { source: string }, operation: (reference: { ready: Promise<{ session: any }> }) => T | Promise<T>): Promise<T>;
  };
  remote: { agentPresets: { select(sessionId: string, presetId: string): Promise<RemoteResult> } };
  layout: { selectPanel(panelId: string | null): void };
}

export interface Credentials {
  describe(refs: string[]): Promise<{ ok: boolean; value?: Record<string, { configured?: boolean } | undefined> }>;
  set(ref: string, value: string): Promise<unknown>;
}

let services: ConsoleServices | null = null;
let credentials: Credentials | null = null;
const serviceListeners = new Set<() => void>();
let serviceVersion = 0;

export function bindConsole(next: ConsoleServices): void {
  services = next;
  serviceVersion += 1;
  for (const l of serviceListeners) l();
}

export function bindCredentials(next: Credentials | null): void {
  credentials = next;
  serviceVersion += 1;
  for (const l of serviceListeners) l();
}

function useCredentials(): Credentials | null {
  useSyncExternalStore((l) => { serviceListeners.add(l); return () => serviceListeners.delete(l); }, () => serviceVersion);
  return credentials;
}

function useServices(): ConsoleServices | null {
  useSyncExternalStore((l) => { serviceListeners.add(l); return () => serviceListeners.delete(l); }, () => serviceVersion);
  return services;
}

// ── 宿主接口 ──────────────────────────────────────────

const PRESET_ID = 'dsh-livestream';
const SECRET_REFS = { cookie: 'BILIBILI_COOKIE', tts: 'DOUBAO_TTS_API_KEY' } as const;

interface PackEntry { id: string; name: string; builtin: boolean }
interface SpokenLine { text: string; mood: string; at: number }
interface ShowStatus {
  live: { state: string; room?: { title?: string; anchorName?: string; realRoomId?: number }; loggedIn: boolean; stats: { online?: number; live?: boolean }; perMinute: Record<string, number>; lastError?: string };
  onAir: boolean;
  brain: 'off' | 'listening' | 'thinking' | 'speaking' | 'away';
  brainSession: string | null;
  heat: string;
  audience: boolean;
  pending: Record<string, number>;
  lines: SpokenLine[];
  stageWatchers: number;
  roomId: number | null;
}
interface HostState {
  ok: boolean;
  show: ShowStatus;
  settings: { roomId: number | null; character: string; template: string; voice: string; stagePort: number; idleAfterSec: number; distillModel: string };
  stageUrl: string;
  characters: PackEntry[];
  templates: PackEntry[];
}

async function api<T = HostState>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/dsh-livestream/${path}`, body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

// ── 事件流 ────────────────────────────────────────────

interface FeedRow { key: string; kind: string; uid: string; name: string; text: string; yuan?: number; at: number }

interface Live {
  status: ShowStatus | null;
  feed: FeedRow[];
  focus: Set<string>;
  brainDetail: string;
}

let live: Live = { status: null, feed: [], focus: new Set(), brainDetail: '' };
const liveListeners = new Set<() => void>();
let source: EventSource | null = null;
let feedSeq = 0;

function setLive(change: (l: Live) => Live): void {
  live = change(live);
  for (const l of liveListeners) l();
}

function connectFeed(): void {
  if (source) return;
  source = new EventSource('/api/dsh-livestream/events');
  source.addEventListener('status', (m) => setLive((l) => ({ ...l, status: JSON.parse((m as MessageEvent).data) as ShowStatus })));
  source.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'live') {
      const ev = e.event;
      if (e.isUpdate && ev.kind !== 'gift') return;
      const text = ev.kind === 'chat' || ev.kind === 'superchat' ? ev.text
        : ev.kind === 'gift' ? `送出 ${ev.gift} ×${ev.count}`
          : ev.kind === 'membership' ? `开通了${ev.level}`
            : ev.kind === 'enter' ? '进入直播间' : '关注了直播间';
      setLive((l) => {
        const existing = l.feed.findIndex((r) => r.key === ev.id);
        const row: FeedRow = { key: ev.id, kind: ev.kind, uid: ev.user.id, name: ev.user.name, text, yuan: ev.yuan, at: Date.now() };
        const feed = existing >= 0 ? l.feed.map((r, i) => (i === existing ? row : r)) : [...l.feed, row].slice(-200);
        return { ...l, feed };
      });
    } else if (e.type === 'say') {
      setLive((l) => ({ ...l, feed: [...l.feed, { key: `say-${++feedSeq}`, kind: 'her', uid: '', name: '她', text: e.text, at: Date.now() }].slice(-200) }));
    } else if (e.type === 'focus') {
      setLive((l) => ({ ...l, focus: new Set(e.userIds) }));
    } else if (e.type === 'brain') {
      setLive((l) => ({ ...l, brainDetail: e.detail ?? '' }));
    }
  };
}

function useLive(): Live {
  useEffect(connectFeed, []);
  return useSyncExternalStore((l) => { liveListeners.add(l); return () => liveListeners.delete(l); }, () => live);
}

// ── 开播：会话 ────────────────────────────────────────

/** 开一个用「大肥鱼直播」预设的会话（她直播用） */
async function createBrainSession(svc: ConsoleServices): Promise<string> {
  const workspace = svc.workspaces.list.getSnapshot().items[0];
  if (!workspace) throw new Error('先在 DSH 里打开一个工作区。');
  const sessionId = await svc.sessions.create({ workspaceId: workspace.workspaceId });
  const selected = await svc.remote.agentPresets.select(sessionId, PRESET_ID);
  if (!selected.ok) throw new Error(selected.error?.message ?? '没能用上「大肥鱼直播」预设。');
  // 让会话就绪（agent 起来），身体才能往里推
  await svc.sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => { await reference.ready; });
  return sessionId;
}

async function cancel(svc: ConsoleServices, sessionId: string): Promise<void> {
  await svc.sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
    const { session } = await reference.ready;
    await session.cancel();
  });
}

// ── 小组件 ────────────────────────────────────────────

function Card({ title, extra, children, className }: { title: string; extra?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`dl-card ${className ?? ''}`}>
      <header><h2>{title}</h2>{extra}</header>
      {children}
    </section>
  );
}

function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) {
  return <i className={`dl-dot dl-${tone}`} />;
}

const BRAIN_TEXT = { off: '没在播', listening: '在听弹幕', thinking: '正在想', speaking: '在说话', away: '暂时走开了' } as const;
const CONN_TEXT: Record<string, string> = { idle: '没连接', connecting: '连接中', connected: '已连上', reconnecting: '重连中', error: '连接出错' };

function useBusy(): [boolean, string, (run: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    fn().catch((e) => setError((e as Error).message)).finally(() => setBusy(false));
  };
  return [busy, error, run];
}

function SecretField({ label, ref_, hint }: { label: string; ref_: string; hint: string }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [value, setValue] = useState('');
  const [busy, error, run] = useBusy();
  const creds = useCredentials();
  useEffect(() => {
    if (!creds) return;
    void creds.describe([ref_]).then((r) => setConfigured(!!r.value?.[ref_]?.configured)).catch(() => {});
  }, [creds, ref_]);
  if (!creds) return <div className="dl-field"><label>{label}</label><p className="dl-hint">这个 DSH 没有凭据服务：用环境变量 {ref_} 提供。</p></div>;
  return (
    <div className="dl-field">
      <label>{label} {configured === null ? null : configured ? <span className="dl-tag dl-ok-tag">已配置</span> : <span className="dl-tag">未配置</span>}</label>
      <div className="dl-row">
        <input type="password" value={value} placeholder={configured ? '已保存（重新填写会覆盖）' : hint} onChange={(e) => setValue(e.target.value)} />
        <button disabled={busy || !value.trim()} onClick={() => run(async () => {
          await creds.set(ref_, value.trim());
          setValue('');
          const r = await creds.describe([ref_]);
          setConfigured(!!r.value?.[ref_]?.configured);
        })}>保存</button>
      </div>
      {error && <p className="dl-error">{error}</p>}
    </div>
  );
}

// ── 控制台 ────────────────────────────────────────────

export function Console() {
  const svc = useServices();
  const { status, feed, focus, brainDetail } = useLive();
  const [host, setHost] = useState<HostState | null>(null);
  const [busy, error, run] = useBusy();
  const [room, setRoom] = useState('');
  const [ownerText, setOwnerText] = useState('');
  const [copied, setCopied] = useState(false);

  const refresh = () => api('state').then((s) => { setHost(s); setRoom((r) => r || (s.settings.roomId ? String(s.settings.roomId) : '')); });
  useEffect(() => { void refresh().catch(() => {}); }, []);

  const show = status ?? host?.show ?? null;
  const settings = host?.settings;

  const goLive = () => run(async () => {
    if (!svc) throw new Error('插件还没准备好，刷新一下页面再试。');
    const sessionId = await createBrainSession(svc);
    await api('onair', { sessionId });
    await refresh();
  });

  const endLive = () => run(async () => { await api('offair', {}); await refresh(); });

  const saveRoom = () => run(async () => {
    setHost(await api('settings', { roomId: Number(room) }));
    setHost(await api('connect', {}));
  });

  const choose = (patch: Record<string, unknown>) => run(async () => setHost(await api('settings', patch)));

  const sendOwner = () => run(async () => {
    if (!ownerText.trim()) return;
    await api('owner', { text: ownerText });
    setOwnerText('');
  });

  const copyUrl = () => {
    if (!host) return;
    void navigator.clipboard.writeText(host.stageUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  const conn = show?.live.state ?? 'idle';
  const connTone = conn === 'connected' ? 'ok' : conn === 'error' ? 'bad' : conn === 'idle' ? 'idle' : 'warn';
  const previewUrl = host ? `${host.stageUrl}&preview=1` : '';
  const brainTone = !show?.onAir ? 'idle' : show.brain === 'away' ? 'bad' : show.brain === 'speaking' ? 'warn' : 'ok';

  return (
    <div className="dl-room">
      <div className="dl-page">
        <header className="dl-top">
          <div>
            <div className="dl-path">dsh-livestream <b>/ 直播间</b></div>
            <h1>{show?.onAir ? <span className="dl-onair">LIVE</span> : null}大肥鱼直播</h1>
          </div>
          <div className="dl-top-actions">
            {show?.onAir
              ? <button className="dl-btn dl-danger" disabled={busy} onClick={endLive}>下播（先让她道别）</button>
              : <button className="dl-btn dl-primary" disabled={busy} onClick={goLive}>开播</button>}
          </div>
        </header>
        {error && <p className="dl-error dl-banner">{error}</p>}

        <div className="dl-grid">
          <div className="dl-col">
            <Card title="舞台预览" className="dl-preview-card" extra={<span className="dl-meta">{show?.stageWatchers ? `OBS 已连上 ${show.stageWatchers} 个` : 'OBS 还没打开舞台'}</span>}>
              <div className="dl-preview">{previewUrl && <iframe src={previewUrl} title="舞台预览" />}</div>
              <div className="dl-field">
                <label>OBS 舞台地址（来源 → 浏览器 → 粘贴，宽 1920 高 1080）</label>
                <div className="dl-row">
                  <input readOnly value={host?.stageUrl ?? ''} onFocus={(e) => e.currentTarget.select()} />
                  <button onClick={copyUrl}>{copied ? '已复制' : '复制'}</button>
                </div>
              </div>
              <div className="dl-row dl-pick">
                <div className="dl-field">
                  <label>模板（直播间的皮）</label>
                  <select value={settings?.template ?? ''} onChange={(e) => choose({ template: e.target.value })}>
                    {host?.templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.builtin ? '' : '（自定义）'}</option>)}
                  </select>
                </div>
                <div className="dl-field">
                  <label>角色</label>
                  <select value={settings?.character ?? ''} onChange={(e) => choose({ character: e.target.value })}>
                    {host?.characters.map((c) => <option key={c.id} value={c.id}>{c.name}{c.builtin ? '' : '（自定义）'}</option>)}
                  </select>
                </div>
              </div>
            </Card>

            <Card title="跟她说话" extra={<span className="dl-meta">观众也会听到她的回答</span>}>
              <div className="dl-row">
                <input value={ownerText} placeholder="比如：给大家讲讲你今天学到的东西" onChange={(e) => setOwnerText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendOwner(); }} />
                <button disabled={busy || !show?.onAir || !ownerText.trim()} onClick={sendOwner}>说</button>
              </div>
            </Card>

            <Simulator />
          </div>

          <div className="dl-col">
            <Card title="她现在" extra={<span className="dl-state"><Dot tone={brainTone} />{show?.onAir ? (show.brain === 'thinking' && brainDetail ? brainDetail : BRAIN_TEXT[show.brain]) : '没在播'}</span>}>
              <div className="dl-stats">
                <div><b>{show?.live.stats.online ?? '–'}</b><span>在线</span></div>
                <div><b>{show?.live.perMinute.chat ?? 0}</b><span>弹幕/分</span></div>
                <div><b>{show ? { quiet: '冷清', normal: '一般', busy: '热闹' }[show.heat] ?? show.heat : '–'}</b><span>热度</span></div>
                <div><b>{show ? (show.pending.chats ?? 0) + (show.pending.gifts ?? 0) + (show.pending.thanks ?? 0) + (show.pending.superchats ?? 0) : 0}</b><span>待回应</span></div>
              </div>
              {show?.brainSession && <button className="dl-link" onClick={() => svc?.uiWorkspace.openSession(show.brainSession!)}>打开她直播的会话</button>}
              {show?.brainSession && show.onAir && <button className="dl-link" onClick={() => svc && void cancel(svc, show.brainSession!)}>让她停下这一轮</button>}
            </Card>

            <Card title="直播间" className="dl-feed-card" extra={<span className="dl-state"><Dot tone={connTone} />{CONN_TEXT[conn] ?? conn}{show?.live.room?.title ? ` · ${show.live.room.title}` : ''}</span>}>
              <Feed feed={feed} focus={focus} />
            </Card>

            <Card title="连接">
              <div className="dl-field">
                <label>B 站直播间房间号</label>
                <div className="dl-row">
                  <input value={room} inputMode="numeric" placeholder="比如 21452505" onChange={(e) => setRoom(e.target.value.replace(/\D/g, ''))} />
                  {conn === 'idle' || conn === 'error'
                    ? <button disabled={busy || !room} onClick={saveRoom}>连接</button>
                    : <button disabled={busy} onClick={() => run(async () => setHost(await api('disconnect', {})))}>断开</button>}
                </div>
                {show?.live.state === 'connected' && !show.live.loggedIn && <p className="dl-hint">匿名连接：部分观众的名字会被 B 站打码。填上 Cookie 就能看到完整名字。</p>}
                {show?.live.lastError && <p className="dl-error">{show.live.lastError}</p>}
              </div>
              <SecretField label="B 站 Cookie" ref_={SECRET_REFS.cookie} hint="浏览器里登录 B 站后复制的 Cookie（建议用小号）" />
              <SecretField label="豆包语音 API Key" ref_={SECRET_REFS.tts} hint="火山引擎新版控制台的 API Key（和 dsh-game 共用）" />
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function Feed({ feed, focus }: { feed: FeedRow[]; focus: Set<string> }) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => feed.filter((r) => r.kind !== 'enter').slice(-80), [feed]);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' }); }, [rows.length]);
  if (!rows.length) return <p className="dl-empty">还没有动静。连上直播间，或者在下面「模拟观众」里发一条试试。</p>;
  return (
    <div className="dl-feed" ref={ref}>
      {rows.map((r) => (
        <div key={r.key} className={`dl-feed-row dl-k-${r.kind}${r.uid && focus.has(r.uid) ? ' dl-focus' : ''}`}>
          <span className="dl-feed-name">{r.kind === 'her' ? '🐳 她' : r.name}</span>
          <span className="dl-feed-text">{r.text}{r.yuan ? <em> ¥{r.yuan}</em> : null}</span>
        </div>
      ))}
    </div>
  );
}

function Simulator() {
  const [name, setName] = useState('测试观众');
  const [text, setText] = useState('');
  const [busy, error, run] = useBusy();
  const send = (kind: string, extra: Record<string, unknown> = {}) => run(() => api('simulate', { kind, name, text, ...extra }).then(() => { if (kind === 'chat' || kind === 'superchat') setText(''); }));
  return (
    <Card title="模拟观众" extra={<span className="dl-meta">不开直播间也能彩排</span>}>
      <div className="dl-row">
        <input className="dl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="观众名" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="弹幕内容" onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) send('chat'); }} />
        <button disabled={busy || !text.trim()} onClick={() => send('chat')}>发弹幕</button>
      </div>
      <div className="dl-chips">
        <button onClick={() => send('enter')}>进场</button>
        <button onClick={() => send('follow')}>关注</button>
        <button onClick={() => send('gift', { gift: '小花花', count: 5, yuan: 0.5 })}>送小花花×5</button>
        <button onClick={() => send('gift', { gift: '情书', count: 1, yuan: 5.2 })}>送情书</button>
        <button disabled={!text.trim()} onClick={() => send('superchat', { yuan: 30 })}>醒目留言 ¥30</button>
        <button onClick={() => send('membership', { guard: 3 })}>上舰</button>
      </div>
      {error && <p className="dl-error">{error}</p>}
    </Card>
  );
}

export const CONSOLE_CSS = `
.dl-room{--dl-cyan:#86dcff;--dl-violet:#b79bff;--dl-text:#e8f1ff;--dl-dim:rgba(220,232,255,.62);--dl-faint:rgba(220,232,255,.38);--dl-line:rgba(255,255,255,.12);
  --dl-mono:"JetBrains Mono","Cascadia Code",Consolas,monospace;
  position:relative;height:100%;overflow:hidden;color:var(--dl-text);
  background:radial-gradient(1100px 600px at 80% -10%,rgba(120,200,255,.16),transparent 60%),radial-gradient(800px 500px at 0% 110%,rgba(150,110,255,.14),transparent 60%),linear-gradient(180deg,#0b1a33,#060e1f)}
.dl-page{height:100%;overflow:auto;padding:26px clamp(20px,3.5vw,48px) 40px;box-sizing:border-box}
.dl-top{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:20px}
.dl-path{font:12px var(--dl-mono);color:var(--dl-faint);letter-spacing:.4px;margin-bottom:6px}
.dl-path b{color:var(--dl-cyan);font-weight:400}
.dl-top h1{display:flex;align-items:center;gap:12px;margin:0;font-size:24px;font-weight:650;letter-spacing:1px}
.dl-onair{font:700 13px var(--dl-mono);letter-spacing:2px;padding:4px 10px;border-radius:999px;color:#fff;background:linear-gradient(90deg,#ff4d6d,#ff7a59);box-shadow:0 0 22px -4px rgba(255,77,109,.8)}
.dl-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:20px}
@media (max-width:1100px){.dl-grid{grid-template-columns:1fr}}
.dl-col{display:flex;flex-direction:column;gap:20px;min-width:0}
.dl-card{border-radius:20px;padding:18px 20px;background:linear-gradient(160deg,rgba(255,255,255,.09),rgba(255,255,255,.03));border:1px solid var(--dl-line);
  backdrop-filter:blur(18px) saturate(150%);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 24px 60px -30px rgba(0,0,0,.8)}
.dl-card>header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.dl-card h2{margin:0;font-size:14px;font-weight:600;letter-spacing:1px;color:var(--dl-text)}
.dl-meta{font:12px var(--dl-mono);color:var(--dl-faint)}
.dl-state{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dl-dim)}
.dl-dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--dl-faint)}
.dl-ok{background:#6ee7a8;box-shadow:0 0 10px #6ee7a8}.dl-warn{background:#ffd36e;box-shadow:0 0 10px #ffd36e}.dl-bad{background:#ff8a8a;box-shadow:0 0 10px #ff8a8a}
.dl-preview{position:relative;aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:#030915;border:1px solid var(--dl-line);margin-bottom:14px}
.dl-preview iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.dl-field{display:flex;flex-direction:column;gap:7px;margin-top:10px;flex:1;min-width:0}
.dl-field label{font-size:12px;color:var(--dl-dim);display:flex;align-items:center;gap:8px}
.dl-row{display:flex;gap:10px;align-items:center}
.dl-pick{align-items:flex-start}
.dl-room input,.dl-room select{flex:1;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid var(--dl-line);background:rgba(4,10,24,.55);color:var(--dl-text);font-size:13px;outline:none}
.dl-room input:focus,.dl-room select:focus{border-color:rgba(134,220,255,.6);box-shadow:0 0 0 3px rgba(134,220,255,.12)}
.dl-room input.dl-name{flex:0 0 120px}
.dl-room button{padding:9px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:var(--dl-text);font-size:13px;cursor:pointer;white-space:nowrap;transition:background .2s,border-color .2s,box-shadow .2s}
.dl-room button:hover:not(:disabled){background:rgba(255,255,255,.12);border-color:rgba(134,220,255,.5)}
.dl-room button:disabled{opacity:.45;cursor:default}
.dl-btn{font-size:14px !important;padding:11px 20px !important;border-radius:12px !important}
.dl-primary{color:#eaf9ff !important;background:rgba(134,220,255,.18) !important;border-color:rgba(134,220,255,.65) !important;box-shadow:0 0 24px -8px rgba(134,220,255,.85),inset 0 1px 0 rgba(255,255,255,.18)}
.dl-danger{color:#ffe6ea !important;background:rgba(255,90,120,.16) !important;border-color:rgba(255,120,140,.6) !important}
.dl-link{background:none !important;border:none !important;color:var(--dl-cyan) !important;padding:6px 0 !important;margin-right:16px}
.dl-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dl-dim);margin:12px 0 4px}
.dl-check input{flex:none}
.dl-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.dl-stats div{padding:12px;border-radius:14px;background:rgba(4,10,24,.45);border:1px solid var(--dl-line);text-align:center}
.dl-stats b{display:block;font-size:22px;font-weight:650}
.dl-stats span{font-size:11px;color:var(--dl-faint)}
.dl-feed-card{min-height:0}
.dl-feed{height:340px;overflow:auto;display:flex;flex-direction:column;gap:6px;padding-right:4px}
.dl-feed-row{display:flex;gap:10px;font-size:13px;line-height:1.5;padding:6px 10px;border-radius:10px;background:rgba(4,10,24,.35)}
.dl-feed-name{flex:none;color:var(--dl-dim);max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-feed-text{min-width:0;word-break:break-word}
.dl-feed-text em{font-style:normal;color:#ffd36e}
.dl-k-her{background:rgba(134,220,255,.10);border:1px solid rgba(134,220,255,.25)}
.dl-k-her .dl-feed-name{color:var(--dl-cyan)}
.dl-k-gift,.dl-k-membership,.dl-k-superchat{background:rgba(255,211,110,.08)}
.dl-k-follow{color:var(--dl-dim)}
.dl-focus{box-shadow:inset 3px 0 0 var(--dl-cyan)}
.dl-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.dl-chips button{font-size:12px;padding:7px 12px;border-radius:999px}
.dl-tag{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dl-line);color:var(--dl-faint)}
.dl-ok-tag{color:#6ee7a8;border-color:rgba(110,231,168,.45)}
.dl-hint{margin:0;font-size:12px;color:var(--dl-faint);line-height:1.6}
.dl-error{margin:6px 0 0;font-size:12px;color:#ffb4b4}
.dl-banner{margin:0 0 14px;padding:10px 14px;border-radius:12px;background:rgba(255,90,120,.1);border:1px solid rgba(255,120,140,.35)}
.dl-empty{margin:8px 0;font-size:13px;color:var(--dl-faint)}
`;

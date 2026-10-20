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
  settings: { roomId: number | null; character: string; template: string; voice: string; stagePort: number; idleAfterSec: number; distillModel: string; ownRooms: number[] };
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

  const brainText = show?.onAir ? (show.brain === 'thinking' && brainDetail ? brainDetail : BRAIN_TEXT[show.brain]) : '没在播';
  const pending = show ? (show.pending.chats ?? 0) + (show.pending.gifts ?? 0) + (show.pending.thanks ?? 0) + (show.pending.superchats ?? 0) : 0;

  return (
    <div className={`dl-room${show?.onAir ? ' dl-live' : ''}`}>
      <div className="dl-page">
        <header className="dl-top">
          <div className="dl-brand">
            <span className="dl-orb"><BroadcastGlyph /></span>
            <div className="dl-brand-text">
              <div className="dl-path">dsh-livestream <b>/ 直播间</b></div>
              <h1>大肥鱼直播{show?.onAir ? <span className="dl-onair"><i />LIVE</span> : <span className="dl-offair">未开播</span>}</h1>
              <div className="dl-pills">
                <span className="dl-pill"><Dot tone={brainTone} />{brainText}</span>
                <span className="dl-pill"><Dot tone={connTone} />{CONN_TEXT[conn] ?? conn}{show?.live.room?.title ? ` · ${show.live.room.title}` : ''}</span>
                <span className="dl-pill"><Dot tone={show?.stageWatchers ? 'ok' : 'idle'} />{show?.stageWatchers ? `OBS 已连上 ${show.stageWatchers} 个` : 'OBS 还没打开舞台'}</span>
              </div>
            </div>
          </div>
          <div className="dl-top-actions">
            {show?.onAir
              ? <button className="dl-btn dl-danger" disabled={busy} onClick={endLive}>下播（先让她道别）</button>
              : <button className="dl-btn dl-primary" disabled={busy} onClick={goLive}><i className="dl-go-dot" />开播</button>}
          </div>
        </header>
        {error && <p className="dl-error dl-banner">{error}</p>}

        <div className="dl-grid">
          <div className="dl-col">
            <Card title="舞台预览" className="dl-preview-card" extra={<span className="dl-meta">和 OBS 里看到的一样 · 静音</span>}>
              <div className="dl-preview">
                {previewUrl && <iframe src={previewUrl} title="舞台预览" />}
                {show?.onAir && <span className="dl-preview-live"><i />直播中</span>}
              </div>
              <div className="dl-field">
                <label>OBS 舞台地址（来源 → 浏览器 → 粘贴，宽 1920 高 1080）</label>
                <div className="dl-row">
                  <input readOnly value={host?.stageUrl ?? ''} onFocus={(e) => e.currentTarget.select()} />
                  <button className={copied ? 'dl-done' : ''} onClick={copyUrl}>{copied ? '已复制' : '复制'}</button>
                </div>
              </div>
              <div className="dl-row dl-pick">
                <div className="dl-field">
                  <label>模板（直播间的皮）</label>
                  <div className="dl-tiles">
                    {host?.templates.map((t) => (
                      <button key={t.id} className={`dl-tile${t.id === settings?.template ? ' dl-on' : ''}`} onClick={() => choose({ template: t.id })}>
                        <b>{t.name}</b><small>{t.builtin ? '自带' : '自定义'}</small>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="dl-field">
                  <label>角色</label>
                  <div className="dl-tiles">
                    {host?.characters.map((c) => (
                      <button key={c.id} className={`dl-tile${c.id === settings?.character ? ' dl-on' : ''}`} onClick={() => choose({ character: c.id })}>
                        <b>{c.name}</b><small>{c.builtin ? '自带' : '自定义'}</small>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </Card>

            <Card title="跟她说话" extra={<span className="dl-meta">观众也会听到她的回答</span>}>
              <div className="dl-row">
                <input value={ownerText} placeholder={show?.onAir ? '比如：给大家讲讲你今天学到的东西' : '开播以后才能跟她说话'} onChange={(e) => setOwnerText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendOwner(); }} />
                <button className="dl-send" disabled={busy || !show?.onAir || !ownerText.trim()} onClick={sendOwner}>说</button>
              </div>
            </Card>

            <Simulator />
          </div>

          <div className="dl-col">
            <Card title="她现在" className="dl-now" extra={<span className="dl-state"><Dot tone={brainTone} />{brainText}</span>}>
              <div className="dl-stats">
                <div><b>{show?.live.stats.online ?? '–'}</b><span>在线</span></div>
                <div><b>{show?.live.perMinute.chat ?? 0}</b><span>弹幕/分</span></div>
                <div><b>{show ? { quiet: '冷清', normal: '一般', busy: '热闹' }[show.heat] ?? show.heat : '–'}</b><span>热度</span></div>
                <div className={pending ? 'dl-hot' : ''}><b>{pending}</b><span>待回应</span></div>
              </div>
              {show?.brainSession && (
                <div className="dl-links">
                  <button className="dl-link" onClick={() => svc?.uiWorkspace.openSession(show.brainSession!)}>打开她直播的会话 →</button>
                  {show.onAir && <button className="dl-link" onClick={() => svc && void cancel(svc, show.brainSession!)}>让她停下这一轮</button>}
                </div>
              )}
            </Card>

            <Card title="直播间" className="dl-feed-card" extra={<span className="dl-meta">她在回的观众会亮起来</span>}>
              <Feed feed={feed} focus={focus} />
            </Card>

            <Card title="连接">
              <div className="dl-field">
                <label>B 站直播间房间号</label>
                <div className="dl-row">
                  <input value={room} inputMode="numeric" placeholder="你的直播间房间号（直播间网址最后那串数字）" onChange={(e) => setRoom(e.target.value.replace(/\D/g, ''))} />
                  {conn === 'idle' || conn === 'error'
                    ? <button disabled={busy || !room} onClick={saveRoom}>连接</button>
                    : <button disabled={busy} onClick={() => run(async () => setHost(await api('disconnect', {})))}>断开</button>}
                </div>
                {settings?.roomId ? (
                  <label className="dl-check"><input type="checkbox" checked={settings.ownRooms.includes(settings.roomId)} onChange={(e) => choose({ ownRoom: e.target.checked })} /> 这是我自己的直播间：记住常来的观众（别人的直播间只旁观，不记）</label>
                ) : null}
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

function BroadcastGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="2.2" />
      <path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6" />
      <path d="M5.2 18.8a9.6 9.6 0 0 1 0-13.6M18.8 5.2a9.6 9.6 0 0 1 0 13.6" />
    </svg>
  );
}

/** 醒目留言按金额分档（和舞台一样的 B 站配色） */
function scTier(yuan: number): string {
  if (yuan >= 2000) return 'red';
  if (yuan >= 1000) return 'orange';
  if (yuan >= 500) return 'pink';
  if (yuan >= 100) return 'yellow';
  if (yuan >= 50) return 'cyan';
  return 'blue';
}

/** 头像底色按名字换 */
function hue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Feed({ feed, focus }: { feed: FeedRow[]; focus: Set<string> }) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => feed.filter((r) => r.kind !== 'enter').slice(-80), [feed]);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' }); }, [rows.length]);
  if (!rows.length) return <p className="dl-empty">还没有动静。连上直播间，或者在左边「模拟观众」里发一条试试。</p>;
  return (
    <div className="dl-feed" ref={ref}>
      {rows.map((r) => {
        const focused = !!r.uid && focus.has(r.uid);
        return (
          <div key={r.key} className={`dl-feed-row dl-k-${r.kind}${focused ? ' dl-focus' : ''}${r.kind === 'superchat' && r.yuan ? ` dl-sc-${scTier(r.yuan)}` : ''}`}>
            {r.kind === 'her'
              ? <span className="dl-feed-avatar dl-her-avatar">🐳</span>
              : <span className="dl-feed-avatar" style={{ '--h': hue(r.name) } as React.CSSProperties}>{[...r.name][0] ?? '?'}</span>}
            <div className="dl-feed-main">
              <span className="dl-feed-name">{r.kind === 'her' ? '她' : r.name}{focused && <em>她在回</em>}{r.yuan ? <b>¥{r.yuan}</b> : null}</span>
              <span className="dl-feed-text">{r.text}</span>
            </div>
          </div>
        );
      })}
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
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="弹幕内容（醒目留言也用这里的字）" onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) send('chat'); }} />
        <button disabled={busy || !text.trim()} onClick={() => send('chat')}>发弹幕</button>
      </div>
      <div className="dl-sim">
        <span>礼物</span>
        <div className="dl-chips">
          <button className="dl-chip-gift" onClick={() => send('gift', { gift: '小花花', count: 5, yuan: 0.5 })}>小花花 ×5</button>
          <button className="dl-chip-gift" onClick={() => send('gift', { gift: '情书', count: 1, yuan: 5.2 })}>情书 ¥5.2</button>
          <button className="dl-chip-gift dl-chip-big" onClick={() => send('gift', { gift: '小电视飞船', count: 1, yuan: 1245 })}>小电视飞船 ¥1245</button>
        </div>
        <span>醒目留言</span>
        <div className="dl-chips">
          {[30, 100, 500, 2000].map((yuan) => (
            <button key={yuan} className={`dl-chip-sc dl-sc-${scTier(yuan)}`} disabled={!text.trim()} title={text.trim() ? '' : '先在上面写留言内容'} onClick={() => send('superchat', { yuan })}>¥{yuan}</button>
          ))}
        </div>
        <span>其他</span>
        <div className="dl-chips">
          <button onClick={() => send('enter')}>进场</button>
          <button onClick={() => send('follow')}>关注</button>
          <button className="dl-chip-guard" onClick={() => send('membership', { guard: 3 })}>上舰</button>
        </div>
      </div>
      {error && <p className="dl-error">{error}</p>}
    </Card>
  );
}

export const CONSOLE_CSS = `
.dl-room{--dl-cyan:#86dcff;--dl-violet:#b79bff;--dl-gold:#ffd36e;--dl-text:#e8f1ff;--dl-dim:rgba(220,232,255,.66);--dl-faint:rgba(220,232,255,.4);--dl-line:rgba(255,255,255,.12);
  --dl-mono:"JetBrains Mono","Cascadia Code",Consolas,monospace;
  position:relative;height:100%;overflow:hidden;color:var(--dl-text);isolation:isolate;
  background:radial-gradient(1100px 600px at 80% -10%,rgba(120,200,255,.18),transparent 60%),radial-gradient(800px 500px at 0% 110%,rgba(150,110,255,.16),transparent 60%),linear-gradient(180deg,#0b1a33,#060e1f)}
/* 背后慢慢晃的一道光（开播时变暖一点） */
.dl-room::before{content:'';position:absolute;left:30%;top:-30%;width:70%;height:90%;z-index:-1;pointer-events:none;opacity:.55;transform-origin:50% 0;
  background:conic-gradient(from 160deg at 50% 0%,transparent 0deg,rgba(150,215,255,.08) 10deg,rgba(190,230,255,.14) 20deg,rgba(150,215,255,.06) 30deg,transparent 40deg);
  filter:blur(14px);animation:dl-ray 14s ease-in-out infinite alternate}
.dl-live::before{background:conic-gradient(from 160deg at 50% 0%,transparent 0deg,rgba(255,140,170,.07) 10deg,rgba(190,230,255,.15) 20deg,rgba(255,170,140,.06) 30deg,transparent 40deg)}
@keyframes dl-ray{from{transform:rotate(-6deg)}to{transform:rotate(6deg)}}
.dl-page{height:100%;overflow:auto;padding:26px clamp(20px,3.5vw,48px) 44px;box-sizing:border-box}

/* 顶栏 */
.dl-top{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:22px}
.dl-brand{display:flex;align-items:center;gap:16px;min-width:0}
.dl-orb{position:relative;flex:none;display:grid;place-items:center;width:52px;height:52px;border-radius:16px;color:#eaf9ff;
  background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.35),rgba(134,220,255,.25) 40%,rgba(120,100,255,.25));border:1px solid rgba(134,220,255,.45);
  box-shadow:0 0 30px -6px rgba(134,220,255,.7),inset 0 1px 0 rgba(255,255,255,.3)}
.dl-live .dl-orb{color:#fff;border-color:rgba(255,140,160,.6);background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.4),rgba(255,90,120,.45) 45%,rgba(255,120,90,.35));box-shadow:0 0 34px -4px rgba(255,77,109,.8),inset 0 1px 0 rgba(255,255,255,.35)}
.dl-live .dl-orb::after{content:'';position:absolute;inset:-1px;border-radius:inherit;border:1px solid rgba(255,120,140,.8);animation:dl-ping 1.8s ease-out infinite}
@keyframes dl-ping{to{transform:scale(1.45);opacity:0}}
.dl-path{font:12px var(--dl-mono);color:var(--dl-faint);letter-spacing:.4px;margin-bottom:4px}
.dl-path b{color:var(--dl-cyan);font-weight:400}
.dl-top h1{display:flex;align-items:center;gap:12px;margin:0;font-size:24px;font-weight:700;letter-spacing:1px}
.dl-onair{display:inline-flex;align-items:center;gap:7px;font:700 12px var(--dl-mono);letter-spacing:2px;padding:4px 11px;border-radius:999px;color:#fff;background:linear-gradient(90deg,#ff3d64,#ff7a59);box-shadow:0 0 22px -4px rgba(255,77,109,.85)}
.dl-onair i{width:7px;height:7px;border-radius:50%;background:#fff;animation:dl-rec 1.6s ease-out infinite}
@keyframes dl-rec{0%{box-shadow:0 0 0 0 rgba(255,255,255,.8)}100%{box-shadow:0 0 0 7px rgba(255,255,255,0)}}
.dl-offair{font:600 12px var(--dl-mono);letter-spacing:1px;padding:3px 10px;border-radius:999px;color:var(--dl-faint);border:1px solid var(--dl-line)}
.dl-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px}
.dl-pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dl-dim);padding:4px 11px;border-radius:999px;background:rgba(4,10,24,.45);border:1px solid var(--dl-line)}
.dl-top-actions{flex:none}

/* 卡片 */
.dl-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:20px}
@media (max-width:1100px){.dl-grid{grid-template-columns:1fr}}
.dl-col{display:flex;flex-direction:column;gap:20px;min-width:0}
.dl-card{position:relative;border-radius:20px;padding:18px 20px 20px;background:linear-gradient(160deg,rgba(255,255,255,.09),rgba(255,255,255,.03));border:1px solid var(--dl-line);
  backdrop-filter:blur(18px) saturate(150%);box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 24px 60px -30px rgba(0,0,0,.85);
  transition:border-color .3s,box-shadow .3s;animation:dl-card-in .5s cubic-bezier(.2,.8,.2,1) both}
.dl-col .dl-card:nth-child(2){animation-delay:.06s}.dl-col .dl-card:nth-child(3){animation-delay:.12s}
@keyframes dl-card-in{from{opacity:0;transform:translateY(12px)}}
.dl-card::before{content:'';position:absolute;left:22px;right:22px;top:-1px;height:1px;background:linear-gradient(90deg,transparent,rgba(134,220,255,.55),transparent);opacity:.7}
.dl-card:hover{border-color:rgba(134,220,255,.22)}
.dl-card>header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.dl-card h2{margin:0;font-size:14px;font-weight:650;letter-spacing:1.5px;color:var(--dl-text);display:flex;align-items:center;gap:9px}
.dl-card h2::before{content:'';width:4px;height:14px;border-radius:2px;background:linear-gradient(180deg,var(--dl-cyan),var(--dl-violet));box-shadow:0 0 10px rgba(134,220,255,.6)}
.dl-meta{font:12px var(--dl-mono);color:var(--dl-faint)}
.dl-state{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dl-dim)}
.dl-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;background:var(--dl-faint)}
.dl-ok{background:#6ee7a8;box-shadow:0 0 10px #6ee7a8}.dl-warn{background:#ffd36e;box-shadow:0 0 10px #ffd36e;animation:dl-blink 1.2s ease-in-out infinite}.dl-bad{background:#ff8a8a;box-shadow:0 0 10px #ff8a8a}
@keyframes dl-blink{50%{opacity:.4}}

/* 舞台预览：浮起来的一块屏 */
.dl-preview{position:relative;aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:#030915;border:1px solid rgba(134,220,255,.25);margin-bottom:6px;
  box-shadow:0 0 0 1px rgba(0,0,0,.4),0 26px 50px -24px rgba(0,0,0,.9),0 0 40px -18px rgba(134,220,255,.6);transition:transform .35s cubic-bezier(.2,.8,.2,1),box-shadow .35s}
.dl-preview:hover{transform:translateY(-3px);box-shadow:0 0 0 1px rgba(0,0,0,.4),0 34px 60px -26px rgba(0,0,0,.9),0 0 50px -14px rgba(134,220,255,.75)}
.dl-preview iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.dl-preview-live{position:absolute;right:10px;bottom:10px;display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:1px;padding:3px 9px;border-radius:999px;color:#fff;background:rgba(255,61,100,.85);box-shadow:0 0 14px rgba(255,77,109,.7);pointer-events:none}
.dl-preview-live i{width:6px;height:6px;border-radius:50%;background:#fff;animation:dl-rec 1.6s ease-out infinite}

/* 表单 */
.dl-field{display:flex;flex-direction:column;gap:7px;margin-top:12px;flex:1;min-width:0}
.dl-field label{font-size:12px;color:var(--dl-dim);display:flex;align-items:center;gap:8px}
.dl-row{display:flex;gap:10px;align-items:center}
.dl-pick{align-items:flex-start;gap:20px}
.dl-room input,.dl-room select{flex:1;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid var(--dl-line);background:rgba(4,10,24,.55);color:var(--dl-text);font-size:13px;outline:none;transition:border-color .2s,box-shadow .2s}
.dl-room input:focus,.dl-room select:focus{border-color:rgba(134,220,255,.6);box-shadow:0 0 0 3px rgba(134,220,255,.12)}
.dl-room input.dl-name{flex:0 0 120px}
.dl-room button{padding:9px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:var(--dl-text);font-size:13px;cursor:pointer;white-space:nowrap;
  transition:background .2s,border-color .2s,box-shadow .2s,transform .15s}
.dl-room button:hover:not(:disabled){background:rgba(255,255,255,.12);border-color:rgba(134,220,255,.5)}
.dl-room button:active:not(:disabled){transform:translateY(1px) scale(.98)}
.dl-room button:disabled{opacity:.42;cursor:default}
.dl-room button.dl-done{color:#6ee7a8;border-color:rgba(110,231,168,.55)}
.dl-room button.dl-send{min-width:56px;color:#eaf9ff;background:rgba(134,220,255,.16);border-color:rgba(134,220,255,.55)}

/* 开播 / 下播 */
.dl-btn{position:relative;display:inline-flex;align-items:center;gap:9px;font-size:15px !important;font-weight:650;letter-spacing:1px;padding:12px 26px !important;border-radius:14px !important}
.dl-primary{color:#04121f !important;background:linear-gradient(100deg,var(--dl-cyan),var(--dl-violet)) !important;border-color:rgba(255,255,255,.4) !important;
  box-shadow:0 0 34px -6px rgba(134,220,255,.9),inset 0 1px 0 rgba(255,255,255,.55)}
.dl-primary:hover:not(:disabled){filter:brightness(1.08);box-shadow:0 0 44px -4px rgba(134,220,255,1),inset 0 1px 0 rgba(255,255,255,.6) !important}
.dl-primary::after{content:'';position:absolute;inset:-1px;border-radius:inherit;border:1px solid rgba(134,220,255,.8);animation:dl-ping 2.4s ease-out infinite;pointer-events:none}
.dl-go-dot{width:9px;height:9px;border-radius:50%;background:#ff3d64;box-shadow:0 0 0 3px rgba(255,255,255,.55)}
.dl-danger{color:#ffe6ea !important;background:rgba(255,90,120,.16) !important;border-color:rgba(255,120,140,.6) !important;box-shadow:0 0 24px -10px rgba(255,90,120,.9)}
.dl-danger:hover:not(:disabled){background:rgba(255,90,120,.26) !important}

/* 模板、角色：点一下就换 */
.dl-tiles{display:flex;flex-wrap:wrap;gap:10px}
.dl-room button.dl-tile{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:120px;padding:10px 16px;border-radius:12px;text-align:left;background:rgba(4,10,24,.45)}
.dl-tile b{font-size:14px;font-weight:600}
.dl-tile small{font-size:11px;color:var(--dl-faint)}
.dl-room button.dl-tile.dl-on{border-color:rgba(134,220,255,.75);background:linear-gradient(160deg,rgba(134,220,255,.2),rgba(183,155,255,.1));box-shadow:0 0 0 1px rgba(134,220,255,.35),0 0 22px -6px rgba(134,220,255,.8)}
.dl-tile.dl-on small{color:var(--dl-cyan)}

/* 她现在 */
.dl-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.dl-stats div{padding:14px 8px 12px;border-radius:14px;background:linear-gradient(180deg,rgba(4,10,24,.35),rgba(4,10,24,.6));border:1px solid var(--dl-line);text-align:center;transition:border-color .3s,box-shadow .3s}
.dl-stats b{display:block;font-size:24px;font-weight:750;font-family:var(--dl-mono);background:linear-gradient(180deg,#fff,#bfe6ff);-webkit-background-clip:text;background-clip:text;color:transparent}
.dl-stats span{font-size:11px;color:var(--dl-faint);letter-spacing:1px}
.dl-stats .dl-hot{border-color:rgba(255,211,110,.5);box-shadow:0 0 20px -8px rgba(255,211,110,.8)}
.dl-stats .dl-hot b{background:linear-gradient(180deg,#fff6d6,var(--dl-gold));-webkit-background-clip:text;background-clip:text}
.dl-links{display:flex;gap:18px;margin-top:12px}
.dl-link{background:none !important;border:none !important;color:var(--dl-cyan) !important;padding:2px 0 !important}
.dl-link:hover{text-shadow:0 0 12px rgba(134,220,255,.8)}
.dl-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dl-dim);margin:12px 0 4px}
.dl-check input{flex:none}

/* 直播间：事件流 */
.dl-feed-card{min-height:0}
.dl-feed{height:360px;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:2px 6px 2px 2px;
  -webkit-mask-image:linear-gradient(180deg,transparent,#000 24px);mask-image:linear-gradient(180deg,transparent,#000 24px)}
.dl-feed::-webkit-scrollbar{width:6px}.dl-feed::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px}
.dl-feed-row{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.5;padding:8px 10px;border-radius:12px;background:rgba(4,10,24,.38);border:1px solid transparent;
  animation:dl-row-in .35s cubic-bezier(.2,.8,.2,1);transition:border-color .3s,box-shadow .3s}
@keyframes dl-row-in{from{opacity:0;transform:translateY(6px)}}
.dl-feed-avatar{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;font-size:13px;font-weight:700;color:rgba(6,16,34,.85);
  background:linear-gradient(135deg,hsl(var(--h,200) 85% 80%),hsl(calc(var(--h,200) + 45) 75% 66%))}
.dl-her-avatar{background:radial-gradient(circle at 35% 30%,#fff,var(--dl-cyan) 55%,#5a7cff);font-size:15px}
.dl-feed-main{display:flex;flex-direction:column;min-width:0;flex:1}
.dl-feed-name{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dl-dim);overflow:hidden;white-space:nowrap}
.dl-feed-name em{font-style:normal;font-size:11px;font-weight:700;padding:0 8px;border-radius:999px;color:#04121f;background:linear-gradient(90deg,var(--dl-cyan),var(--dl-violet))}
.dl-feed-name b{margin-left:auto;color:var(--dl-gold);font-family:var(--dl-mono)}
.dl-feed-text{min-width:0;word-break:break-word;color:var(--dl-text)}
.dl-k-her{flex-direction:row-reverse;text-align:right;margin-left:36px;background:linear-gradient(160deg,rgba(134,220,255,.16),rgba(183,155,255,.08));border-color:rgba(134,220,255,.28)}
.dl-k-her .dl-feed-name{justify-content:flex-end;color:var(--dl-cyan)}
.dl-k-gift,.dl-k-membership{background:linear-gradient(100deg,rgba(255,211,110,.14),rgba(4,10,24,.4));border-color:rgba(255,211,110,.25)}
.dl-k-gift .dl-feed-text,.dl-k-membership .dl-feed-text{color:#ffe7a8}
.dl-k-superchat{--sc:#2a60b8;background:linear-gradient(100deg,color-mix(in srgb,var(--sc) 40%,transparent),rgba(4,10,24,.4));border-color:color-mix(in srgb,var(--sc) 70%,transparent)}
.dl-k-follow{opacity:.8}.dl-k-follow .dl-feed-text{color:#ffb3cf}
.dl-focus{border-color:rgba(134,220,255,.65);box-shadow:0 0 0 1px rgba(134,220,255,.25),0 0 22px -8px rgba(134,220,255,.9)}

/* 模拟观众 */
.dl-sim{display:grid;grid-template-columns:auto 1fr;gap:10px 14px;align-items:center;margin-top:14px}
.dl-sim>span{font-size:12px;color:var(--dl-faint);letter-spacing:1px}
.dl-chips{display:flex;flex-wrap:wrap;gap:8px}
.dl-chips button{font-size:12px !important;padding:6px 13px !important;border-radius:999px !important}
.dl-room .dl-chips .dl-chip-gift{color:#ffe7a8;border-color:rgba(255,211,110,.4);background:rgba(255,211,110,.08)}
.dl-room .dl-chips .dl-chip-big{color:#2a1b02;font-weight:700;border-color:#ffe7a8;background:linear-gradient(90deg,#ffe7a8,#ffb03b);box-shadow:0 0 16px -4px rgba(255,190,80,.8)}
.dl-room .dl-chips .dl-chip-sc{color:#fff;font-weight:700;border-color:color-mix(in srgb,var(--sc) 80%,#fff);background:color-mix(in srgb,var(--sc) 70%,transparent)}
.dl-room .dl-chips .dl-chip-sc:hover:not(:disabled){background:var(--sc);box-shadow:0 0 16px -4px var(--sc)}
.dl-room .dl-chips .dl-chip-guard{color:#dcecff;border-color:rgba(111,180,255,.6);background:linear-gradient(90deg,rgba(61,127,240,.35),rgba(143,123,255,.3))}
.dl-sc-blue{--sc:#2a60b8}.dl-sc-cyan{--sc:#1f9fb1}.dl-sc-yellow{--sc:#c99a1c}.dl-sc-pink{--sc:#d2589a}.dl-sc-orange{--sc:#e07229}.dl-sc-red{--sc:#d0383b}

.dl-tag{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dl-line);color:var(--dl-faint)}
.dl-ok-tag{color:#6ee7a8;border-color:rgba(110,231,168,.45)}
.dl-hint{margin:0;font-size:12px;color:var(--dl-faint);line-height:1.6}
.dl-error{margin:6px 0 0;font-size:12px;color:#ffb4b4}
.dl-banner{margin:0 0 16px;padding:10px 14px;border-radius:12px;background:rgba(255,90,120,.1);border:1px solid rgba(255,120,140,.35)}
.dl-empty{margin:8px 0;font-size:13px;color:var(--dl-faint)}
`;

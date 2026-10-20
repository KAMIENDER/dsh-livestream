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

/** 两个密钥配好没有（开播前准备清单和设置里都用）；保存后 bump 一下大家重新问 */
let secretVersion = 0;
const secretListeners = new Set<() => void>();
function bumpSecrets(): void {
  secretVersion += 1;
  for (const l of secretListeners) l();
}

function useSecrets(): Record<string, boolean | null> {
  const creds = useCredentials();
  const version = useSyncExternalStore((l) => { secretListeners.add(l); return () => secretListeners.delete(l); }, () => secretVersion);
  const [state, setState] = useState<Record<string, boolean | null>>({ cookie: null, tts: null });
  useEffect(() => {
    if (!creds) return;
    const refs = [SECRET_REFS.cookie, SECRET_REFS.tts];
    void creds.describe(refs).then((r) => setState({ cookie: !!r.value?.[SECRET_REFS.cookie]?.configured, tts: !!r.value?.[SECRET_REFS.tts]?.configured })).catch(() => {});
  }, [creds, version]);
  return state;
}

function SecretField({ label, ref_, hint, configured }: { label: string; ref_: string; hint: string; configured: boolean | null }) {
  const [value, setValue] = useState('');
  const [busy, error, run] = useBusy();
  const creds = useCredentials();
  if (!creds) return <div className="dl-field"><label>{label}</label><p className="dl-hint">这个 DSH 没有凭据服务：用环境变量 {ref_} 提供。</p></div>;
  return (
    <div className="dl-field">
      <label>{label} {configured === null ? null : configured ? <span className="dl-tag dl-ok-tag">已配置</span> : <span className="dl-tag">未配置</span>}</label>
      <div className="dl-row">
        <input type="password" value={value} placeholder={configured ? '已保存（重新填写会覆盖）' : hint} onChange={(e) => setValue(e.target.value)} />
        <button disabled={busy || !value.trim()} onClick={() => run(async () => {
          await creds.set(ref_, value.trim());
          setValue('');
          bumpSecrets();
        })}>保存</button>
      </div>
      {error && <p className="dl-error">{error}</p>}
    </div>
  );
}

/** 舞台服务器上的文件（角色插画、模板预览图）：控制台用 OBS 地址里的 token 去取 */
function stageFile(stageUrl: string | undefined, kind: 'characters' | 'templates', id: string, file: string): string {
  if (!stageUrl) return '';
  const url = new URL(stageUrl);
  return `${url.origin}/${kind}/${id}/${encodeURIComponent(file)}?token=${url.searchParams.get('token') ?? ''}`;
}

function Img({ src, className, fallback = null }: { src: string; className: string; fallback?: React.ReactNode }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (!src || broken) return <>{fallback}</>;
  return <img className={className} src={src} alt="" onError={() => setBroken(true)} />;
}

// ── 控制台 ────────────────────────────────────────────

export function Console() {
  const svc = useServices();
  const { status, feed, focus, brainDetail } = useLive();
  const [host, setHost] = useState<HostState | null>(null);
  const [busy, error, run] = useBusy();
  const [room, setRoom] = useState('');
  const [copied, setCopied] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [dock, setDock] = useState<'owner' | 'sim'>('owner');
  const secrets = useSecrets();

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
  const character = settings?.character ?? '';

  // 开播前准备：缺什么一眼看到，点一下打开设置
  const steps = [
    { key: 'tts', done: secrets.tts === true, text: '豆包语音 Key', hint: '她要出声' },
    { key: 'obs', done: !!show?.stageWatchers, text: 'OBS 打开舞台', hint: '复制下面的舞台地址' },
    { key: 'room', done: conn === 'connected', text: '连上直播间', hint: '不连也能用模拟观众彩排' },
    { key: 'cookie', done: secrets.cookie === true, text: 'B 站 Cookie', hint: '看到观众的完整名字' },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className={`dl-room${show?.onAir ? ' dl-live' : ''}`}>
      <div className="dl-page">
        <header className="dl-top">
          <div className="dl-brand">
            <span className="dl-avatar">
              <Img className="dl-avatar-img" src={stageFile(host?.stageUrl, 'characters', character, 'art/portrait.webp')} fallback={<BroadcastGlyph />} />
            </span>
            <div className="dl-brand-text">
              <h1>大肥鱼直播{show?.onAir ? <span className="dl-onair"><i />LIVE</span> : <span className="dl-offair">未开播</span>}</h1>
              <div className="dl-pills">
                <span className="dl-pill"><Dot tone={brainTone} />{brainText}</span>
                <span className="dl-pill"><Dot tone={connTone} />直播间{CONN_TEXT[conn] ?? conn}{show?.live.room?.title ? ` · ${show.live.room.title}` : ''}</span>
                <span className="dl-pill"><Dot tone={show?.stageWatchers ? 'ok' : 'idle'} />{show?.stageWatchers ? `OBS 已连上 ${show.stageWatchers} 个` : 'OBS 还没打开舞台'}</span>
              </div>
            </div>
          </div>
          <div className="dl-top-actions">
            <button className="dl-icon-btn" title="设置" onClick={() => setDrawer(true)}><GearGlyph /><span>设置</span></button>
            {show?.onAir
              ? <button className="dl-btn dl-danger" disabled={busy} onClick={endLive}>下播（先让她道别）</button>
              : <button className="dl-btn dl-primary" disabled={busy} onClick={goLive}><i className="dl-go-dot" />开播</button>}
          </div>
        </header>
        {error && <p className="dl-error dl-banner">{error}</p>}

        {!show?.onAir && doneCount < steps.length && (
          <div className="dl-checklist">
            <b>开播前准备 <em>{doneCount}/{steps.length}</em></b>
            {steps.map((s) => (
              <button key={s.key} className={s.done ? 'dl-step dl-step-done' : 'dl-step'} onClick={() => { if (s.key === 'obs') copyUrl(); else setDrawer(true); }}>
                <i>{s.done ? '✓' : ''}</i><span>{s.text}</span><small>{s.hint}</small>
              </button>
            ))}
          </div>
        )}

        <div className="dl-grid">
          <main className="dl-main">
            <section className="dl-monitor">
              <div className="dl-preview">
                {previewUrl && <iframe src={previewUrl} title="舞台预览" />}
                <span className={`dl-preview-tag${show?.onAir ? ' dl-preview-live' : ''}`}><i />{show?.onAir ? '直播中 · 和 OBS 里一样（静音）' : '预览：开播后的样子 · OBS 里现在是「马上开始」的等待画面'}</span>
              </div>
              <div className="dl-monitor-bar">
                <div className="dl-obs">
                  <span className="dl-label">OBS 浏览器源</span>
                  <code onClick={copyUrl} title="点一下复制">{host?.stageUrl ?? ''}</code>
                  <button className={copied ? 'dl-done' : ''} onClick={copyUrl}>{copied ? '已复制' : '复制'}</button>
                  <span className="dl-meta">1920 × 1080</span>
                </div>
              </div>
              <div className="dl-skins">
                <span className="dl-label">直播间的皮</span>
                <div className="dl-skin-list">
                  {host?.templates.map((t) => (
                    <button key={t.id} className={`dl-skin${t.id === settings?.template ? ' dl-on' : ''}`} onClick={() => choose({ template: t.id })}>
                      <Img className="dl-skin-img" src={stageFile(host.stageUrl, 'templates', t.id, 'preview.jpg')} fallback={<span className="dl-skin-img dl-skin-blank" />} />
                      <b>{t.name}</b>{t.builtin ? null : <small>自定义</small>}
                    </button>
                  ))}
                </div>
                {host && host.characters.length > 1 && (
                  <>
                    <span className="dl-label">角色</span>
                    <div className="dl-chips">
                      {host.characters.map((c) => <button key={c.id} className={c.id === settings?.character ? 'dl-on' : ''} onClick={() => choose({ character: c.id })}>{c.name}</button>)}
                    </div>
                  </>
                )}
              </div>
            </section>

            <section className="dl-dock">
              <nav className="dl-tabs">
                <button className={dock === 'owner' ? 'dl-on' : ''} onClick={() => setDock('owner')}>跟她说话</button>
                <button className={dock === 'sim' ? 'dl-on' : ''} onClick={() => setDock('sim')}>模拟观众</button>
                <span className="dl-meta">{dock === 'owner' ? '观众也会听到她的回答' : '不开直播间也能彩排'}</span>
              </nav>
              {dock === 'owner' ? <OwnerSay onAir={!!show?.onAir} /> : <Simulator />}
            </section>
          </main>

          <aside className="dl-side">
            <div className="dl-side-head">
              <div className="dl-now"><Dot tone={brainTone} /><b>{brainText}</b></div>
              <div className="dl-stats">
                <div><b>{show?.live.stats.online ?? '–'}</b><span>在线</span></div>
                <div><b>{show?.live.perMinute.chat ?? 0}</b><span>弹幕/分</span></div>
                <div><b>{show ? { quiet: '冷清', normal: '一般', busy: '热闹' }[show.heat] ?? show.heat : '–'}</b><span>热度</span></div>
                <div className={pending ? 'dl-hot' : ''}><b>{pending}</b><span>待回应</span></div>
              </div>
            </div>
            <Feed feed={feed} focus={focus} sleep={stageFile(host?.stageUrl, 'characters', character, 'art/sleep.webp')} />
            {show?.brainSession && (
              <div className="dl-links">
                <button className="dl-link" onClick={() => svc?.uiWorkspace.openSession(show.brainSession!)}>打开她直播的会话 →</button>
                {show.onAir && <button className="dl-link" onClick={() => svc && void cancel(svc, show.brainSession!)}>让她停下这一轮</button>}
              </div>
            )}
          </aside>
        </div>
      </div>

      {drawer && (
        <div className="dl-drawer-wrap" onClick={() => setDrawer(false)}>
          <aside className="dl-drawer" onClick={(e) => e.stopPropagation()}>
            <header><h2>设置</h2><button className="dl-icon-btn" onClick={() => setDrawer(false)}>关闭</button></header>
            <h3>直播间</h3>
            <div className="dl-field">
              <label>B 站直播间房间号</label>
              <div className="dl-row">
                <input value={room} inputMode="numeric" placeholder="直播间网址最后那串数字" onChange={(e) => setRoom(e.target.value.replace(/\D/g, ''))} />
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
            <h3>密钥</h3>
            <SecretField label="豆包语音 API Key" ref_={SECRET_REFS.tts} configured={secrets.tts} hint="火山引擎新版控制台的 API Key（和 dsh-game 共用）" />
            <SecretField label="B 站 Cookie" ref_={SECRET_REFS.cookie} configured={secrets.cookie} hint="浏览器里登录 B 站后复制的 Cookie（建议用小号）" />
            <h3>舞台</h3>
            <div className="dl-field">
              <label>OBS 舞台地址（来源 → 浏览器 → 粘贴，宽 1920 高 1080）</label>
              <div className="dl-row">
                <input readOnly value={host?.stageUrl ?? ''} onFocus={(e) => e.currentTarget.select()} />
                <button className={copied ? 'dl-done' : ''} onClick={copyUrl}>{copied ? '已复制' : '复制'}</button>
              </div>
              <p className="dl-hint">想换自己的皮：把插件里 assets/templates/default 复制到 DSH 主目录的 dsh-livestream/templates/&lt;新名字&gt;/，改 template.json 的 id 和 name。</p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function OwnerSay({ onAir }: { onAir: boolean }) {
  const [text, setText] = useState('');
  const [busy, error, run] = useBusy();
  const send = () => run(async () => {
    if (!text.trim()) return;
    await api('owner', { text });
    setText('');
  });
  return (
    <div className="dl-dock-body">
      <div className="dl-row">
        <input value={text} placeholder={onAir ? '比如：给大家讲讲你今天学到的东西' : '开播以后才能跟她说话'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
        <button className="dl-send" disabled={busy || !onAir || !text.trim()} onClick={send}>说</button>
      </div>
      {error && <p className="dl-error">{error}</p>}
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

function GearGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
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

function Feed({ feed, focus, sleep }: { feed: FeedRow[]; focus: Set<string>; sleep: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => feed.filter((r) => r.kind !== 'enter').slice(-80), [feed]);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' }); }, [rows.length]);
  if (!rows.length) {
    return (
      <div className="dl-feed dl-feed-empty">
        <Img className="dl-empty-art" src={sleep} />
        <p>还没有动静。连上直播间，或者在「模拟观众」里发一条试试。</p>
      </div>
    );
  }
  return (
    <div className="dl-feed" ref={ref}>
      {rows.map((r) => {
        const focused = !!r.uid && focus.has(r.uid);
        return (
          <div key={r.key} className={`dl-feed-row dl-k-${r.kind}${focused ? ' dl-focus' : ''}${r.kind === 'superchat' && r.yuan ? ` dl-sc-${scTier(r.yuan)}` : ''}`}>
            {r.kind === 'her'
              ? <span className="dl-feed-avatar dl-her-avatar">鲸</span>
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
    <div className="dl-dock-body">
      <div className="dl-row">
        <input className="dl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="观众名" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="弹幕内容（醒目留言也用这里的字）" onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) send('chat'); }} />
        <button className="dl-send" disabled={busy || !text.trim()} onClick={() => send('chat')}>发弹幕</button>
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
    </div>
  );
}

export const CONSOLE_CSS = `
.dl-room{--dl-blue:#5cb6ff;--dl-pink:#ff8fb6;--dl-gold:#ffc65c;--dl-text:#e9eefb;--dl-dim:rgba(225,232,250,.64);--dl-faint:rgba(225,232,250,.4);
  --dl-line:rgba(255,255,255,.08);--dl-surface:#161b29;--dl-surface-2:#1c2233;--dl-mono:"JetBrains Mono","Cascadia Code",Consolas,monospace;
  position:relative;height:100%;overflow:hidden;color:var(--dl-text);background:#0f131e;
  background-image:radial-gradient(900px 380px at 70% -120px,rgba(92,182,255,.14),transparent 70%),radial-gradient(700px 320px at 0% 0%,rgba(255,143,182,.08),transparent 70%)}
.dl-page{height:100%;overflow:auto;padding:22px clamp(18px,3vw,40px) 32px;box-sizing:border-box;display:flex;flex-direction:column;gap:16px}

/* 顶栏：她是谁、现在怎样、开播 */
.dl-top{display:flex;align-items:center;justify-content:space-between;gap:20px}
.dl-brand{display:flex;align-items:center;gap:16px;min-width:0}
.dl-avatar{position:relative;flex:none;display:grid;place-items:center;width:58px;height:58px;border-radius:50%;overflow:hidden;color:#eaf6ff;
  background:linear-gradient(135deg,#bfe3ff,#ffd3e3);box-shadow:0 0 0 3px #0f131e,0 0 0 5px rgba(92,182,255,.55)}
.dl-avatar-img{width:118%;height:118%;object-fit:cover;object-position:50% 12%}
.dl-live .dl-avatar{box-shadow:0 0 0 3px #0f131e,0 0 0 5px #ff5c7c}
.dl-live .dl-avatar::after{content:'';position:absolute;inset:0;border-radius:50%;box-shadow:0 0 0 2px #ff5c7c;animation:dl-ping 1.8s ease-out infinite}
@keyframes dl-ping{to{transform:scale(1.35);opacity:0}}
.dl-top h1{display:flex;align-items:center;gap:12px;margin:0;font-size:22px;font-weight:750;letter-spacing:1px}
.dl-onair{display:inline-flex;align-items:center;gap:7px;font:700 12px var(--dl-mono);letter-spacing:2px;padding:4px 11px;border-radius:999px;color:#fff;background:#ff4d6d}
.dl-onair i{width:7px;height:7px;border-radius:50%;background:#fff;animation:dl-rec 1.6s ease-out infinite}
@keyframes dl-rec{0%{box-shadow:0 0 0 0 rgba(255,255,255,.8)}100%{box-shadow:0 0 0 7px rgba(255,255,255,0)}}
.dl-offair{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;color:var(--dl-faint);background:var(--dl-surface-2)}
.dl-pills{display:flex;flex-wrap:wrap;gap:14px;margin-top:7px}
.dl-pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dl-dim)}
.dl-top-actions{flex:none;display:flex;align-items:center;gap:10px}
.dl-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;background:var(--dl-faint)}
.dl-ok{background:#5fe0a8}.dl-warn{background:#ffc65c;animation:dl-blink 1.2s ease-in-out infinite}.dl-bad{background:#ff7a8a}
@keyframes dl-blink{50%{opacity:.4}}

/* 按钮、输入框 */
.dl-room input,.dl-room select{flex:1;min-width:0;padding:10px 12px;border-radius:12px;border:1px solid var(--dl-line);background:#0f131e;color:var(--dl-text);font-size:13px;outline:none;transition:border-color .2s,box-shadow .2s}
.dl-room input:focus{border-color:rgba(92,182,255,.6);box-shadow:0 0 0 3px rgba(92,182,255,.14)}
.dl-room input.dl-name{flex:0 0 120px}
.dl-room button{padding:9px 14px;border-radius:12px;border:1px solid var(--dl-line);background:var(--dl-surface-2);color:var(--dl-text);font-size:13px;cursor:pointer;white-space:nowrap;transition:background .2s,border-color .2s,transform .15s}
.dl-room button:hover:not(:disabled){background:#252c41;border-color:rgba(92,182,255,.4)}
.dl-room button:active:not(:disabled){transform:translateY(1px) scale(.98)}
.dl-room button:disabled{opacity:.4;cursor:default}
.dl-room button.dl-done{color:#5fe0a8;border-color:rgba(95,224,168,.5)}
.dl-room button.dl-send{min-width:64px;color:#06121f;font-weight:700;background:var(--dl-blue);border-color:transparent}
.dl-room button.dl-send:hover:not(:disabled){background:#7cc5ff}
.dl-room .dl-icon-btn{display:inline-flex;align-items:center;gap:7px;color:var(--dl-dim);background:transparent}
.dl-btn{display:inline-flex;align-items:center;gap:9px;font-size:15px !important;font-weight:750;letter-spacing:1px;padding:11px 26px !important;border-radius:999px !important}
.dl-room .dl-primary{color:#fff;background:linear-gradient(100deg,#ff6b8f,#ff8fb6);border-color:transparent;box-shadow:0 8px 24px -8px rgba(255,107,143,.8)}
.dl-room .dl-primary:hover:not(:disabled){background:linear-gradient(100deg,#ff7d9c,#ffa0c2);border-color:transparent}
.dl-go-dot{width:9px;height:9px;border-radius:50%;background:#fff;animation:dl-rec 1.6s ease-out infinite}
.dl-room .dl-danger{color:#ffd9e0;background:rgba(255,77,109,.14);border-color:rgba(255,120,140,.45)}

/* 开播前准备 */
.dl-checklist{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:12px 16px;border-radius:16px;background:linear-gradient(100deg,rgba(92,182,255,.1),rgba(255,143,182,.08));border:1px solid rgba(92,182,255,.18)}
.dl-checklist>b{font-size:13px;margin-right:6px}
.dl-checklist>b em{font-style:normal;color:var(--dl-blue);font-family:var(--dl-mono);margin-left:4px}
.dl-room button.dl-step{display:inline-flex;align-items:center;gap:8px;padding:6px 12px 6px 6px;border-radius:999px;background:rgba(15,19,30,.6)}
.dl-step i{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;font-style:normal;font-size:12px;border:1.5px dashed var(--dl-faint)}
.dl-step small{font-size:11px;color:var(--dl-faint)}
.dl-step-done{opacity:.7}
.dl-step-done i{border:0;background:#5fe0a8;color:#08261a;font-weight:800}

/* 主区：左边监视器 + 导播台，右边直播间 */
.dl-grid{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,380px);gap:16px}
@media (max-width:1100px){.dl-grid{grid-template-columns:1fr}.dl-side{min-height:520px}}
.dl-main{display:flex;flex-direction:column;gap:16px;min-width:0}
.dl-label{font-size:12px;color:var(--dl-faint);letter-spacing:1px;white-space:nowrap}
.dl-meta{font-size:12px;color:var(--dl-faint)}

.dl-monitor{border-radius:20px;background:var(--dl-surface);border:1px solid var(--dl-line);overflow:hidden}
.dl-preview{position:relative;aspect-ratio:16/9;background:#05070c}
.dl-preview iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.dl-preview-tag{position:absolute;left:12px;top:12px;display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;color:#fff;background:rgba(10,14,24,.6);backdrop-filter:blur(6px);pointer-events:none}
.dl-preview-tag i{width:6px;height:6px;border-radius:50%;background:var(--dl-faint)}
.dl-preview-live i{background:#ff4d6d;animation:dl-rec 1.6s ease-out infinite}
.dl-monitor-bar{padding:12px 16px;border-top:1px solid var(--dl-line)}
.dl-obs{display:flex;align-items:center;gap:10px;min-width:0}
.dl-obs code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px var(--dl-mono);color:var(--dl-dim);padding:8px 12px;border-radius:10px;background:#0f131e;cursor:pointer}
.dl-skins{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:12px 14px;padding:4px 16px 16px}
.dl-skin-list{display:flex;flex-wrap:wrap;gap:10px}
.dl-room button.dl-skin{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:6px 6px 8px;border-radius:14px;background:#0f131e}
.dl-skin-img{display:block;width:150px;aspect-ratio:16/9;border-radius:9px;object-fit:cover}
.dl-skin-blank{background:linear-gradient(135deg,#2a3350,#3a2f4f)}
.dl-skin b{font-size:12px;font-weight:600;padding:0 4px}
.dl-skin small{font-size:10px;color:var(--dl-faint);padding:0 4px;margin-top:-4px}
.dl-room button.dl-skin.dl-on{border-color:var(--dl-blue);box-shadow:0 0 0 1px var(--dl-blue)}
.dl-skin.dl-on b{color:var(--dl-blue)}

.dl-dock{border-radius:20px;background:var(--dl-surface);border:1px solid var(--dl-line)}
.dl-tabs{display:flex;align-items:center;gap:4px;padding:10px 12px 0}
.dl-room .dl-tabs button{border:0;background:transparent;color:var(--dl-dim);font-weight:600;border-radius:10px 10px 0 0;padding:9px 14px}
.dl-room .dl-tabs button.dl-on{color:var(--dl-text);background:var(--dl-surface-2);box-shadow:inset 0 -2px 0 var(--dl-blue)}
.dl-tabs .dl-meta{margin-left:auto;padding-right:6px}
.dl-dock-body{padding:14px 16px 16px;border-top:1px solid var(--dl-line)}
.dl-row{display:flex;gap:10px;align-items:center}
.dl-sim{display:grid;grid-template-columns:auto 1fr;gap:10px 14px;align-items:center;margin-top:14px}
.dl-sim>span{font-size:12px;color:var(--dl-faint)}
.dl-chips{display:flex;flex-wrap:wrap;gap:8px}
.dl-chips button{font-size:12px !important;padding:6px 13px !important;border-radius:999px !important}
.dl-room .dl-chips button.dl-on{border-color:var(--dl-blue);color:var(--dl-blue)}
.dl-room .dl-chips .dl-chip-gift{color:#ffe1a6;border-color:rgba(255,198,92,.35);background:rgba(255,198,92,.08)}
.dl-room .dl-chips .dl-chip-big{color:#2a1b02;font-weight:700;border-color:transparent;background:linear-gradient(90deg,#ffe1a6,#ffb547)}
.dl-room .dl-chips .dl-chip-sc{color:#fff;font-weight:700;border-color:transparent;background:var(--sc)}
.dl-room .dl-chips .dl-chip-guard{color:#e3f0ff;border-color:transparent;background:linear-gradient(90deg,#3d8bff,#a58bff)}
.dl-sc-blue{--sc:#2a7bd8}.dl-sc-cyan{--sc:#19a8bd}.dl-sc-yellow{--sc:#d39a17}.dl-sc-pink{--sc:#e0609f}.dl-sc-orange{--sc:#ef7a2a}.dl-sc-red{--sc:#e0393f}

/* 右栏：直播间，像观众看到的弹幕栏 */
.dl-side{display:flex;flex-direction:column;min-height:0;border-radius:20px;background:var(--dl-surface);border:1px solid var(--dl-line);overflow:hidden}
.dl-side-head{padding:14px 16px 12px;border-bottom:1px solid var(--dl-line)}
.dl-now{display:flex;align-items:center;gap:9px;font-size:14px}
.dl-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:12px}
.dl-stats div{padding:8px 4px;border-radius:12px;background:#0f131e;text-align:center}
.dl-stats b{display:block;font-size:17px;font-weight:750;font-family:var(--dl-mono)}
.dl-stats span{font-size:10px;color:var(--dl-faint)}
.dl-stats .dl-hot b{color:var(--dl-gold)}
.dl-feed{flex:1;min-height:260px;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:14px 14px 10px}
.dl-feed::-webkit-scrollbar{width:6px}.dl-feed::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:3px}
.dl-feed-empty{align-items:center;justify-content:center;text-align:center}
.dl-feed-empty p{margin:0;font-size:12px;color:var(--dl-faint);max-width:220px;line-height:1.6}
.dl-empty-art{width:150px;opacity:.9}
.dl-feed-row{display:flex;gap:9px;align-items:flex-start;font-size:13px;line-height:1.5;animation:dl-row-in .3s ease-out}
@keyframes dl-row-in{from{opacity:0;transform:translateY(6px)}}
.dl-feed-avatar{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;font-size:12px;font-weight:700;color:#fff;
  background:linear-gradient(135deg,hsl(var(--h,200) 70% 62%),hsl(calc(var(--h,200) + 40) 70% 55%))}
.dl-her-avatar{background:linear-gradient(135deg,var(--dl-blue),var(--dl-pink))}
.dl-feed-main{display:flex;flex-direction:column;align-items:flex-start;min-width:0;flex:1}
.dl-feed-name{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dl-faint);max-width:100%;white-space:nowrap;overflow:hidden}
.dl-feed-name em{font-style:normal;font-size:10px;font-weight:700;padding:0 7px;border-radius:999px;color:#06121f;background:var(--dl-blue)}
.dl-feed-name b{color:var(--dl-gold);font-family:var(--dl-mono)}
.dl-feed-text{max-width:100%;box-sizing:border-box;padding:6px 11px;border-radius:4px 14px 14px 14px;background:var(--dl-surface-2);word-break:break-word}
.dl-k-her{flex-direction:row-reverse}
.dl-k-her .dl-feed-main{align-items:flex-end}
.dl-k-her .dl-feed-text{border-radius:14px 4px 14px 14px;color:#06121f;background:linear-gradient(120deg,#9fd5ff,#ffc4da)}
.dl-k-gift .dl-feed-text,.dl-k-membership .dl-feed-text{color:#ffe1a6;background:rgba(255,198,92,.12)}
.dl-k-superchat .dl-feed-text{color:#fff;background:var(--sc,#2a7bd8)}
.dl-k-follow .dl-feed-text{color:#ffc4da;background:rgba(255,143,182,.1)}
.dl-focus .dl-feed-text{box-shadow:0 0 0 2px var(--dl-blue)}
.dl-links{display:flex;gap:16px;padding:10px 16px 14px;border-top:1px solid var(--dl-line)}
.dl-room .dl-link{background:none;border:none;color:var(--dl-blue);padding:2px 0;font-size:12px}

/* 设置抽屉 */
.dl-drawer-wrap{position:absolute;inset:0;z-index:20;background:rgba(5,8,14,.5);backdrop-filter:blur(2px);animation:dl-fade .2s ease-out}
@keyframes dl-fade{from{opacity:0}}
.dl-drawer{position:absolute;top:0;right:0;bottom:0;width:min(440px,92%);overflow:auto;box-sizing:border-box;padding:20px 22px 30px;background:#141927;border-left:1px solid var(--dl-line);box-shadow:-20px 0 50px -20px rgba(0,0,0,.6);animation:dl-slide .25s cubic-bezier(.2,.8,.2,1)}
@keyframes dl-slide{from{transform:translateX(40px);opacity:0}}
.dl-drawer>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.dl-drawer h2{margin:0;font-size:17px}
.dl-drawer h3{margin:22px 0 4px;font-size:12px;font-weight:600;color:var(--dl-faint);letter-spacing:1px}
.dl-field{display:flex;flex-direction:column;gap:7px;margin-top:10px;min-width:0}
.dl-field label{font-size:12px;color:var(--dl-dim);display:flex;align-items:center;gap:8px}
.dl-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dl-dim);margin:8px 0 2px}
.dl-check input{flex:none}
.dl-tag{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dl-line);color:var(--dl-faint)}
.dl-ok-tag{color:#5fe0a8;border-color:rgba(95,224,168,.45)}
.dl-hint{margin:0;font-size:12px;color:var(--dl-faint);line-height:1.6}
.dl-error{margin:6px 0 0;font-size:12px;color:#ffb4b4}
.dl-banner{margin:0;padding:10px 14px;border-radius:12px;background:rgba(255,90,120,.1);border:1px solid rgba(255,120,140,.35)}
`;

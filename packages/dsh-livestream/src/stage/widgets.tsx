/**
 * 舞台挂件：每个只管一件事，只读 store 里的状态。样式类名（ls-*）和 CSS 变量就是模板能改的全部，
 * 模板的 style.css 可以盖掉这里的任何一条（见 stage/stage.css）。
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CharacterManifest, StageUser } from './protocol';
import { assetUrl, dropAlert, getState, subscribe, type Alert, type StageState } from './store';

export function useStage(): StageState {
  return useSyncExternalStore(subscribe, getState);
}

// ── 角色 ─────────────────────────────────────────────

export function Character() {
  const { character } = useStage();
  if (!character) return null;
  if (character.renderer === 'clips' && character.clips) return <ClipCharacter character={character} />;
  if (character.renderer === 'image' && character.image) return <ImageCharacter character={character} />;
  return null;
}

/**
 * 动画片段渲染器：待机循环；说话时换「说话」循环；带表情的话先播 out → 表情 → in 再接说话。
 * 队列里最后一个循环播，前面的播完一个出队一个。
 */
function ClipCharacter({ character }: { character: CharacterManifest }) {
  const clips = character.clips!;
  const { line } = useStage();
  const [queue, setQueue] = useState<string[]>([clips.idle]);
  const lineId = line?.id ?? null;

  useEffect(() => {
    if (!line) {
      // 说完了：说话循环换回待机（表情片段还在播就让它播完再接上）
      setQueue((q) => q.map((n) => (n === clips.talk ? clips.idle : n)));
      return;
    }
    const reaction = clips.moods[line.mood];
    setQueue(reaction
      ? [...(clips.out ? [clips.out] : []), reaction, ...(clips.in ? [clips.in] : []), clips.talk]
      : [clips.talk]);
  }, [lineId]);

  const next = () => setQueue((q) => (q.length > 1 ? q.slice(1) : q));
  const [w, h] = clips.size;
  return (
    <div className="ls-character" style={{ aspectRatio: `${w} / ${h}` }}>
      <ClipPlayer src={(name) => assetUrl('characters', character.id, name)} name={queue[0]} loop={queue.length <= 1} onEnded={next} names={allClips(character)} />
    </div>
  );
}

function allClips(c: CharacterManifest): string[] {
  const clips = c.clips!;
  return [clips.idle, clips.talk, clips.out, clips.in, ...Object.values(clips.moods)].filter((n): n is string => !!n);
}

/** 片段先整段下载进内存，切换表情时不再等网络 */
const blobs = new Map<string, string>();
async function preload(urls: string[]): Promise<void> {
  for (const url of urls) {
    if (blobs.has(url)) continue;
    try {
      const res = await fetch(url);
      if (res.ok) blobs.set(url, URL.createObjectURL(await res.blob()));
    } catch {
      // 用到时走网络
    }
  }
}

/**
 * 两个 <video> 轮流当前台：下一段先在后台开播，真的画出第一帧才换上来，新的淡入 90 毫秒、旧的垫在下面——
 * 不会有一帧空白（照 dsh-game 的大肥鱼）。
 */
function ClipPlayer({ src, name, loop, onEnded, names }: { src: (name: string) => string; name: string; loop: boolean; onEnded: () => void; names: string[] }) {
  const refs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const [front, setFront] = useState(0);
  const [prev, setPrev] = useState<number | null>(null);
  const shown = useRef<string | null>(null);
  const frontRef = useRef(0);
  const url = (n: string) => blobs.get(src(n)) ?? src(n);

  useEffect(() => { void preload(names.map(src)); }, [names.join('|')]);

  useEffect(() => {
    const videos = refs.map((r) => r.current!);
    const current = videos[frontRef.current];
    if (shown.current === null || shown.current === name) {
      if (shown.current === null) {
        shown.current = name;
        current.src = url(name);
        current.play().catch(() => {});
      }
      current.loop = loop;
      return;
    }
    const nextIndex = 1 - frontRef.current;
    const back = videos[nextIndex];
    let cancelled = false;
    back.src = url(name);
    back.loop = loop;
    const reveal = () => {
      if (cancelled) return;
      shown.current = name;
      setPrev(frontRef.current);
      frontRef.current = nextIndex;
      setFront(nextIndex);
    };
    const fallback = setTimeout(reveal, 250);
    back.play().then(() => {
      if ('requestVideoFrameCallback' in back) back.requestVideoFrameCallback(() => { clearTimeout(fallback); reveal(); });
      else { clearTimeout(fallback); reveal(); }
    }).catch(() => { clearTimeout(fallback); reveal(); });
    return () => { cancelled = true; clearTimeout(fallback); };
  }, [name, loop]);

  useEffect(() => {
    if (prev === null) return;
    const timer = setTimeout(() => { refs[prev].current?.pause(); setPrev(null); }, 150);
    return () => clearTimeout(timer);
  }, [prev]);

  return (
    <div className="ls-clips">
      {refs.map((ref, i) => (
        <video key={i} ref={ref} muted playsInline
          data-role={i === front ? 'front' : i === prev ? 'prev' : undefined}
          onEnded={() => { if (i === frontRef.current) onEnded(); }} />
      ))}
    </div>
  );
}

/** 立绘渲染器：一张图，说话时轻轻弹跳；有表情差分就换图 */
function ImageCharacter({ character }: { character: CharacterManifest }) {
  const image = character.image!;
  const { line } = useStage();
  const file = (line && image.moods?.[line.mood]) || image.idle;
  const [w, h] = image.size;
  return (
    <div className="ls-character" style={{ aspectRatio: `${w} / ${h}` }}>
      <img className={`ls-image${line ? ' ls-talking' : ''}`} src={assetUrl('characters', character.id, file)} alt="" />
    </div>
  );
}

// ── 字幕 ─────────────────────────────────────────────

/** 她正在说的话：念到哪亮到哪 */
export function Subtitle() {
  const { line, character } = useStage();
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!line) return;
    let frame = 0;
    const tick = () => {
      setProgress(Math.min(1, (Date.now() - line.startedAt) / Math.max(1, line.durationMs)));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [line?.id, line?.durationMs]);
  if (!line) return <div className="ls-subtitle ls-empty" />;
  const chars = [...line.text];
  const lit = Math.round(chars.length * progress);
  return (
    <div className="ls-subtitle" key={line.id}>
      <span className="ls-speaker">{character?.name ?? ''}</span>
      <p><span className="ls-lit">{chars.slice(0, lit).join('')}</span><span className="ls-dim">{chars.slice(lit).join('')}</span></p>
    </div>
  );
}

// ── 弹幕 ─────────────────────────────────────────────

const GUARD = ['', '总督', '提督', '舰长'];

function Badge({ user }: { user: StageUser }) {
  return (
    <>
      {user.guard ? <span className={`ls-badge ls-guard-${user.guard}`}>{GUARD[user.guard]}</span> : null}
      {user.medal ? <span className="ls-badge ls-medal">{user.medal.name}<b>{user.medal.level}</b></span> : null}
      {user.admin ? <span className="ls-badge ls-admin">房管</span> : null}
    </>
  );
}

function Avatar({ user }: { user: StageUser }) {
  const [broken, setBroken] = useState(false);
  if (!user.face || broken) return <span className="ls-avatar ls-avatar-letter">{[...user.name][0] ?? '?'}</span>;
  return <img className="ls-avatar" src={user.face} referrerPolicy="no-referrer" alt="" onError={() => setBroken(true)} />;
}

export function Chat({ options }: { options?: Record<string, unknown> }) {
  const { chats, focus } = useStage();
  const limit = Number(options?.rows ?? 12);
  const rows = chats.slice(-limit);
  return (
    <div className="ls-chat">
      {rows.map((row) => {
        const focused = focus.has(row.event.user.id);
        return (
          <div key={row.id} className={`ls-chat-row${focused ? ' ls-focused' : ''}`}>
            <Avatar user={row.event.user} />
            <div className="ls-chat-body">
              <div className="ls-chat-name"><Badge user={row.event.user} /><span>{row.event.user.name}</span>{focused && <em className="ls-replying">正在回你</em>}</div>
              {row.event.sticker ? <img className="ls-sticker" src={row.event.sticker} referrerPolicy="no-referrer" alt={row.event.text} /> : <div className="ls-chat-text">{row.event.text}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 礼物、醒目留言、上舰、进场 ─────────────────────────

/** 醒目留言按金额分档（B 站的配色） */
function scTier(yuan: number): string {
  if (yuan >= 2000) return 'red';
  if (yuan >= 1000) return 'orange';
  if (yuan >= 500) return 'pink';
  if (yuan >= 100) return 'yellow';
  if (yuan >= 50) return 'cyan';
  return 'blue';
}

function AlertCard({ alert }: { alert: Alert }) {
  const e = alert.event;
  const ttl = e.kind === 'superchat' ? 12_000 : e.kind === 'enter' ? 3_500 : 6_000;
  useEffect(() => {
    const timer = setTimeout(() => dropAlert(alert.key), ttl);
    return () => clearTimeout(timer);
  }, [alert.key]);
  switch (e.kind) {
    case 'superchat':
      return (
        <div className={`ls-alert ls-sc ls-sc-${scTier(e.yuan)}`}>
          <div className="ls-sc-head"><Avatar user={e.user} /><span>{e.user.name}</span><b>¥{e.yuan}</b></div>
          <div className="ls-sc-text">{e.text}</div>
        </div>
      );
    case 'gift':
      return <div className={`ls-alert ls-gift${e.yuan >= 5 ? ' ls-big' : ''}`}><Avatar user={e.user} /><span><b>{e.user.name}</b> 送出 {e.gift}</span><em>×{e.count}</em></div>;
    case 'membership':
      return <div className="ls-alert ls-guard ls-big"><Avatar user={e.user} /><span><b>{e.user.name}</b> 开通了{e.level}</span></div>;
    case 'follow':
      return <div className="ls-alert ls-follow"><Avatar user={e.user} /><span><b>{e.user.name}</b> 关注了直播间</span></div>;
    case 'enter':
      return <div className="ls-alert ls-enter"><span><b>{e.user.name}</b> 进入直播间</span></div>;
  }
}

export function Alerts({ options }: { options?: Record<string, unknown> }) {
  const { alerts } = useStage();
  // 进场太多：只显示最近一条
  const shown = useMemo(() => {
    const enters = alerts.filter((a) => a.event.kind === 'enter');
    const rest = alerts.filter((a) => a.event.kind !== 'enter');
    return [...rest, ...enters.slice(-1)].slice(-Number(options?.max ?? 4));
  }, [alerts]);
  return <div className="ls-alerts">{shown.map((a) => <AlertCard key={a.key} alert={a} />)}</div>;
}

// ── 状态 ─────────────────────────────────────────────

const BRAIN_TEXT = { off: '', listening: '在听弹幕', thinking: '正在想…', speaking: '在说话', away: '暂时走开了' } as const;

export function Status() {
  const { brain, brainDetail, online, onAir, character, connected } = useStage();
  return (
    <div className={`ls-status ls-brain-${brain}`}>
      <span className={`ls-live${onAir ? ' ls-on' : ''}`}>{onAir ? 'LIVE' : '准备中'}</span>
      {online !== undefined && <span className="ls-online">{online} 人在看</span>}
      {brain !== 'off' && <span className="ls-brain"><i />{character?.name ?? ''}{brain === 'thinking' && brainDetail ? brainDetail : BRAIN_TEXT[brain]}</span>}
      {!connected && <span className="ls-offline">舞台没连上</span>}
    </div>
  );
}

export function AiLabel({ options }: { options?: Record<string, unknown> }) {
  return <div className="ls-ai-label">{String(options?.text ?? 'AI 主播 · 内容由人工智能生成')}</div>;
}

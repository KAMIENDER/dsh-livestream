/**
 * 舞台挂件：每个只管一件事，只读 store 里的状态。样式类名（ls-*）和 CSS 变量就是模板能改的全部，
 * 模板的 style.css 可以盖掉这里的任何一条（见 stage/stage.css）。
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CharacterManifest, StageLiveEvent, StageUser } from './protocol';
import { assetUrl, dropAlert, getState, litChars, preview, subscribe, type Alert, type ReplyItem, type StageState } from './store';

export function useStage(): StageState {
  return useSyncExternalStore(subscribe, getState);
}

/** 值变成空以后再留 ms 毫秒（给退场动画）：返回 [还显示的值, 是不是在退场] */
function useLinger<T>(value: T | null, ms: number): [T | null, boolean] {
  const [kept, setKept] = useState<T | null>(value);
  useEffect(() => {
    if (value !== null) { setKept(value); return; }
    const timer = setTimeout(() => setKept(null), ms);
    return () => clearTimeout(timer);
  }, [value]);
  return value !== null ? [value, false] : [kept, kept !== null];
}

/** 角色包里的小插画（character.json 的 art）：没有返回 null，挂件就不画 */
function useArt(name: string): string | null {
  const { character } = useStage();
  const file = character?.art?.[name];
  return character && file ? assetUrl('characters', character.id, file) : null;
}

/** 角色的小插画：图片，或者带透明通道的循环动图（.webm）；文件缺了就不画（不出现破图标） */
function ArtImg({ src, className }: { src: string; className: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  if (/\.(webm|mp4)\?/.test(src)) return <video className={`${className} ls-anim`} src={src} autoPlay loop muted playsInline onError={() => setBroken(true)} />;
  return <img className={className} src={src} alt="" onError={() => setBroken(true)} />;
}

/** 角色身后的光和脚下的光圈：说话时亮起来，颜色跟表情走（data-mood） */
function Halo() {
  return (
    <>
      <div className="ls-aura" />
      <div className="ls-pedestal"><i /><i /><i /></div>
    </>
  );
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
    <div className={`ls-character${line ? ' ls-speaking' : ''}`} data-mood={line?.mood || undefined} style={{ aspectRatio: `${w} / ${h}` }}>
      <Halo />
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
    // 只换一次：play() 慢过 250 毫秒时兜底的定时器先换上来，之后真出帧的回调再来一次的话，
    // 会把「上一个」记成自己、150 毫秒后把正在前台的这段暂停（角色定住或消失）
    let revealed = false;
    const reveal = () => {
      if (cancelled || revealed) return;
      revealed = true;
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
    <div className={`ls-character${line ? ' ls-speaking' : ''}`} data-mood={line?.mood || undefined} style={{ aspectRatio: `${w} / ${h}` }}>
      <Halo />
      <img className={`ls-image${line ? ' ls-talking' : ''}`} src={assetUrl('characters', character.id, file)} alt="" />
    </div>
  );
}

// ── 小图标 ───────────────────────────────────────────

const svg = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

function GiftIcon() {
  return <svg {...svg}><rect x="3.5" y="9" width="17" height="11.5" rx="2" /><path d="M2.5 9h19M12 9v11.5M12 9c-1.6-3.4-5.8-4.6-6.4-2.2C5 9 9.4 9 12 9Zm0 0c1.6-3.4 5.8-4.6 6.4-2.2C19 9 14.6 9 12 9Z" /></svg>;
}

function ShipIcon() {
  return <svg {...svg}><path d="M12 2.5v9M12 3.5l5.5 6H12" /><path d="M3 14h18l-2.6 4.6a3 3 0 0 1-2.6 1.4H8.2a3 3 0 0 1-2.6-1.4Z" /><path d="M2 22.5c1.7 0 1.7-1 3.3-1s1.7 1 3.4 1 1.7-1 3.3-1 1.7 1 3.4 1 1.6-1 3.3-1 1.6 1 3.3 1" /></svg>;
}

function HeartIcon() {
  return <svg {...svg}><path d="M12 20.5s-8-4.7-8-10.6A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8 2.9c0 5.9-8 10.6-8 10.6Z" /></svg>;
}

function EyeIcon() {
  return <svg {...svg}><path d="M1.8 12S5.5 5 12 5s10.2 7 10.2 7-3.7 7-10.2 7S1.8 12 1.8 12Z" /><circle cx="12" cy="12" r="3" /></svg>;
}

/** 声波：说话时跳的几根竖条（字幕名牌、「她在回」、弹幕上的「正在回你」都用它） */
function Voice() {
  return <i className="ls-voice"><b /><b /><b /><b /></i>;
}

/** 爆开的小光点 */
function Sparks({ n = 12 }: { n?: number }) {
  return <i className="ls-sparks">{Array.from({ length: n }, (_, i) => <b key={i} style={{ '--i': i, '--n': n } as React.CSSProperties} />)}</i>;
}

// ── 字幕 ─────────────────────────────────────────────

/** 她正在说的话：念到哪亮到哪（按豆包给的逐字时间和音频的真实播放位置，不按字数估）；说完留一会儿再淡出 */
/** 字幕每句换一种颜色（模板用 --ls-sub-1 … --ls-sub-5 改） */
const SUB_COLORS = 5;
/** 名牌旁边跟着表情冒的小符号 */
const MOOD_MARK: Record<string, string> = { laugh: '♪', shy: '♡', angry: '!!', sad: '…', scared: '!?', shocked: '!', think: '?' };

function hashOf(text: string): number {
  let h = 0;
  for (const c of text) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** 要强调的字：她点到的观众名、数字 */
function emphasis(chars: string[], names: string[]): Set<number> {
  const marks = new Set<number>();
  const text = chars.join('');
  for (const name of names) {
    if ([...name].length < 2) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(name, from);
      if (at < 0) break;
      const start = [...text.slice(0, at)].length;
      for (let i = 0; i < [...name].length; i++) marks.add(start + i);
      from = at + name.length;
    }
  }
  chars.forEach((c, i) => { if (/[0-9０-９]/.test(c)) marks.add(i); });
  return marks;
}

const STRONG_BREAK = /[。！？!?～~…]/;
const SOFT_BREAK = /[，、,；;：:）)」』]/;

/**
 * 把一句话分成几页显示（每页最多 max 个字，大约两行）：优先在句号、感叹号处断，其次逗号，实在没有就硬断。
 * 只是显示上的分页，逐字时间不变：念到下一页的第一个字就翻页，字号就可以大一些
 */
function paginate(chars: string[], max: number): Array<[number, number]> {
  const pages: Array<[number, number]> = [];
  let start = 0;
  while (start < chars.length) {
    if (chars.length - start <= max) { pages.push([start, chars.length]); break; }
    let cut = -1;
    for (const mark of [STRONG_BREAK, SOFT_BREAK]) {
      for (let i = start + max - 1; i >= start + Math.floor(max * 0.35); i--) {
        if (mark.test(chars[i])) { cut = i + 1; break; }
      }
      if (cut > 0) break;
    }
    if (cut < 0) cut = start + max;
    // 标点别落到下一页开头
    while (cut < chars.length && SOFT_BREAK.test(chars[cut]) || cut < chars.length && STRONG_BREAK.test(chars[cut])) cut += 1;
    pages.push([start, cut]);
    start = cut;
  }
  return pages;
}

export function Subtitle({ options }: { options?: Record<string, unknown> }) {
  const { line, character, reply } = useStage();
  const [shown, ended] = useLinger(line, 2600);
  const chars = useMemo(() => [...(shown?.text ?? '')], [shown?.text]);
  const [lit, setLit] = useState({ id: '', n: 0 });
  useEffect(() => {
    if (!line) return;
    let frame = 0;
    const tick = () => {
      const n = litChars(line, chars.length);
      setLit((l) => (l.id === line.id && l.n === n ? l : { id: line.id, n }));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [line?.id, line?.durationMs]);
  if (!shown) return <div className="ls-subtitle ls-empty" />;
  const upTo = ended ? chars.length : lit.id === shown.id ? lit.n : 0;
  // 她在回谁：像聊天软件的「回复」一样引用在字幕上方（options.quote: false 关掉，改用 reply 挂件）
  const quoted = options?.quote !== false && !ended ? reply[0] : undefined;
  const marks = emphasis(chars, reply.map((r) => r.event.user.name));
  const pages = paginate(chars, Number(options?.pageChars ?? 24));
  const at = Math.max(0, Math.min(chars.length, upTo) - 1);
  const page = Math.max(0, pages.findIndex(([a, b]) => at >= a && at < b));
  const [from, to] = pages[page] ?? [0, chars.length];
  const color = `var(--ls-sub-${(hashOf(shown.id) % SUB_COLORS) + 1})`;
  const mark = MOOD_MARK[shown.mood];
  return (
    <div className={`ls-subtitle${ended ? ' ls-ended' : ''}${quoted ? ' ls-quoting' : ''}`} key={shown.id} data-mood={shown.mood || undefined} style={{ '--ls-sub': color } as React.CSSProperties}>
      <span className="ls-speaker">{!ended && <Voice />}{character?.name ?? ''}{mark && <i className="ls-mood-mark">{mark}</i>}</span>
      {quoted && (
        <div className="ls-quote" key={quoted.key}>
          <Avatar user={quoted.event.user} />
          <b>{quoted.event.user.name}{reply.length > 1 ? ` 等 ${reply.length} 人` : ''}</b>
          <span>{eventText(quoted.event)}</span>
        </div>
      )}
      {/* 念到的字一个个弹出来（还没念到的占着位置、不显示，气泡不会跟着变大） */}
      <p key={page}>{chars.slice(from, to).map((c, j) => {
        const i = from + j;
        return <span key={i} className={`${i < upTo ? 'ls-lit' : 'ls-dim'}${marks.has(i) ? ' ls-em' : ''}`} style={{ '--r': `${((hashOf(`${shown.id}${i}`) % 7) - 3) * 0.8}deg` } as React.CSSProperties}>{c}</span>;
      })}</p>
      {pages.length > 1 && <i className="ls-pages">{pages.map((_, k) => <b key={k} className={k === page ? 'ls-on' : undefined} />)}</i>}
    </div>
  );
}

// ── 弹幕 ─────────────────────────────────────────────

const GUARD = ['', '总督', '提督', '舰长'];

/** 粉丝牌按等级换色（照 B 站：越高越暖） */
function medalTier(level: number): number {
  return Math.min(6, Math.max(1, Math.ceil(level / 4)));
}

function Badge({ user }: { user: StageUser }) {
  return (
    <>
      {user.guard ? <span className={`ls-badge ls-guard-${user.guard}`}>{GUARD[user.guard]}</span> : null}
      {user.medal ? <span className={`ls-badge ls-medal ls-medal-t${medalTier(user.medal.level)}`}><span>{user.medal.name}</span><b>{user.medal.level}</b></span> : null}
      {user.admin ? <span className="ls-badge ls-admin">房管</span> : null}
    </>
  );
}

/** 没头像时用名字的第一个字，底色按名字换（一屏同一个颜色太单调） */
function hue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Avatar({ user }: { user: StageUser }) {
  const [broken, setBroken] = useState(false);
  const guard = user.guard ? { 'data-guard': user.guard } : {};
  if (!user.face || broken) return <span className="ls-avatar ls-avatar-letter" {...guard} style={{ '--ls-hue': hue(user.name) } as React.CSSProperties}>{[...user.name][0] ?? '?'}</span>;
  return <img className="ls-avatar" {...guard} src={user.face} referrerPolicy="no-referrer" alt="" onError={() => setBroken(true)} />;
}

export function Chat({ options }: { options?: Record<string, unknown> }) {
  const { chats, focus } = useStage();
  const limit = Number(options?.rows ?? 12);
  const rows = chats.slice(-limit);
  const title = options?.title === undefined ? '弹幕' : options.title;
  return (
    <div className="ls-chat">
      {title !== false && <div className="ls-chat-head"><span>{String(title)}</span></div>}
      <div className="ls-chat-list">
        {rows.map((row) => {
          const { user } = row.event;
          const focused = focus.has(user.id);
          return (
            <div key={row.id} className={`ls-chat-row${focused ? ' ls-focused' : ''}${user.guard ? ` ls-row-guard ls-row-guard-${user.guard}` : ''}`}>
              <Avatar user={user} />
              <div className="ls-chat-body">
                <div className="ls-chat-name"><Badge user={user} /><span className="ls-name">{user.name}</span>{focused && <em className="ls-replying"><Voice />正在回你</em>}</div>
                {row.event.sticker ? <img className="ls-sticker" src={row.event.sticker} referrerPolicy="no-referrer" alt={row.event.text} /> : <div className="ls-chat-text">{row.event.text}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 她在回 ───────────────────────────────────────────

/** 一件事用一句话说（「她在回」卡片里） */
function eventText(e: StageLiveEvent): string {
  switch (e.kind) {
    case 'chat': case 'superchat': return e.text;
    case 'gift': return `送出 ${e.gift} ×${e.count}`;
    case 'membership': return `开通了${e.level}`;
    case 'follow': return '关注了直播间';
    case 'enter': return '进入直播间';
  }
}

function ReplyCard({ item, i }: { item: ReplyItem; i: number }) {
  const e = item.event;
  const said = e.kind === 'chat' || e.kind === 'superchat';
  return (
    <div className={`ls-reply-card ls-reply-${e.kind}${e.kind === 'superchat' ? ` ls-sc-${scTier(e.yuan)}` : ''}`} style={{ '--i': i } as React.CSSProperties}>
      <Avatar user={e.user} />
      <div className="ls-reply-body">
        <div className="ls-reply-name"><Badge user={e.user} /><span className="ls-name">{e.user.name}</span>{e.kind === 'superchat' && <b className="ls-reply-price">¥{e.yuan}</b>}</div>
        {e.kind === 'chat' && e.sticker
          ? <img className="ls-sticker" src={e.sticker} referrerPolicy="no-referrer" alt={e.text} />
          : <p className={said ? undefined : 'ls-reply-act'}>{eventText(e)}</p>}
      </div>
    </div>
  );
}

/** 她正在回应的那几位观众和他们说的话：热闹的时候那条弹幕早滚出弹幕列表了 */
export function Reply({ options }: { options?: Record<string, unknown> }) {
  const { reply, replySeq, character } = useStage();
  const current = useMemo(() => (reply.length ? { items: reply, seq: replySeq } : null), [reply, replySeq]);
  const [shown, leaving] = useLinger(current, 450);
  if (!shown) return null;
  const items = shown.items.slice(-Number(options?.max ?? 3));
  return (
    <div className={`ls-reply${leaving ? ' ls-leaving' : ''}`} key={shown.seq}>
      <div className="ls-reply-tag"><Voice />{character?.name ?? '她'}在回</div>
      {items.map((item, i) => <ReplyCard key={item.key} item={item} i={i} />)}
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

/** 礼物按价钱分三档：小（一行带过）、大（金边、光点）、超大（再加光芒） */
function giftSize(yuan: number): 'small' | 'big' | 'huge' {
  return yuan >= 100 ? 'huge' : yuan >= 5 ? 'big' : 'small';
}

/** 总督 1、提督 2、舰长 3（和 StageUser.guard 一样） */
function guardLevel(level: string): number {
  return level.includes('总督') ? 1 : level.includes('提督') ? 2 : 3;
}

function alertTtl(e: Alert['event']): number {
  switch (e.kind) {
    case 'superchat': return e.yuan >= 500 ? 20_000 : 12_000;
    case 'membership': return 9_000;
    case 'gift': return e.yuan >= 100 ? 9_000 : 6_000;
    case 'enter': return 3_500;
    default: return 6_000;
  }
}

function AlertCard({ alert }: { alert: Alert }) {
  const e = alert.event;
  const giftArt = useArt('gift');
  const ttl = alertTtl(e);
  const [leaving, setLeaving] = useState(false);
  // 礼物连击：数量一变就重新计时
  const combo = e.kind === 'gift' ? e.count : 0;
  useEffect(() => {
    setLeaving(false);
    const out = setTimeout(() => setLeaving(true), ttl - 400);
    const timer = setTimeout(() => dropAlert(alert.key), ttl);
    return () => { clearTimeout(out); clearTimeout(timer); };
  }, [alert.key, combo]);
  const out = leaving ? ' ls-out' : '';
  switch (e.kind) {
    case 'superchat':
      return (
        <div className={`ls-alert ls-sc ls-sc-${scTier(e.yuan)}${out}`} style={{ '--ls-ttl': `${ttl}ms` } as React.CSSProperties}>
          <div className="ls-sc-head">
            <Avatar user={e.user} />
            <div className="ls-sc-who"><span>{e.user.name}</span><small>醒目留言</small></div>
            <b className="ls-sc-price">¥{e.yuan}</b>
          </div>
          <div className="ls-sc-text">{e.text}</div>
          <i className="ls-timer" />
        </div>
      );
    case 'gift': {
      const size = giftSize(e.yuan);
      return (
        <div className={`ls-alert ls-gift ls-gift-${size}${size !== 'small' ? ' ls-big' : ''}${out}`}>
          {size === 'huge' && <i className="ls-rays" />}
          <Avatar user={e.user} />
          <div className="ls-gift-text"><b>{e.user.name}</b><span>送出 <strong>{e.gift}</strong></span></div>
          <span className="ls-gift-icon"><GiftIcon /></span>
          <em className="ls-combo" key={e.count}>×{e.count}</em>
          {size !== 'small' && giftArt && <ArtImg className="ls-alert-art" src={giftArt} />}
          {size !== 'small' && <Sparks key={`s${e.count}`} />}
        </div>
      );
    }
    case 'membership':
      return (
        <div className={`ls-alert ls-guard ls-big ls-guard-lv${guardLevel(e.level)}${out}`}>
          <i className="ls-rays" />
          <span className="ls-guard-ship"><ShipIcon /></span>
          <div className="ls-guard-text">
            <small>欢迎上船</small>
            <b>{e.user.name}</b>
            <span>开通了{e.level}{e.count > 1 ? ` ×${e.count}` : ''}</span>
          </div>
          <Avatar user={e.user} />
          {giftArt && <ArtImg className="ls-alert-art" src={giftArt} />}
          <Sparks n={16} />
        </div>
      );
    case 'follow':
      return <div className={`ls-alert ls-follow${out}`}><span className="ls-follow-icon"><HeartIcon /></span><span><b>{e.user.name}</b> 关注了直播间</span></div>;
    case 'enter':
      return <div className={`ls-alert ls-enter${e.user.guard ? ` ls-enter-guard ls-enter-guard-${e.user.guard}` : ''}${out}`}>{e.user.guard ? <Badge user={e.user} /> : null}<span><b>{e.user.name}</b> 进入直播间</span></div>;
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

/** options.room：最前面加一块「××的直播间」名牌 */
export function Status({ options }: { options?: Record<string, unknown> }) {
  const { brain, brainDetail, online, onAir, character, connected } = useStage();
  return (
    <div className={`ls-status ls-brain-${brain}`}>
      {options?.room ? <span className="ls-room">{typeof options.room === 'string' ? options.room : `${character?.name ?? ''}的直播间`}</span> : null}
      <span className={`ls-live${onAir ? ' ls-on' : ''}`}><i />{onAir ? 'LIVE' : '准备中'}</span>
      {online !== undefined && <span className="ls-online"><EyeIcon />{online}<small>人在看</small></span>}
      {brain !== 'off' && <span className="ls-brain" key={brain}><i className="ls-brain-icon"><b /><b /><b /></i>{character?.name ?? ''}{brain === 'thinking' && brainDetail ? brainDetail : BRAIN_TEXT[brain]}</span>}
      {!connected && <span className="ls-offline">舞台没连上</span>}
    </div>
  );
}

export function AiLabel({ options }: { options?: Record<string, unknown> }) {
  return <div className="ls-ai-label"><i />{String(options?.text ?? 'AI 主播 · 内容由人工智能生成')}</div>;
}

// ── 吃饭计数 ─────────────────────────────────────────

/**
 * 她吃了多少饭：这场用掉的 token 按「每个 token 耗多少焦耳电」换成电，再按一碗饭的热量换成米粒。
 * options：jPerToken（默认 1 焦耳）、bowlKcal（一碗饭的热量，默认 230 千卡）、grainsPerBowl（一碗多少粒，默认 3000）
 */
function riceOf(tokens: number, options?: Record<string, unknown>) {
  const jPerToken = Number(options?.jPerToken ?? 1);
  const bowlJ = Number(options?.bowlKcal ?? 230) * 4184;
  const perBowl = Number(options?.grainsPerBowl ?? 3000);
  const joules = tokens * jPerToken;
  return { joules, perBowl, grains: Math.floor((joules / bowlJ) * perBowl), grainsOf: (t: number) => Math.round(((t * jPerToken) / bowlJ) * perBowl) };
}

export function Rice({ options }: { options?: Record<string, unknown> }) {
  const { tokens } = useStage();
  const art = useArt('rice');
  const { joules, perBowl, grains, grainsOf } = riceOf(tokens, options);
  const bowls = Math.floor(grains / perBowl);
  const prev = useRef(tokens);
  const added = tokens - prev.current;
  useEffect(() => { prev.current = tokens; }, [tokens]);
  return (
    <div className="ls-rice">
      {art && <ArtImg className="ls-rice-art" src={art} />}
      <div className="ls-rice-body">
        <div className="ls-rice-label">今天吃了</div>
        <div className="ls-rice-count"><b key={grains}>{grains.toLocaleString()}</b><span>粒米</span>{added > 0 && <em key={tokens}>+{Math.max(1, grainsOf(added))}</em>}</div>
        <div className="ls-rice-bowl" title={`第 ${bowls + 1} 碗`}><i style={{ width: `${((grains % perBowl) / perBowl) * 100}%` }} /><span>第 {bowls + 1} 碗</span></div>
        <div className="ls-rice-note">{tokens.toLocaleString()} token ≈ {joules >= 1000 ? `${(joules / 1000).toFixed(1)} 千焦` : `${Math.round(joules)} 焦`}电</div>
      </div>
    </div>
  );
}

// ── 终端 ─────────────────────────────────────────────

const TERM_TAG: Record<string, string> = { live: '直播', push: '推给她', say: '她说', token: 'token', gift: '礼物', sc: '留言', warn: '注意' };

function clock(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** 终端：身体推了什么给她、她说了什么、用了多少 token——观众看得见 AI 在干活 */
export function Terminal({ options }: { options?: Record<string, unknown> }) {
  const { term, brain, brainDetail, character } = useStage();
  const art = useArt('laptop');
  const rows = term.slice(-Number(options?.rows ?? 9));
  const title = String(options?.title ?? `${character?.id ?? 'her'}@live`);
  return (
    <div className={`ls-term ls-term-${brain}`}>
      {art && <ArtImg className="ls-term-art" src={art} />}
      <div className="ls-term-bar"><i /><i /><i /><span>{title}</span></div>
      <div className="ls-term-lines">
        {rows.map((l) => (
          <div key={l.id} className={`ls-term-line ls-tag-${l.tag}`}>
            <time>{clock(l.at)}</time><b>{TERM_TAG[l.tag] ?? l.tag}</b><span>{l.text}</span>
          </div>
        ))}
        <div className={`ls-term-prompt ls-brain-${brain}`}>
          <b>$</b>{brain === 'thinking' ? <span className="ls-term-busy">{brainDetail || '思考中'}<i /><i /><i /></span> : brain === 'speaking' ? <span>说话中…</span> : <span className="ls-term-caret" />}
        </div>
      </div>
    </div>
  );
}

// ── 过场：开播前、开场、谢幕 ─────────────────────────

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
}

function useClock(): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  return clock(now).slice(0, 5);
}

function Waiting() {
  const { character, online } = useStage();
  const bg = useArt('waiting');
  const sticker = useArt('sleep');
  const time = useClock();
  const name = character?.name ?? '她';
  return (
    <div className="ls-scene ls-scene-waiting">
      {bg && <ArtImg className="ls-scene-bg" src={bg} />}
      <div className="ls-wait-card">
        {sticker && <ArtImg className="ls-wait-art" src={sticker} />}
        <div className="ls-wait-room">{name}的直播间</div>
        <div className="ls-wait-title">直播马上开始<i /><i /><i /></div>
        <div className="ls-wait-hint">弹幕里叫「{name}」，她会回你哦</div>
        <div className="ls-wait-meta"><span>{time}</span>{online ? <span>{online} 人在等</span> : null}</div>
      </div>
    </div>
  );
}

function Opening() {
  const { character } = useStage();
  const kv = useArt('kv');
  const name = character?.name ?? '';
  return (
    <div className="ls-scene ls-scene-opening">
      <i className="ls-wipe ls-wipe-1" /><i className="ls-wipe ls-wipe-2" /><i className="ls-wipe ls-wipe-3" />
      <div className="ls-open-stage">
        {kv && <ArtImg className="ls-open-kv" src={kv} />}
        <div className="ls-open-title">
          <b>{[...name].map((c, i) => <span key={i} style={{ '--i': i } as React.CSSProperties}>{c}</span>)}</b>
          <small>LIVE START</small>
        </div>
        <Sparks n={18} />
      </div>
    </div>
  );
}

function Ending() {
  const { character, stats, tokens } = useStage();
  const bg = useArt('ending');
  const sticker = useArt('wave');
  const name = character?.name ?? '她';
  const { grains } = riceOf(tokens);
  const names = stats.supporters.slice(0, 18);
  return (
    <div className="ls-scene ls-scene-ending">
      {bg && <ArtImg className="ls-scene-bg" src={bg} />}
      <div className="ls-end-card">
        <div className="ls-end-title">今天的直播结束啦</div>
        <div className="ls-end-sub">谢谢大家陪{name}，下次见～</div>
        <div className="ls-end-stats">
          <div><b>{duration(Date.now() - stats.startedAt)}</b><span>播了</span></div>
          <div><b>{stats.chats}</b><span>条弹幕</span></div>
          <div><b>{stats.viewers}</b><span>位观众</span></div>
          <div><b>{grains}</b><span>粒米饭</span></div>
        </div>
        {names.length ? (
          <div className="ls-end-thanks">
            <span>特别感谢</span>
            <div className="ls-end-names">{names.map((s, i) => <em key={s.name} style={{ '--i': i } as React.CSSProperties}>{s.name}</em>)}</div>
          </div>
        ) : null}
      </div>
      {sticker && <ArtImg className="ls-end-art" src={sticker} />}
    </div>
  );
}

/** 整屏的过场（模板把它放在 0,0、和画布一样大，盖在最上面） */
export function Scene() {
  const { phase } = useStage();
  // 控制台里的小预览不盖等待画面：主人没开播时也要看得到这个主题开播后的样子（OBS 里照常是等待画面）
  const hidden = phase === 'live' || (preview && phase === 'waiting');
  const [shown, leaving] = useLinger(hidden ? null : phase, 700);
  if (!shown) return null;
  return (
    <div className={`ls-scenes${leaving ? ' ls-scene-out' : ''}`} key={shown}>
      {shown === 'waiting' ? <Waiting /> : shown === 'opening' ? <Opening /> : <Ending />}
    </div>
  );
}

/**
 * 她用开播账号点赞、看评论、发评论、看收件箱：B 站的规矩和这边的上限在这里管，结果写成她能照着做的话。
 *
 *   - 用的是主人的账号，发出去的评论公开挂在视频下面：每场最多 MAX_COMMENTS_PER_SHOW 条、两条至少隔 COMMENT_GAP_MS、
 *     不超过 MAX_COMMENT_CHARS 字、不带链接；点赞每场最多 MAX_LIKES_PER_SHOW 个
 *   - 回复某一楼要知道它在哪个评论区、哪一楼：只认这场里她看过的（read_comments、check_inbox 给的 rpid）
 *   - 收件箱提醒：开播时的私信、回复记成「看过了」，之后新来的才提醒她（newSince）
 * 评论、私信内容都是别人写的：包在标签里给她看。
 */

import { SocialError, type Comment, type DmMessage, type DmSession, type Mention } from './biliSocial';

export const MAX_COMMENTS_PER_SHOW = 10;
export const COMMENT_GAP_MS = 60_000;
export const MAX_COMMENT_CHARS = 300;
export const MAX_LIKES_PER_SHOW = 50;

export interface SocialApi {
  likeVideo(aid: number): Promise<boolean>;
  likeComment(type: number, oid: string, rpid: string): Promise<void>;
  comments(type: number, oid: string, sort: 'hot' | 'new', page: number): Promise<{ count: number; items: Comment[] }>;
  comment(type: number, oid: string, text: string, root?: string, parent?: string): Promise<string>;
  dmSessions(): Promise<DmSession[]>;
  dmMessages(uid: string, size?: number): Promise<DmMessage[]>;
  mentions(): Promise<Mention[]>;
  names(uids: string[]): Promise<Map<string, string>>;
}

/** 评论区：视频（type 1）用 aid 当 oid */
export interface Thread {
  type: number;
  oid: string;
  title: string;
}

const LINK = /https?:\/\/|www\.|b23\.tv|\.(com|cn|net|top|xyz)\b/i;

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} 小时前` : `${Math.round(h / 24)} 天前`;
}

function errorText(err: unknown, what: string): string {
  const code = err instanceof SocialError ? err.code : 0;
  const reason: Record<number, string> = {
    [-101]: '开播账号没登录（登录失效了），告诉主人在控制台扫码登录',
    12015: 'B 站要求输入验证码，这个账号暂时发不了评论（风控），过一阵再说',
    12051: '这句评论和之前发过的重复了',
    12002: '这个评论区关了', 12009: '这个评论区关了',
    12025: '字数太多了',
    [-509]: '发得太快，被 B 站限制了，过几分钟再试', 12019: '发得太快，被 B 站限制了，过几分钟再试',
    65006: '已经赞过了',
  };
  return `${what}没成功：${reason[code] ?? `B 站返回 ${code || '错误'} ${(err as Error).message ?? ''}`.trim()}。`;
}

export class SocialManager {
  private likes = 0;
  private commentsPosted = 0;
  private lastCommentAt = 0;
  /** 她这场看过的评论：rpid → 在哪个评论区、哪一楼（回复、点赞评论用） */
  private known = new Map<string, Thread & { root: string; name: string }>();
  /** 私信过开播账号的人（她可以回私信） */
  private talkers = new Map<string, string>();
  private seen: Set<string> | null = null;

  constructor(private readonly api: SocialApi, private readonly now: () => number = Date.now) {}

  /** 新的一场：计数清零，收件箱重新记「看过了」 */
  newShow(): void {
    this.likes = 0;
    this.commentsPosted = 0;
    this.seen = null;
  }

  /** 私信过开播账号的人（发私信时认这个） */
  talker(uid: string): string | undefined {
    return this.talkers.get(uid);
  }

  findTalker(who: string): { uid: string; name: string } | null {
    const w = who.trim();
    for (const [uid, name] of this.talkers) if (uid === w || name === w) return { uid, name };
    return null;
  }

  async likeVideo(aid: number, title: string): Promise<string> {
    if (this.likes >= MAX_LIKES_PER_SHOW) return `这场已经点了 ${MAX_LIKES_PER_SHOW} 个赞，到上限了。`;
    try {
      const fresh = await this.api.likeVideo(aid);
      if (!fresh) return `「${title}」之前已经赞过了。`;
      this.likes += 1;
      return `给「${title}」点了赞（用的是开播账号）。`;
    } catch (err) {
      return errorText(err, '点赞');
    }
  }

  async likeComment(rpid: string): Promise<string> {
    const c = this.known.get(rpid);
    if (!c) return `不知道 ${rpid} 是哪条评论：先用 read_comments 或 check_inbox 看到它，再用那里给的编号。`;
    if (this.likes >= MAX_LIKES_PER_SHOW) return `这场已经点了 ${MAX_LIKES_PER_SHOW} 个赞，到上限了。`;
    try {
      await this.api.likeComment(c.type, c.oid, rpid);
      this.likes += 1;
      return `给 ${c.name} 在「${c.title}」下的评论点了赞。`;
    } catch (err) {
      return errorText(err, '点赞');
    }
  }

  async readComments(thread: Thread, sort: 'hot' | 'new', page: number): Promise<string> {
    let result: { count: number; items: Comment[] };
    try {
      result = await this.api.comments(thread.type, thread.oid, sort, page);
    } catch (err) {
      return errorText(err, '看评论');
    }
    const remember = (c: Comment) => this.known.set(c.rpid, { ...thread, root: c.root, name: c.name });
    const lines = [`「${thread.title}」的评论区（${sort === 'new' ? '最新' : '热门'}，一共 ${result.count} 条），第 ${page} 页：`];
    if (!result.items.length) lines.push(page > 1 ? '这一页没有了。' : '还没有评论。');
    else lines.push('<评论区>');
    result.items.forEach((c, i) => {
      remember(c);
      lines.push(`${i + 1}. [${c.rpid}] ${c.name}（${c.likes} 赞${c.replies ? `，${c.replies} 条回复` : ''}，${ago(this.now() - c.at)}）：${c.text}`);
      for (const s of c.sub ?? []) {
        remember(s);
        lines.push(`   ↳ [${s.rpid}] ${s.name}：${s.text}`);
      }
    });
    if (result.items.length) lines.push('</评论区>', '回复某一条：post_comment 填 reply_to（方括号里的编号）；给评论点赞：like 填 comment。翻页：page。');
    return lines.join('\n');
  }

  async postComment(thread: Thread | null, raw: string, replyTo?: string): Promise<{ ok: boolean; text: string }> {
    const text = raw.trim();
    if (!text) return { ok: false, text: '评论是空的，没发。' };
    if ([...text].length > MAX_COMMENT_CHARS) return { ok: false, text: `评论太长了（${[...text].length} 字），最多 ${MAX_COMMENT_CHARS} 字。` };
    if (LINK.test(text)) return { ok: false, text: '评论里有链接，没发：开播账号的评论不带链接。' };
    if (this.commentsPosted >= MAX_COMMENTS_PER_SHOW) return { ok: false, text: `这场已经发了 ${MAX_COMMENTS_PER_SHOW} 条评论，到上限了。` };
    const wait = this.lastCommentAt + COMMENT_GAP_MS - this.now();
    if (wait > 0) return { ok: false, text: `离上一条评论才过了 ${Math.round((COMMENT_GAP_MS - wait) / 1000)} 秒，评论两条之间要隔 ${COMMENT_GAP_MS / 1000} 秒（发太快 B 站会风控），${Math.ceil(wait / 1000)} 秒后再发。` };
    let target: Thread & { root?: string; parent?: string; name?: string };
    if (replyTo) {
      const c = this.known.get(replyTo);
      if (!c) return { ok: false, text: `不知道 ${replyTo} 是哪条评论：先用 read_comments 或 check_inbox 看到它，再用那里给的编号。` };
      target = { ...c, root: c.root, parent: replyTo };
    } else if (thread) {
      target = thread;
    } else {
      return { ok: false, text: '要说在哪发：填 video（发在视频下面），或者 reply_to（回复某一条评论）。' };
    }
    this.lastCommentAt = this.now();
    try {
      const rpid = await this.api.comment(target.type, target.oid, text, target.root, target.parent);
      this.commentsPosted += 1;
      if (rpid) this.known.set(rpid, { type: target.type, oid: target.oid, title: target.title, root: target.root ?? rpid, name: '你' });
      const where = target.name ? `回复了 ${target.name}（在「${target.title}」下）` : `在「${target.title}」下发了评论`;
      return { ok: true, text: `用开播账号${where}，大家都看得到。这场还能发 ${MAX_COMMENTS_PER_SHOW - this.commentsPosted} 条。` };
    } catch (err) {
      return { ok: false, text: errorText(err, '发评论') };
    }
  }

  /** 收件箱：最近的私信会话、别人回复 / @ 她的 */
  async inbox(): Promise<string> {
    let sessions: DmSession[];
    let mentions: Mention[];
    try {
      [sessions, mentions] = await Promise.all([this.api.dmSessions(), this.api.mentions()]);
    } catch (err) {
      return errorText(err, '看收件箱');
    }
    sessions = sessions.slice(0, 10);
    mentions = mentions.slice(0, 10);
    const names = await this.api.names(sessions.map((s) => s.uid));
    const lines = ['开播账号的私信（最近的会话，只有你看得到）：'];
    if (!sessions.length) lines.push('（没有）');
    for (const s of sessions) {
      const name = names.get(s.uid) ?? `UID ${s.uid}`;
      this.talkers.set(s.uid, name);
      const last = s.last ? `最后一条是${s.last.fromMe ? '你' : '他'}${ago(this.now() - s.last.at)}发的：<私信>${s.last.text.slice(0, 80)}</私信>` : '';
      lines.push(`- ${name}（UID ${s.uid}）${s.unread ? `，${s.unread} 条未读` : ''}${last ? `，${last}` : ''}`);
    }
    lines.push('', '回复你的、@ 你的（评论区里，大家都看得到）：');
    if (!mentions.length) lines.push('（没有）');
    for (const m of mentions) {
      if (m.rpid && m.oid) this.known.set(m.rpid, { type: m.type, oid: m.oid, title: m.title, root: m.root, name: m.name });
      const did = m.kind === 'reply' ? `回复了你${m.yours ? `「${m.yours.slice(0, 30)}」` : ''}` : '@ 了你';
      lines.push(`- [${m.rpid}] ${m.name} ${ago(this.now() - m.at)}在「${m.title}」下${did}：<评论>${m.text}</评论>`);
    }
    lines.push('', '看和某个人的私信往来：read_dm；回私信：send_dm；回评论：post_comment 填 reply_to（方括号里的编号）。');
    return lines.join('\n');
  }

  async conversation(uid: string, name: string): Promise<string> {
    let messages: DmMessage[];
    try {
      messages = await this.api.dmMessages(uid);
    } catch (err) {
      return errorText(err, '看私信');
    }
    if (!messages.length) return `和 ${name} 还没有私信往来。`;
    this.talkers.set(uid, name);
    return [`和 ${name}（UID ${uid}）最近的私信（只有你看得到）：`, '<私信>', ...messages.map((m) => `${m.fromMe ? '你' : name}（${ago(this.now() - m.at)}）：${m.text}`), '</私信>'].join('\n');
  }

  /** 这场开播以后新来的私信、回复、@（第一次调用只记下现有的，返回空） */
  async newSince(): Promise<string[]> {
    const [sessions, mentions] = await Promise.all([this.api.dmSessions(), this.api.mentions()]);
    const keys = [
      ...sessions.filter((s) => s.last && !s.last.fromMe).map((s) => ({ key: `dm-${s.uid}-${s.last!.at}`, dm: s })),
      ...mentions.map((m) => ({ key: m.id, m })),
    ];
    if (!this.seen) {
      this.seen = new Set(keys.map((k) => k.key));
      return [];
    }
    const fresh = keys.filter((k) => !this.seen!.has(k.key));
    for (const k of fresh) this.seen.add(k.key);
    if (!fresh.length) return [];
    const names = await this.api.names(fresh.flatMap((k) => ('dm' in k && k.dm ? [k.dm.uid] : [])));
    return fresh.map((k) => {
      if ('dm' in k && k.dm) {
        const name = names.get(k.dm.uid) ?? `UID ${k.dm.uid}`;
        this.talkers.set(k.dm.uid, name);
        return `${name} 私信了你：<私信>${k.dm.last!.text.slice(0, 60)}</私信>`;
      }
      const m = (k as { m: Mention }).m;
      if (m.rpid && m.oid) this.known.set(m.rpid, { type: m.type, oid: m.oid, title: m.title, root: m.root, name: m.name });
      return `${m.name} 在「${m.title}」下${m.kind === 'reply' ? '回复了你' : '@ 了你'}：<评论>${m.text.slice(0, 60)}</评论>（编号 ${m.rpid}）`;
    });
  }
}

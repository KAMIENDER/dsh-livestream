/**
 * 开播账号的点赞、评论、收件箱（私信会话、别人回复 / @ 她）。发私信在 biliAccount.ts。
 *   点赞视频   x/web-interface/archive/like（65006 已经赞过）
 *   点赞评论   x/v2/reply/action
 *   看评论     x/v2/reply?type=&oid=&sort=（0 最新、1 点赞最多）
 *   发评论     x/v2/reply/add（root / parent 是回复楼中楼）
 *   私信会话   api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions；一个会话的消息 svr_sync/fetch_session_msgs
 *   回复我的   x/msgfeed/reply；@ 我的 x/msgfeed/at
 * 评论返回码：12015 要验证码、12051 重复评论、12002 / 12009 评论区关了、12025 太长、-509 / 12019 太快、-101 没登录。
 */

import { createBiliSession, type BiliSession } from '../core/platforms/bilibili/biliApi';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12_000;
const SESSION_TTL_MS = 30 * 60_000;

export class SocialError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export interface Comment {
  rpid: string;
  /** 楼主那条的 rpid（自己就是楼主时等于 rpid） */
  root: string;
  uid: string;
  name: string;
  text: string;
  likes: number;
  replies: number;
  at: number;
  /** 楼里几条回复 */
  sub?: Comment[];
}

export interface DmSession {
  uid: string;
  unread: number;
  /** 最后一条：谁发的（me 是开播账号自己）、说了什么、什么时候 */
  last?: { fromMe: boolean; text: string; at: number };
}

export interface Mention {
  /** 这条通知的 id（去重用） */
  id: string;
  kind: 'reply' | 'at';
  uid: string;
  name: string;
  /** 他说的 */
  text: string;
  /** 他回的是你的哪句（回复时有） */
  yours?: string;
  /** 在哪个稿件下：标题、评论区类型、oid；回他用 */
  title: string;
  type: number;
  oid: string;
  rpid: string;
  root: string;
  at: number;
}

export interface DmMessage {
  fromMe: boolean;
  text: string;
  at: number;
}

function cookieValue(cookie: string, name: string): string | undefined {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie)?.[1];
}

/** 评论、私信里的表情转义、HTML 实体 */
export function plain(text: unknown, max = 300): string {
  return String(text ?? '')
    .replace(/&(#\d+|amp|lt|gt|quot|apos|nbsp);/g, (_, e: string) => (e.startsWith('#') ? String.fromCharCode(Number(e.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[e] ?? ''))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 私信的 content 是 JSON 字符串（文字消息是 {"content":"…"}）；别的类型说一声是什么 */
function dmText(msgType: unknown, content: unknown): string {
  const type = Number(msgType);
  let parsed: any = null;
  try { parsed = JSON.parse(String(content ?? '')); } catch { /* 不是 JSON */ }
  if (type === 1) return plain(parsed?.content ?? content, 500);
  if (type === 2) return '[图片]';
  if (type === 6) return '[表情]';
  if (type === 7) return `[分享] ${plain(parsed?.title ?? '', 60)}`;
  if (type === 5) return '[撤回了一条消息]';
  return `[${plain(parsed?.title ?? parsed?.content ?? '消息', 60)}]`;
}

export class BiliSocial {
  private session: Promise<BiliSession> | null = null;
  private sessionAt = 0;
  private sessionCookie = '';

  constructor(private readonly cookie: () => Promise<string>) {}

  private async auth(): Promise<BiliSession> {
    const cookie = await this.cookie();
    if (!this.session || cookie !== this.sessionCookie || Date.now() - this.sessionAt > SESSION_TTL_MS) {
      this.sessionCookie = cookie;
      this.sessionAt = Date.now();
      this.session = createBiliSession(cookie);
      this.session.catch(() => { this.session = null; });
    }
    return this.session;
  }

  private async get<T>(url: string, referer = 'https://www.bilibili.com/'): Promise<T> {
    const s = await this.auth();
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer, Origin: referer.replace(/\/$/, ''), Cookie: s.cookie }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await res.json()) as { code: number; message?: string; data?: T };
    if (body.code !== 0) throw new SocialError(body.code, body.message ?? '');
    return body.data as T;
  }

  private async post(url: string, form: Record<string, string | number>): Promise<any> {
    const s = await this.auth();
    const csrf = cookieValue(s.cookie, 'bili_jct');
    if (!s.loggedIn || !csrf) throw new SocialError(-101, '没登录');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com', Cookie: s.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.entries({ ...form, csrf }).map(([k, v]) => [k, String(v)])),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json()) as { code: number; message?: string; data?: any };
    if (body.code !== 0) throw new SocialError(body.code, body.message ?? '');
    return body.data;
  }

  async me(): Promise<string> {
    const s = await this.auth();
    return s.loggedIn ? String(s.uid) : '';
  }

  /** 赞一个视频；已经赞过返回 false */
  async likeVideo(aid: number): Promise<boolean> {
    try {
      await this.post('https://api.bilibili.com/x/web-interface/archive/like', { aid, like: 1 });
      return true;
    } catch (err) {
      if (err instanceof SocialError && err.code === 65006) return false;
      throw err;
    }
  }

  async likeComment(type: number, oid: string, rpid: string): Promise<void> {
    await this.post('https://api.bilibili.com/x/v2/reply/action', { type, oid, rpid, action: 1 });
  }

  async comments(type: number, oid: string, sort: 'hot' | 'new', page: number): Promise<{ count: number; items: Comment[] }> {
    const data = await this.get<{ page?: { count?: number }; replies?: any[] | null; top_replies?: any[] | null }>(
      `https://api.bilibili.com/x/v2/reply?type=${type}&oid=${oid}&sort=${sort === 'new' ? 0 : 1}&pn=${page}&ps=20`);
    const map = (r: any): Comment => ({
      rpid: String(r.rpid), root: String(r.root || r.rpid), uid: String(r.mid), name: plain(r.member?.uname, 30),
      text: plain(r.content?.message, 300), likes: Number(r.like) || 0, replies: Number(r.rcount) || 0, at: (Number(r.ctime) || 0) * 1000,
      ...(r.replies?.length ? { sub: r.replies.slice(0, 3).map(map) } : {}),
    });
    const top = page === 1 ? (data.top_replies ?? []) : [];
    return { count: Number(data.page?.count) || 0, items: [...top, ...(data.replies ?? [])].map(map) };
  }

  /** 发评论（root / parent 填了就是回复那一楼） */
  async comment(type: number, oid: string, text: string, root?: string, parent?: string): Promise<string> {
    const data = await this.post('https://api.bilibili.com/x/v2/reply/add', {
      type, oid, message: text, plat: 1, ...(root ? { root, parent: parent ?? root } : {}),
    });
    return String(data?.rpid ?? data?.rpid_str ?? '');
  }

  async dmSessions(): Promise<DmSession[]> {
    const me = await this.me();
    const data = await this.get<{ session_list?: any[] | null }>(
      'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=0&unfollow_fold=0&sort_rule=2&build=0&mobi_app=web',
      'https://message.bilibili.com/');
    return (data.session_list ?? []).filter((x) => x.talker_id && Number(x.session_type ?? 1) === 1).map((x) => ({
      uid: String(x.talker_id),
      unread: Number(x.unread_count) || 0,
      ...(x.last_msg ? { last: { fromMe: String(x.last_msg.sender_uid) === me, text: dmText(x.last_msg.msg_type, x.last_msg.content), at: (Number(x.last_msg.timestamp) || 0) * 1000 } } : {}),
    }));
  }

  async dmMessages(uid: string, size = 20): Promise<DmMessage[]> {
    const me = await this.me();
    const data = await this.get<{ messages?: any[] | null }>(
      `https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=${uid}&session_type=1&size=${size}`, 'https://message.bilibili.com/');
    return (data.messages ?? []).map((m) => ({ fromMe: String(m.sender_uid) === me, text: dmText(m.msg_type, m.content), at: (Number(m.timestamp) || 0) * 1000 }))
      .sort((a, b) => a.at - b.at);
  }

  async mentions(): Promise<Mention[]> {
    const [replies, ats] = await Promise.all([
      this.get<{ items?: any[] | null }>('https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web', 'https://message.bilibili.com/'),
      this.get<{ items?: any[] | null }>('https://api.bilibili.com/x/msgfeed/at?build=0&mobi_app=web', 'https://message.bilibili.com/'),
    ]);
    const map = (kind: 'reply' | 'at') => (i: any): Mention => ({
      id: `${kind}-${i.id}`, kind, uid: String(i.user?.mid ?? ''), name: plain(i.user?.nickname, 30),
      text: plain(i.item?.source_content, 300), ...(kind === 'reply' && i.item?.target_reply_content ? { yours: plain(i.item.target_reply_content, 120) } : {}),
      title: plain(i.item?.title, 60), type: Number(i.item?.business_id) || 1, oid: String(i.item?.subject_id ?? ''),
      rpid: String(i.item?.source_id ?? ''), root: String(i.item?.root_id || i.item?.source_id || ''),
      at: (Number(kind === 'reply' ? i.reply_time : i.at_time) || 0) * 1000,
    });
    return [...(replies.items ?? []).map(map('reply')), ...(ats.items ?? []).map(map('at'))].sort((a, b) => b.at - a.at);
  }

  /** uid → 名字（私信会话只给 uid） */
  async names(uids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!uids.length) return out;
    try {
      const data = await this.get<any[] | null>(`https://api.vc.bilibili.com/account/v1/user/cards?uids=${uids.join(',')}`, 'https://message.bilibili.com/');
      for (const u of data ?? []) if (u?.mid) out.set(String(u.mid), plain(u.name, 30));
    } catch {
      // 拿不到名字就只写 UID
    }
    return out;
  }
}

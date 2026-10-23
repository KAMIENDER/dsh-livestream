import { describe, expect, it, vi } from 'vitest';
import { SocialError, plain } from '../src/body/biliSocial';
import { COMMENT_GAP_MS, MAX_COMMENTS_PER_SHOW, SocialManager, type SocialApi } from '../src/body/social';

function fakeApi(over: Partial<SocialApi> = {}): SocialApi & { posted: Array<unknown[]> } {
  const posted: Array<unknown[]> = [];
  return {
    posted,
    likeVideo: async () => true,
    likeComment: async () => {},
    comments: async () => ({
      count: 2,
      items: [
        { rpid: '11', root: '11', uid: '1', name: '小明', text: '好看', likes: 3, replies: 1, at: 0, sub: [{ rpid: '12', root: '11', uid: '2', name: '小红', text: '同意', likes: 0, replies: 0, at: 0 }] },
      ],
    }),
    comment: async (...args) => { posted.push(args); return `r${posted.length}`; },
    dmSessions: async () => [],
    dmMessages: async () => [],
    mentions: async () => [],
    names: async (uids) => new Map(uids.map((u) => [u, `用户${u}`])),
    ...over,
  };
}

const thread = { type: 1, oid: '100', title: '猫猫视频' };

describe('comments', () => {
  it('lists comments with ids and replies to one into its own floor', async () => {
    let now = 1_000_000;
    const api = fakeApi();
    const social = new SocialManager(api, () => now);
    const text = await social.readComments(thread, 'hot', 1);
    expect(text).toContain('[11] 小明（3 赞，1 条回复');
    expect(text).toContain('↳ [12] 小红：同意');
    const reply = await social.postComment(null, '我也觉得', '12');
    expect(reply.ok).toBe(true);
    expect(reply.text).toContain('回复了 小红');
    expect(api.posted[0]).toEqual([1, '100', '我也觉得', '11', '12']);
  });

  it('keeps the account safe: links, gaps, unknown ids and the per-show cap', async () => {
    let now = 1_000_000;
    const social = new SocialManager(fakeApi(), () => now);
    expect((await social.postComment(thread, '看这个 https://b23.tv/x')).text).toContain('链接');
    expect((await social.postComment(null, '你好', '999')).text).toContain('不知道 999');
    expect((await social.postComment(thread, '第一条')).ok).toBe(true);
    expect((await social.postComment(thread, '第二条')).text).toContain(`要隔 ${COMMENT_GAP_MS / 1000} 秒`);
    for (let i = 1; i < MAX_COMMENTS_PER_SHOW; i++) {
      now += COMMENT_GAP_MS;
      expect((await social.postComment(thread, `第${i + 1}条`)).ok).toBe(true);
    }
    now += COMMENT_GAP_MS;
    expect((await social.postComment(thread, '再来一条')).text).toContain('到上限了');
    social.newShow();
    expect((await social.postComment(thread, '新的一场')).ok).toBe(true);
  });

  it('says what went wrong in words she can act on', async () => {
    const social = new SocialManager(fakeApi({ comment: async () => { throw new SocialError(12015, '需要验证码'); } }));
    expect((await social.postComment(thread, '你好')).text).toContain('验证码');
  });

  it('unescapes Bilibili text', () => {
    expect(plain('&#34;我话越多&#34; &amp; 它越满')).toBe('"我话越多" & 它越满');
  });
});

describe('inbox', () => {
  it('only tells her about what came in after the show started', async () => {
    const sessions = [{ uid: '7', unread: 1, last: { fromMe: false, text: '在吗', at: 1 } }];
    const mentions = [{ id: 'reply-1', kind: 'reply' as const, uid: '8', name: '路人', text: '哈哈', yours: '我的评论', title: '宣传片', type: 1, oid: '100', rpid: '55', root: '50', at: 1 }];
    const api = fakeApi({ dmSessions: vi.fn(async () => sessions), mentions: vi.fn(async () => mentions) });
    const social = new SocialManager(api);
    expect(await social.newSince()).toEqual([]);
    sessions[0] = { uid: '7', unread: 2, last: { fromMe: false, text: '在吗在吗', at: 2 } };
    mentions.push({ ...mentions[0], id: 'at-2', kind: 'at', rpid: '60', text: '@你 来看' });
    const fresh = await social.newSince();
    expect(fresh).toHaveLength(2);
    expect(fresh[0]).toContain('用户7 私信了你');
    expect(fresh[1]).toContain('@ 了你');
    expect(await social.newSince()).toEqual([]);
    // 新来的回复也能直接回
    expect((await social.postComment(null, '谢谢', '60')).ok).toBe(true);
    expect(social.findTalker('用户7')).toEqual({ uid: '7', name: '用户7' });
  });

  it('lists conversations and mentions with their ids', async () => {
    const social = new SocialManager(fakeApi({
      dmSessions: async () => [{ uid: '7', unread: 1, last: { fromMe: false, text: '主播好', at: Date.now() } }],
      mentions: async () => [{ id: 'reply-1', kind: 'reply', uid: '8', name: '路人', text: '笑死', yours: '本鱼来了', title: '宣传片', type: 1, oid: '100', rpid: '55', root: '50', at: Date.now() }],
    }));
    const text = await social.inbox();
    expect(text).toContain('用户7（UID 7），1 条未读');
    expect(text).toContain('<私信>主播好</私信>');
    expect(text).toContain('[55] 路人');
    expect(text).toContain('回复了你「本鱼来了」');
  });
});

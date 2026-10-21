/**
 * 把注意力层挑出的话题写成推给大脑（她直播的会话）的一条消息：发生了什么、该怎么回、大概多长。
 * 她只决定怎么说；说什么、对谁说由注意力层定（照 hiyoriai 的 streamerPrompts）。
 * 她看得到这场直播的完整对话，所以这里不带「最近说过什么」这类摘要，只带历史里没有的：观众记忆、上一场回顾。
 *
 * 写法：只写事实和这一次要做的事。观众的名字和弹幕都包在标签里、清洗过，当作聊天内容看待。
 */

import type { LiveUser } from './live';
import type { Topic } from './attention/topics';
import { cleanName, cleanText } from './safety';

export interface TopicContext {
  /** 直播记忆：她记得这位观众什么（没有返回 null） */
  viewerCard?: (user: LiveUser) => string | null;
  /** 开场白用：上一场的回顾 */
  lastRecap?: string[];
  /** 今天的日期（观众卡片里的日期要和它比） */
  today?: string;
}

const HEAT_TEXT = { quiet: '直播间人不多，弹幕很慢', normal: '弹幕不快不慢', busy: '弹幕刷得很快' } as const;

function who(user: LiveUser): string {
  const name = cleanName(user.name);
  const marks: string[] = [];
  if (user.guardLevel === 1) marks.push('总督');
  else if (user.guardLevel === 2) marks.push('提督');
  else if (user.guardLevel === 3) marks.push('舰长');
  if (user.medal?.ofThisRoom && user.medal.level >= 20) marks.push(`粉丝牌${user.medal.level}级`);
  if (user.isAdmin) marks.push('房管');
  return marks.length ? `${name}（${marks.join('，')}）` : name;
}

function names(users: LiveUser[], more: number): string {
  return users.map(who).join('、') + (more ? `，还有另外 ${more} 位` : '');
}

function cardLines(users: LiveUser[], ctx: TopicContext): string[] {
  return users.flatMap((u) => {
    const card = ctx.viewerCard?.(u);
    return card ? [`  （关于${cleanName(u.name)}，你记得：${card}）`] : [];
  });
}

interface Body {
  what: string[];
  how: string;
  maxChars: number;
}

function body(topic: Topic, ctx: TopicContext): Body {
  switch (topic.kind) {
    case 'chat': {
      const lines = topic.picks.flatMap((p) => [
        `- ${who(p.event.user)}${p.tags.length ? ` [${p.tags.join('/')}]` : ''}：${cleanText(p.text)}`,
        ...cardLines([p.event.user], ctx),
      ]);
      const many = topic.picks.length > 1;
      return {
        what: ['<观众弹幕>', ...lines, '</观众弹幕>'],
        how: (many ? '挑最有意思或最需要回答的一两条回应，点名不超过两位，其余的可以不接。' : '回应这条弹幕，可以点名。')
          + (lines.some((l) => l.startsWith('  （')) ? '你记得的事在自然的时候提一句就好。' : ''),
        maxChars: many ? 80 : 60,
      };
    }
    case 'superchat':
      return {
        what: [`${who(topic.event.user)} 发了一条 ${topic.event.valueYuan} 元的醒目留言：`, `<醒目留言>${cleanText(topic.event.text)}</醒目留言>`, ...cardLines([topic.event.user], ctx)],
        how: '先点名谢谢这条醒目留言，再认真回应留言的内容。',
        maxChars: 90,
      };
    case 'thanks': {
      const lines = topic.events.map((e) =>
        e.kind === 'membership'
          ? `- ${who(e.user)} 开通了${e.levelName}${e.count > 1 ? ` ×${e.count}个月` : ''}`
          : `- ${who(e.user)} 送了 ${cleanName(e.giftName)} ×${e.count}`,
      );
      return { what: ['刚刚有人支持了直播间：', ...lines, ...cardLines(topic.events.map((e) => e.user), ctx)], how: '逐个点名真诚地感谢，开心但不夸张，价格留在心里。', maxChars: 70 };
    }
    case 'gifts': {
      const byUser = new Map<string, { user: LiveUser; gifts: string[] }>();
      for (const g of topic.events) {
        const key = g.user.id || g.user.name;
        const entry = byUser.get(key) ?? { user: g.user, gifts: [] };
        entry.gifts.push(`${cleanName(g.giftName)}×${g.count}`);
        byUser.set(key, entry);
      }
      const lines = [...byUser.values()].map((e) => `- ${who(e.user)}：${e.gifts.join('、')}`);
      if (topic.more) lines.push(`- 还有另外 ${topic.more} 位也送了小礼物`);
      return { what: ['这段时间收到的小礼物：', ...lines], how: '用一句轻快的话一起谢谢大家，点名不超过三位。', maxChars: 50 };
    }
    case 'trend':
      return {
        what: [`有 ${topic.users} 位观众在刷同样的弹幕：${topic.samples.map((s) => `「${cleanText(s)}」`).join(' ')}`],
        how: '对这股刷屏的气氛做个反应：接梗、吐槽或者顺着玩，不用点名。',
        maxChars: 40,
      };
    case 'welcome':
      return {
        what: [`刚进直播间的观众：${names(topic.users, topic.more)}`, ...cardLines(topic.users, ctx)],
        how: '点名打个招呼就行，一句话。',
        maxChars: 25,
      };
    case 'follow':
      return { what: [`刚关注了直播间的观众：${names(topic.users, topic.more)}`], how: '简短地谢谢关注。', maxChars: 35 };
    case 'opening':
      return {
        what: [
          '直播刚刚开始。',
          ...(ctx.lastRecap?.length ? [`上一场直播的回顾（可以提一句）：${ctx.lastRecap.join('；')}`] : []),
        ],
        how: '跟大家打个招呼，介绍一下自己，邀请大家发弹幕聊天。',
        maxChars: 60,
      };
    case 'ending':
      return {
        what: ['主人说今天的直播到这里结束。', topic.summary].filter(Boolean),
        how: '跟大家道别：谢谢今天的陪伴，可以提一两个今天印象深的人或事，约下次见。',
        maxChars: 80,
      };
    case 'owner':
      return {
        what: [
          '主人（你的搭档）在直播间跟你说话，观众也看得到：',
          `<主人>${cleanText(topic.text)}</主人>`,
          ...(topic.interrupted ? [`你刚才正说到「${cleanText(topic.interrupted).slice(0, 60)}」，被他打断了。`] : []),
        ],
        how: '像搭档一样直接回他：可以吐槽、接梗、反驳或者撒娇；需要的话最后把话头拉回直播间。',
        maxChars: 70,
      };
    case 'video':
      return topic.how === 'ended'
        ? { what: [`你放的视频「${cleanText(topic.title)}」放完了（放了 ${minutes(topic.playedSec)}），舞台换回了聊天的样子。`], how: '可以说说看完的感想、问问大家觉得怎么样，或者接着聊弹幕。', maxChars: 60 }
        : { what: [`你要放的视频「${cleanText(topic.title)}」没放出来（舞台加载不了 B 站的视频地址）。`], how: '跟大家说一声，可以换一个或者接着聊。', maxChars: 40 };
    case 'idle':
      return { what: ['直播间这会儿没人发弹幕。'], how: '自己找点话说：讲一件你作为 AI 的真实小事，或者问观众一个具体、好回答的问题。', maxChars: 70 };
  }
}

function minutes(sec: number): string {
  const s = Math.round(sec);
  return s >= 60 ? `${Math.floor(s / 60)} 分${s % 60 ? ` ${s % 60} 秒` : '钟'}` : `${s} 秒`;
}

export function topicText(topic: Topic, ctx: TopicContext): string {
  const b = body(topic, ctx);
  const heat = ['opening', 'ending', 'owner'].includes(topic.kind) ? '' : `${HEAT_TEXT[topic.heat]}。`;
  const head = `${heat}${ctx.today ? `今天是${ctx.today}。` : ''}`;
  return [...(head ? [head, ''] : []), ...b.what, '', `${b.how}不超过 ${b.maxChars} 字。`].join('\n');
}

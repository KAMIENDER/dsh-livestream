import { describe, expect, it } from 'vitest';
import { HandOffs } from '../src/dsh/agent';

const message = (...content: Array<{ type: string; text?: string; name?: string }>) => ({ type: 'assistant/message', data: { message: { content } } });
const text = (t: string) => ({ type: 'text', text: t });
const handOff = { type: 'tool-call', name: 'game_side' };

describe('live line submitting a suggestion', () => {
  it('keeps proposal speech audible while owner review is pending', () => {
    const h = new HandOffs();
    expect(h.unsaid('live', message(text('彩排观众乙，交给游戏里的我'), handOff))).toBe(false);
  });

  it('does not transfer authority or mute the next message after a proposal', () => {
    // game_side现在只提议，不代表游戏线已经接受或开始执行。
    const h = new HandOffs();
    h.turnStarted('live');
    expect(h.unsaid('live', message(handOff))).toBe(false);
    expect(h.unsaid('live', message(text('已提交建议，等主人审核')))).toBe(false);
  });

  it('speaks what she wrote before the hand-off, and every turn starts fresh', () => {
    const h = new HandOffs();
    h.turnStarted('live');
    expect(h.unsaid('live', message(text('小灯塔？好主意')))).toBe(false);
    expect(h.unsaid('live', message(handOff))).toBe(false);
    h.turnStarted('live');
    expect(h.unsaid('live', message(text('欢迎新来的')))).toBe(false);
  });

  it('keeps sessions apart', () => {
    const h = new HandOffs();
    h.unsaid('live-a', message(handOff));
    expect(h.unsaid('live-b', message(text('你好')))).toBe(false);
  });
});

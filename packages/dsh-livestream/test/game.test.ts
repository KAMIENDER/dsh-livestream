import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveShow } from '../src/body/show';
import { arrange, gameRect } from '../src/stage/layout';
import { topicText } from '../src/core/topicText';
import type { TemplateManifest } from '../src/stage/protocol';

const chat = (id: string, text: string) => ({ kind: 'chat' as const, id, platform: 'bilibili' as const, ts: Date.now(), user: { id: `u-${id}`, name: `观众${id}` }, text });

describe('playing a game on stream', () => {
  afterEach(() => vi.useRealTimers());

  function start() {
    vi.useFakeTimers();
    const pushed: string[] = [];
    const midTurn: boolean[] = [];
    const onGame = vi.fn();
    const show = new LiveShow(
      { push: async (_s, text, now) => { pushed.push(text); midTurn.push(!!now); return true; }, synthesize: async () => null, onGame },
      { dataDir: mkdtempSync(join(tmpdir(), 'dsh-game-live-')), names: ['大肥鱼'] },
    );
    show.goLive('s1');
    return { show, pushed, midTurn, onGame };
  }

  it('hands danmaku to her mid-game and wakes game_continue', async () => {
    const { show, pushed, midTurn, onGame } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('s1');
    show.showGame({ window: 'Minecraft:GLFW30:javaw.exe', overlay: 'http://127.0.0.1:7391/' });
    expect(onGame).toHaveBeenCalledWith({ window: 'Minecraft:GLFW30:javaw.exe', overlay: 'http://127.0.0.1:7391/' });
    // 她开始玩：一轮很长，在 game_continue 里等
    show.turnStarted('s1');
    const waiting = new AbortController();
    let woke = false;
    void show.waitAttention(waiting.signal).then(() => { woke = true; });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(pushed).toHaveLength(1); // 只有开场：玩游戏的时候不找话说，也不当她卡住
    expect(woke).toBe(false);
    show.inject(chat('1', '挖到钻石了吗'));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toContain('挖到钻石了吗');
    // 插进她这一轮的下一步（steer），不是排到下一轮
    expect(midTurn[1]).toBe(true);
    expect(woke).toBe(true);
    // 隔得太近的攒着，过了间隔再推
    show.inject(chat('2', '小心苦力怕'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pushed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(pushed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(pushed).toHaveLength(3);
    expect(pushed[2]).toContain('小心苦力怕');
    show.endLive();
    show.dispose();
  });

  it('calls her back to the game when her turn stops, and goes back to normal when the game ends', async () => {
    const { show, pushed } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.showGame({ url: 'http://127.0.0.1:7400/' });
    show.turnEnded('s1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toContain('game_continue');
    show.turnEnded('s1');
    show.showGame(null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pushed).toHaveLength(2);
    show.endLive();
    show.dispose();
  });

  it('holds danmaku while her mouth is backed up', async () => {
    const { show, pushed } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('s1');
    show.showGame({ window: 'w' });
    show.turnStarted('s1');
    const quiet = new AbortController().signal;
    void show.say('这是一句挺长的话，念起来要好几秒钟才能念完的那种，观众在等。', 'talk', quiet);
    void show.say('第二句也很长，嘴里排着两句的时候，新的弹幕先别推给她。', 'talk', quiet);
    show.inject(chat('9', '你好呀'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pushed.some((p) => p.includes('你好呀'))).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(pushed.some((p) => p.includes('你好呀'))).toBe(true);
    show.endLive();
    show.dispose();
  });

  it('lets game_continue give up waiting', async () => {
    const { show } = start();
    const waiting = new AbortController();
    let woke = false;
    void show.waitAttention(waiting.signal).then(() => { woke = true; });
    waiting.abort();
    show.showGame({ window: 'w' });
    show.turnStarted('s1');
    show.inject(chat('3', '你好'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(woke).toBe(false);
    show.endLive();
    show.dispose();
  });
});

describe('game layout', () => {
  const t = {
    format: 1, id: 't', name: 't', canvas: [1920, 1080], theme: {},
    widgets: [{ type: 'chat', x: 40, y: 100, w: 480, h: 900 }, { type: 'subtitle', x: 600, y: 800, w: 700, h: 200 }],
    layouts: { video: [{ type: 'video', x: 560, y: 112, w: 1100, h: 619 }, { type: 'subtitle', x: 560, y: 747, w: 1100, h: 295 }] },
  } as unknown as TemplateManifest;

  it('borrows the video layout and puts the game where the video goes', () => {
    const game = arrange(t, 'game');
    expect(game.find((s) => s.type === 'game')).toMatchObject({ x: 560, y: 112, w: 1100, h: 619 });
    expect(game.find((s) => s.type === 'game')?.hidden).toBeFalsy();
    expect(game.find((s) => s.type === 'video')?.hidden).toBe(true);
    expect(game.find((s) => s.type === 'subtitle')).toMatchObject({ x: 560, y: 747 });
    expect(arrange(t, 'chat').find((s) => s.type === 'game')?.hidden).toBe(true);
    expect(gameRect(t)).toEqual({ x: 560, y: 112, w: 1100, h: 619 });
  });

  it('keeps the same keys across layouts so widgets glide', () => {
    const keys = (m: 'chat' | 'video' | 'game') => arrange(t, m).map((s) => s.key).sort();
    expect(keys('chat')).toEqual(keys('game'));
    expect(keys('video')).toEqual(keys('game'));
  });
});

describe('replies while playing', () => {
  it('asks for a short line while she plays', () => {
    const topic = { kind: 'chat' as const, picks: [{ event: chat('1', '挖到钻石了吗'), text: '挖到钻石了吗', tags: [], score: 1 }], id: 'c', priority: 10, heat: 'quiet' as const, createdAt: 0 };
    expect(topicText(topic, { inGame: true })).toContain('你正在玩游戏，');
    expect(topicText(topic, { inGame: true })).toContain('不超过 30 字');
    expect(topicText(topic, {})).toContain('不超过 60 字');
  });
});

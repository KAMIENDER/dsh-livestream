import { afterEach, describe, expect, it, vi } from 'vitest';

describe('livehime sign', () => {
  afterEach(() => vi.useRealTimers());
  it('matches the StartLive signer for the same payload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return new Response(JSON.stringify({ code: 0, message: '', data: { rtmp: { addr: 'rtmp://x/', code: 'k' } } }));
    });
    const { BiliRoom } = await import('../src/body/biliRoom');
    await new BiliRoom('DedeUserID=1; bili_jct=abc').start(123, 235);
    const sign = new URLSearchParams(calls[0].body).get('sign');
    // python: md5(urlencode(sorted(params)) + appsec)
    expect(sign).toBe('dd376801c64db312404ebb9e0c702790');
  });
});

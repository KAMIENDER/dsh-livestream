export interface RunOptions { days: number; goal: string }

export const MAX_RUN_DAYS = 28;
export const ACTIONS_PER_DAY = 128;

/** Capture a fixed budget once. Reconnecting or changing the daily plan cannot extend it. */
export function runOptions(request: Partial<RunOptions>): Readonly<RunOptions> {
  const days = request.days ?? 1;
  if (!Number.isInteger(days) || days < 1 || days > MAX_RUN_DAYS) {
    throw new Error(`days 必须是 1 到 ${MAX_RUN_DAYS} 的整数；不填时只经营一天。`);
  }
  return Object.freeze({ days, goal: request.goal?.trim().slice(0, 2000) || '照顾农场，预留回家时间，正常睡眠。' });
}

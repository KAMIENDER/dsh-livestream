import type { FarmIdentity } from './extension.js';
import type { ToolOutcome } from './mcp.js';
import { dayNumber, type GameDate, type Snapshot } from './persistence.js';

interface Cursor { observerId: string; sequence: number }
interface ShippingLine { category: number; itemId: string; quality: number; quantity: number; unitPrice: number; total: number }
interface NativeNight {
  observerId: string; sequence: number; runId: string; saveId: string; playerId: string; gameBuildId: string;
  dateBefore: GameDate; dateAfter: GameDate; moneyAtDayEnding: string; moneyAtDayStarted: string; netChange: string;
  shipping: { categoryTotals: number[]; lines: ShippingLine[]; total: number; digest: string };
}
export type NightReason = 'extension_unavailable' | 'cursor_unavailable' | 'observation_pending' | 'query_unavailable'
  | 'cursor_changed' | 'receipt_unavailable' | 'receipt_invalid' | 'morning_balance_mismatch';
export interface NightReport {
  version: 1; status: 'observed' | 'unavailable'; reason?: NightReason;
  dateBefore: GameDate; dateAfter: GameDate;
  wallet: { beforeSleep: string; afterSleep: string; netSinceBeforeSleep: string };
  native?: NativeNight;
  cursorBefore?: Cursor;
  // This is deliberately not named profit/income. Native credit and special-order
  // callbacks happen separately from the display cache; equal sums prove no causality.
  unclassifiedNetSinceDayEnding?: string;
}
export type NightBefore = { cursor: Cursor } | { reason: NightReason };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const reasons: readonly NightReason[] = ['extension_unavailable', 'cursor_unavailable', 'observation_pending', 'query_unavailable',
  'cursor_changed', 'receipt_unavailable', 'receipt_invalid', 'morning_balance_mismatch'];
const object = (v: any): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown, min: number, max = 2147483647): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const money = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,9})$/.test(v) && BigInt(v) <= 2147483647n;
const signed = (v: unknown): v is string => typeof v === 'string' && /^(0|-?[1-9]\d{0,9})$/.test(v);
const diff = (a: string, b: string) => (BigInt(a) - BigInt(b)).toString();
function sameDate(a: any, b: GameDate): boolean {
  try { return object(a) && dayNumber(a as GameDate) === dayNumber(b); } catch { return false; }
}
function cursor(v: any): Cursor | null {
  return object(v) && typeof v.observerId === 'string' && uuid.test(v.observerId) && int(v.sequence, 0)
    ? { observerId: v.observerId, sequence: v.sequence } : null;
}

/** A read cursor is captured before the one permitted sleep, never armed by model text. */
export function nightBefore(result?: ToolOutcome): NightBefore {
  if (!result) return { reason: 'extension_unavailable' };
  const value = result.output, c = cursor(value?.cursor);
  if (result.status !== 'succeeded' || value?.supportedBuild !== true || !c || value.cursorMatched !== true) return { reason: 'cursor_unavailable' };
  if (value.pending !== false) return { reason: 'observation_pending' };
  return { cursor: c };
}

function nativeNight(value: any, before: Snapshot, after: Snapshot, identity: FarmIdentity, runId: string): NativeNight | null {
  if (!object(value) || value.status !== 'observed' || value.reason !== null || !cursor(value)
    || value.runId !== runId || value.saveId !== identity.saveId || value.playerId !== identity.playerId || value.gameBuildId !== identity.gameBuildId
    || !sameDate(value.dateBefore, before.date) || !sameDate(value.dateAfter, after.date)
    || !money(value.moneyAtDayEnding) || !money(value.moneyAtDayStarted) || !signed(value.netChange)
    || value.netChange !== diff(value.moneyAtDayStarted, value.moneyAtDayEnding)) return null;
  const s = value.shipping;
  if (!object(s) || !Array.isArray(s.categoryTotals) || s.categoryTotals.length !== 6 || s.categoryTotals.some((v: any) => !int(v, 0))
    || !Array.isArray(s.lines) || s.lines.length > 64 || !int(s.total, 0) || typeof s.digest !== 'string' || !sha.test(s.digest)) return null;
  const totals = [0n, 0n, 0n, 0n, 0n];
  for (const line of s.lines) {
    if (!object(line) || !int(line.category, 0, 4) || typeof line.itemId !== 'string' || line.itemId.length < 1 || line.itemId.length > 128 || /[\x00-\x1f]/.test(line.itemId)
      || !int(line.quality, 0, 4) || !int(line.quantity, 1, 10000) || !int(line.unitPrice, 0) || !int(line.total, 0)
      || BigInt(line.unitPrice) * BigInt(line.quantity) !== BigInt(line.total)) return null;
    totals[line.category] += BigInt(line.total);
  }
  if (totals.some((v, i) => v !== BigInt(s.categoryTotals[i])) || totals.reduce((a, b) => a + b, 0n) !== BigInt(s.total) || s.categoryTotals[5] !== s.total) return null;
  // Copy only explicit facts; neither arbitrary native text nor executable instance
  // keys enter checkpoints/persona memory through this receipt.
  return { observerId: value.observerId, sequence: value.sequence, runId, saveId: identity.saveId, playerId: identity.playerId, gameBuildId: identity.gameBuildId,
    dateBefore: { ...before.date }, dateAfter: { ...after.date }, moneyAtDayEnding: value.moneyAtDayEnding, moneyAtDayStarted: value.moneyAtDayStarted, netChange: value.netChange,
    shipping: { categoryTotals: [...s.categoryTotals], total: s.total, digest: s.digest,
      lines: s.lines.map((l: ShippingLine) => ({ category: l.category, itemId: l.itemId, quality: l.quality, quantity: l.quantity, unitPrice: l.unitPrice, total: l.total })) } };
}

export function nightAfter(beforeRead: NightBefore, result: ToolOutcome | undefined, before: Snapshot, after: Snapshot, identity: FarmIdentity, runId: string): NightReport {
  if (!money(before.player.money) || !money(after.player.money) || dayNumber(after.date) !== dayNumber(before.date) + 1) throw new Error('日终余额或日期不符合观察边界。');
  const base: NightReport = { version: 1, status: 'unavailable', dateBefore: { ...before.date }, dateAfter: { ...after.date },
    wallet: { beforeSleep: before.player.money, afterSleep: after.player.money, netSinceBeforeSleep: diff(after.player.money, before.player.money) } };
  if ('reason' in beforeRead) return { ...base, reason: beforeRead.reason };
  if (result?.status !== 'succeeded') return { ...base, reason: 'query_unavailable' };
  const q = result.output, c = cursor(q?.cursor);
  if (q?.supportedBuild !== true || q.cursorMatched !== true || !c || c.observerId !== beforeRead.cursor.observerId || c.sequence !== beforeRead.cursor.sequence + 1) return { ...base, reason: 'cursor_changed' };
  if (!q.receipt || q.receipt.status === 'unavailable') return { ...base, reason: 'receipt_unavailable' };
  const n = nativeNight(q.receipt, before, after, identity, runId);
  if (!n || n.observerId !== c.observerId || n.sequence !== c.sequence || q.pending !== false) return { ...base, reason: 'receipt_invalid' };
  if (n.moneyAtDayStarted !== after.player.money) return { ...base, reason: 'morning_balance_mismatch' };
  return { ...base, status: 'observed', native: n, cursorBefore: { ...beforeRead.cursor }, unclassifiedNetSinceDayEnding: diff(n.netChange, String(n.shipping.total)) };
}

/** Offline backfill revalidates the saved facts against the exact confirmed day and farm. */
export function validNightReport(value: unknown, before: Snapshot, after: Snapshot, identity: FarmIdentity, runId: string): value is NightReport {
  try {
    const v = value as NightReport;
    if (!object(v) || v.version !== 1 || !sameDate(v.dateBefore, before.date) || !sameDate(v.dateAfter, after.date)
      || dayNumber(after.date) !== dayNumber(before.date) + 1 || !object(v.wallet) || !money(v.wallet.beforeSleep) || !money(v.wallet.afterSleep)
      || v.wallet.beforeSleep !== before.player.money || v.wallet.afterSleep !== after.player.money || v.wallet.netSinceBeforeSleep !== diff(v.wallet.afterSleep, v.wallet.beforeSleep)) return false;
    if (v.status === 'unavailable') return reasons.includes(v.reason!) && v.native === undefined && v.cursorBefore === undefined && v.unclassifiedNetSinceDayEnding === undefined;
    if (v.status !== 'observed' || v.reason !== undefined || !v.native) return false;
    const native = nativeNight({ ...v.native, status: 'observed', reason: null }, before, after, identity, runId);
    const c = cursor(v.cursorBefore);
    return !!native && !!c && c.observerId === native.observerId && c.sequence + 1 === native.sequence
      && native.moneyAtDayStarted === after.player.money && v.unclassifiedNetSinceDayEnding === diff(native.netChange, String(native.shipping.total));
  } catch { return false; }
}

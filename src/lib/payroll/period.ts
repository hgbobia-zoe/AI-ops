// Pay-period math for HR / Payroll. Default cadence = weekly, Monday–Sunday (the Monday 8AM sync processes
// the just-completed week). All dates are YYYY-MM-DD, computed in UTC so they never drift by timezone.
// The cadence will become configurable in Settings; these helpers are the single source for period bounds.

import type { PayPeriod } from "./types";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parse(ymdStr: string): Date {
  const [y, m, d] = ymdStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
/** Shift a YYYY-MM-DD by n days (UTC). */
export function addDays(ymdStr: string, n: number): string {
  const d = parse(ymdStr);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

/** Monday (0) … Sunday (6) index for a date. */
function mondayIndex(ymdStr: string): number {
  const dow = parse(ymdStr).getUTCDay(); // 0=Sun..6=Sat
  return (dow + 6) % 7; // 0=Mon..6=Sun
}

/** The Monday–Sunday week that CONTAINS `today`. */
export function currentPayPeriod(today: string): PayPeriod {
  const start = addDays(today, -mondayIndex(today));
  const end = addDays(start, 6);
  return { start, end, label: periodLabel(start, end) };
}

/** The last COMPLETE Monday–Sunday week before the one containing `today` (what the Monday sync runs). */
export function previousPayPeriod(today: string): PayPeriod {
  const cur = currentPayPeriod(today);
  const start = addDays(cur.start, -7);
  const end = addDays(start, 6);
  return { start, end, label: periodLabel(start, end) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmt(ymdStr: string): string {
  const d = parse(ymdStr);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export function periodLabel(start: string, end: string): string {
  return `${fmt(start)} – ${fmt(end)}`;
}

/** Validate + normalize a requested period. Falls back to the current week when inputs are missing/invalid;
 *  swaps reversed bounds; rejects absurd ranges (>92 days). */
export function resolvePeriod(today: string, start?: string | null, end?: string | null): PayPeriod {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (start && end && re.test(start) && re.test(end)) {
    let s = start;
    let e = end;
    if (e < s) [s, e] = [e, s];
    const span = (parse(e).getTime() - parse(s).getTime()) / 86_400_000;
    if (span >= 0 && span <= 92) return { start: s, end: e, label: periodLabel(s, e) };
  }
  return currentPayPeriod(today);
}

/** The named selector the Time Sync UI offers → a concrete period. */
export function namedPeriod(today: string, which: "current" | "previous"): PayPeriod {
  return which === "previous" ? previousPayPeriod(today) : currentPayPeriod(today);
}

// Financial Intelligence — reporting periods, in the ops timezone.
//
// THREE RECONCILING DIMENSIONS (FI-Phase 5): the labor ledger is summable three independent ways and
// these do NOT nest cleanly, so each is a first-class lens over the SAME cost_entries leaves.
//   A. Calendar / financial week (Mon–Sun) — UNCHANGED baseline for the weekly revenue target + WoW.
//   B. Operational cycle (configurable anchor day + length, can CROSS calendar weeks) — e.g. Thu→Tue:
//      load Thu, events over the weekend, returns/reset Mon–Tue. A new period type, not a week variant.
//   C. Project / event — period-independent (handled by the event-id rollup, not a date range here).
import { todayInOpsTz, shiftYmd } from "@/lib/dates";

export type PeriodKey = "today" | "thisWeek" | "nextWeek" | "thisMonth" | "lastMonth" | "thisCycle" | "lastCycle";

export interface Period {
  /** A preset key, or "custom" for an explicit user-chosen date range (Stage 7b). */
  key: PeriodKey | "custom";
  label: string;
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
  /** True for the Mon–Sun calendar weeks a weekly revenue target applies to (dimension A). */
  isWeek: boolean;
  /** True for the configurable operational-cycle periods (dimension B). */
  isCycle?: boolean;
}

export const PERIOD_KEYS: PeriodKey[] = ["today", "thisWeek", "nextWeek", "thisCycle", "lastCycle", "thisMonth", "lastMonth"];

/** The operational-cycle definition (dimension B). anchorDow: 0=Sun … 6=Sat; lengthDays inclusive. */
export interface OpsCycleConfig {
  anchorDow: number;
  lengthDays: number;
}

/** Zoe's confirmed default: anchor Thursday (4), length 6 → Thu/Fri/Sat/Sun/Mon/Tue. CONFIGURABLE
 *  via the settings KV (see finance/config.ts opsCycleConfig()). */
export const DEFAULT_OPS_CYCLE: OpsCycleConfig = { anchorDow: 4, lengthDays: 6 };

const DOW_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Start (the most recent anchor-day on/before `today`) of the operational cycle containing `today`. */
function cycleStart(today: string, cfg: OpsCycleConfig): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const back = (dow - cfg.anchorDow + 7) % 7; // days since the last anchor day
  return shiftYmd(today, -back);
}

function monthBounds(ymd: string, monthOffset: number): { start: string; end: string } {
  const [y, m] = ymd.split("-").map(Number);
  const firstOfTarget = new Date(Date.UTC(y, m - 1 + monthOffset, 1));
  const start = firstOfTarget.toISOString().slice(0, 10);
  const firstOfNext = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 1));
  const end = new Date(firstOfNext.getTime() - 86400_000).toISOString().slice(0, 10);
  return { start, end };
}

export function getPeriod(key: PeriodKey, today: string = todayInOpsTz(), cycle: OpsCycleConfig = DEFAULT_OPS_CYCLE): Period {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0=Sun … 6=Sat
  const weekStart = shiftYmd(today, -((dow + 6) % 7)); // Monday of this week (Mon–Sun weeks)
  const len = Math.max(1, Math.round(cycle.lengthDays));
  const cycleLabel = `${DOW_LABEL[cycle.anchorDow] ?? "Thu"}→+${len - 1}d`;
  switch (key) {
    case "today":
      return { key, label: "Today", start: today, end: today, isWeek: false };
    case "thisWeek":
      return { key, label: "This Week", start: weekStart, end: shiftYmd(weekStart, 6), isWeek: true };
    case "nextWeek":
      return { key, label: "Next Week", start: shiftYmd(weekStart, 7), end: shiftYmd(weekStart, 13), isWeek: true };
    case "thisCycle": {
      const start = cycleStart(today, cycle);
      return { key, label: `This Cycle (${cycleLabel})`, start, end: shiftYmd(start, len - 1), isWeek: false, isCycle: true };
    }
    case "lastCycle": {
      const start = shiftYmd(cycleStart(today, cycle), -len);
      return { key, label: `Last Cycle (${cycleLabel})`, start, end: shiftYmd(start, len - 1), isWeek: false, isCycle: true };
    }
    case "thisMonth": {
      const { start, end } = monthBounds(today, 0);
      return { key, label: "This Month", start, end, isWeek: false };
    }
    case "lastMonth": {
      const { start, end } = monthBounds(today, -1);
      return { key, label: "Last Month", start, end, isWeek: false };
    }
  }
}

/** The calendar week (Mon–Sun) immediately before `period` — the stable WoW baseline (dimension A). */
export function priorWeek(period: Period): Period {
  return { key: "thisWeek", label: "Prior Week", start: shiftYmd(period.start, -7), end: shiftYmd(period.end, -7), isWeek: true };
}

/** The operational cycle immediately before `period` (cycle-over-cycle baseline, dimension B). */
export function priorCycle(period: Period, cycle: OpsCycleConfig = DEFAULT_OPS_CYCLE): Period {
  const len = Math.max(1, Math.round(cycle.lengthDays));
  return { key: "lastCycle", label: "Prior Cycle", start: shiftYmd(period.start, -len), end: shiftYmd(period.end, -len), isWeek: false, isCycle: true };
}

// ── Custom date range (Stage 7b) — an explicit ?start=&end= range that slots into the SAME Period shape ──
// financeForPeriod consumes. Deterministic + validated: a bad range NEVER throws; it returns null and the
// caller falls back to the default preset. isWeek/isCycle are false, so a custom range gets no weekly
// revenue target and no trajectory snapshot (honest: those are week/cycle concepts, not an arbitrary span).
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Lower bound: no real financial data predates this, and it blocks absurd/accidental inputs. */
export const MIN_CUSTOM_YMD = "2000-01-01";
/** Upper bound on how far out `end` may sit (5 years), so future-dated events are reachable but typos are not. */
export const MAX_CUSTOM_FUTURE_DAYS = 365 * 5;
/** Guardrail on total span (~5 years inclusive) — a sane ceiling, not a business rule. */
export const MAX_CUSTOM_RANGE_DAYS = 1830;

/** True when `s` is a real calendar day in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-01, etc.). */
function isRealYmd(s: string): boolean {
  if (!YMD_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Inclusive day span between two valid YYYY-MM-DD days (a→a = 1). */
function spanDaysInclusive(start: string, end: string): number {
  const [ay, am, ad] = start.split("-").map(Number);
  const [by, bm, bd] = end.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000) + 1;
}

/**
 * Build a Period from an explicit start/end range (ops-TZ `YYYY-MM-DD`). Pure + deterministic.
 * Returns null — never throws — when the range is missing a bound, malformed, inverted (start > end),
 * or out of sane bounds, so the page falls back to its default preset.
 */
export function customRange(
  startRaw: string | null | undefined,
  endRaw: string | null | undefined,
  today: string = todayInOpsTz(),
): Period | null {
  if (!startRaw || !endRaw) return null;
  const start = startRaw.trim();
  const end = endRaw.trim();
  if (!isRealYmd(start) || !isRealYmd(end)) return null;
  if (start > end) return null; // inverted
  if (start < MIN_CUSTOM_YMD) return null; // below the floor
  if (end > shiftYmd(today, MAX_CUSTOM_FUTURE_DAYS)) return null; // too far in the future
  if (spanDaysInclusive(start, end) > MAX_CUSTOM_RANGE_DAYS) return null; // span too wide
  return { key: "custom", label: "Custom range", start, end, isWeek: false };
}

/** The equal-length window immediately preceding `period` (the honest "prior" baseline for a custom range,
 *  where neither priorWeek nor priorCycle applies). */
export function priorRange(period: Period): Period {
  const len = spanDaysInclusive(period.start, period.end);
  return { key: period.key, label: "Prior range", start: shiftYmd(period.start, -len), end: shiftYmd(period.end, -len), isWeek: false };
}

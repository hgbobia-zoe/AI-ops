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
  key: PeriodKey;
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

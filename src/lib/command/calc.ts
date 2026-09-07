// Command Center — pure aggregation helpers (no I/O), so the dashboard's derived numbers are unit-
// tested rather than assembled inline in the page. Everything here is deterministic arithmetic over
// data another layer already fetched. RULES CALCULATE.

import { shiftYmd } from "@/lib/dates";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface OutlookDay {
  date: string;
  dow: string; // "Mon"
  isToday: boolean;
  jobs: number; // booked events that day (lost/cancelled already excluded upstream)
  revenue: number | null; // committed (signed) $ that day; null when nothing priced/signed
  verdict: string | null; // capacity verdict for the day, if computed
}

/** Build the next `days` days from `today`, folding in booked events and any capacity verdicts. */
export function sevenDayOutlook(
  today: string,
  bookings: { date: string; revenue?: number | null; signed?: boolean }[],
  capacityByDate: Map<string, string>,
  days = 7,
): OutlookDay[] {
  const out: OutlookDay[] = [];
  for (let i = 0; i < days; i++) {
    const date = shiftYmd(today, i);
    const dow = DOW[new Date(`${date}T00:00:00Z`).getUTCDay()];
    let jobs = 0;
    let revenue: number | null = null;
    for (const b of bookings) {
      if (b.date !== date) continue;
      jobs++;
      if (b.signed && typeof b.revenue === "number") revenue = (revenue ?? 0) + b.revenue;
    }
    out.push({ date, dow, isToday: i === 0, jobs, revenue, verdict: capacityByDate.get(date) ?? null });
  }
  return out;
}

export type OpStatus = "quiet" | "normal" | "busy" | "at-risk";

/** A single at-a-glance status for the day, from job load + whether anything needs attention. Purely
 *  a display rollup — the attention feed remains the source of truth for specifics. */
export function dayStatus(jobsToday: number, criticalOrHigh: number, capacityConstrained: boolean): OpStatus {
  if (criticalOrHigh > 0 || capacityConstrained) return "at-risk";
  if (jobsToday === 0) return "quiet";
  if (jobsToday >= 12) return "busy";
  return "normal";
}

/** Percent of target, clamped to a sensible display range. null when target unknown. */
export function pctOfTarget(actual: number | null, target: number | null): number | null {
  if (actual == null || target == null || target <= 0) return null;
  return Math.round((actual / target) * 100);
}

// ── Revenue path-to-target ───────────────────────────────────────────────────
// Answers "are we making our number?" deterministically. NOTE: we DON'T do a linear run-rate
// "pace" projection — event-rental revenue is booked ahead (most of a month's revenue is signed
// weeks before), so run-rate would mislead. Instead we frame it as target COVERAGE: committed vs
// target, and whether the open quotes for the period can still close the gap.
export type RevenueStatus = "met" | "likely" | "at-risk" | "no-target" | "no-data";

export interface RevenueOutlook {
  periodLabel: string;
  target: number | null;
  committed: number | null; // signed revenue for events IN the period
  pipeline: number | null; // open (unsigned) quotes for events in the period — could still close
  pctOfTarget: number | null;
  pctElapsed: number; // 0–100, share of the calendar period elapsed (context, not a run-rate)
  remaining: number | null; // target − committed, floored at 0
  ceiling: number | null; // committed + pipeline = best case if every open quote closes
  gapAfterPipeline: number | null; // > 0 ⇒ short even if all quotes close
  status: RevenueStatus;
}

export function computeRevenueOutlook(inp: {
  periodLabel: string;
  target: number | null;
  committed: number | null;
  pipeline: number | null;
  pctElapsed: number;
}): RevenueOutlook {
  const { target, committed, pipeline } = inp;
  const pctT = pctOfTarget(committed, target);
  const remaining = target != null && committed != null ? Math.max(0, target - committed) : null;
  const ceiling = committed != null || pipeline != null ? (committed ?? 0) + (pipeline ?? 0) : null;
  const gapAfter = target != null && ceiling != null ? Math.round(target - ceiling) : null;

  let status: RevenueStatus;
  if (target == null) status = "no-target";
  else if (committed == null) status = "no-data";
  else if (committed >= target) status = "met";
  else if ((ceiling ?? 0) >= target) status = "likely"; // the gap can still be closed from open quotes
  else status = "at-risk"; // short even if every open quote closes

  return {
    periodLabel: inp.periodLabel,
    target,
    committed,
    pipeline,
    pctOfTarget: pctT,
    pctElapsed: Math.max(0, Math.min(100, Math.round(inp.pctElapsed))),
    remaining,
    ceiling,
    gapAfterPipeline: gapAfter != null && gapAfter > 0 ? gapAfter : null,
    status,
  };
}

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

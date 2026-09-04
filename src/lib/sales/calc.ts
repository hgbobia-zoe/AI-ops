// Sales Intelligence (MVP5) — pure booking-pipeline math. COUNT-based only: how many events
// are booked into each upcoming week. The $ pipeline / forecast needs Goodshuffle revenue
// (a deferred capture), so this module never touches money — it counts real bookings.

import { shiftYmd } from "@/lib/dates";

export interface WeekBucket {
  weekStart: string; // Monday, YYYY-MM-DD
  weekEnd: string; // Sunday
  label: string; // "Sep 7 – 13"
  // The live pipeline = SIGNED (committed contracts) + ACTION-NEEDED (open quotes to chase).
  // Lost/cancelled are excluded upstream, so count === signedCount + actionNeededCount.
  count: number; // signed + action-needed
  revenue: number | null; // total $ (signed + action-needed); null when none carried a value
  signedCount: number; // committed contracts only
  signedRevenue: number | null; // committed $ only
  actionNeededCount: number; // open quotes still to win
  actionNeededRevenue: number | null; // potential $ still to win
  /** Near-term week with zero bookings — the one honest "attention" signal we can give from
   *  counts alone (far-out empties are normal and NOT flagged). */
  nearTermGap: boolean;
}

/** MONDAY that starts the week containing `ymd` (weeks run Monday–Sunday). */
export function weekStartOf(ymd: string): string {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0=Sun … 6=Sat
  const offsetToMonday = (dow + 6) % 7; // Mon→0, Sun→6
  return shiftYmd(ymd, -offsetToMonday);
}

function weekLabel(start: string, end: string): string {
  const fmt = (d: string): string => {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

export interface MonthBucket {
  month: number; // 1–12
  label: string; // "Jan"
  count: number; // signed + action-needed
  revenue: number | null; // total $
  signedCount: number;
  signedRevenue: number | null;
  actionNeededCount: number;
  actionNeededRevenue: number | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Bucket a calendar year's booked events into 12 months. Same signed / action-needed split as the
 *  weekly pipeline; lost/cancelled are excluded upstream. */
export function monthlyPipeline(events: { date: string; revenue?: number | null; signed?: boolean }[], year: number): MonthBucket[] {
  const buckets: MonthBucket[] = MONTHS.map((label, i) => ({
    month: i + 1,
    label,
    count: 0,
    revenue: null,
    signedCount: 0,
    signedRevenue: null,
    actionNeededCount: 0,
    actionNeededRevenue: null,
  }));
  const yr = String(year);
  for (const e of events) {
    if (e.date.slice(0, 4) !== yr) continue;
    const m = Number(e.date.slice(5, 7)) - 1;
    if (m < 0 || m > 11) continue;
    const b = buckets[m];
    const hasRev = typeof e.revenue === "number";
    b.count++;
    if (hasRev) b.revenue = (b.revenue ?? 0) + (e.revenue as number);
    if (e.signed) {
      b.signedCount++;
      if (hasRev) b.signedRevenue = (b.signedRevenue ?? 0) + (e.revenue as number);
    } else {
      b.actionNeededCount++;
      if (hasRev) b.actionNeededRevenue = (b.actionNeededRevenue ?? 0) + (e.revenue as number);
    }
  }
  return buckets;
}

export interface PipelineOptions {
  weeks: number;
  /** How many leading weeks count as "near-term" for the empty-week flag. */
  nearTermWeeks: number;
}

/** Bucket booked events into `weeks` upcoming Mon–Sun weeks starting from today's week. */
export function bookingPipeline(
  events: { date: string; revenue?: number | null; signed?: boolean }[],
  today: string,
  opts: PipelineOptions = { weeks: 8, nearTermWeeks: 2 },
): WeekBucket[] {
  const start0 = weekStartOf(today);
  const buckets: WeekBucket[] = [];
  for (let i = 0; i < opts.weeks; i++) {
    const ws = shiftYmd(start0, i * 7);
    const we = shiftYmd(ws, 6);
    buckets.push({ weekStart: ws, weekEnd: we, label: weekLabel(ws, we), count: 0, revenue: null, signedCount: 0, signedRevenue: null, actionNeededCount: 0, actionNeededRevenue: null, nearTermGap: false });
  }
  for (const e of events) {
    for (const b of buckets) {
      if (e.date >= b.weekStart && e.date <= b.weekEnd) {
        b.count++;
        const hasRev = typeof e.revenue === "number";
        if (hasRev) b.revenue = (b.revenue ?? 0) + (e.revenue as number);
        if (e.signed) {
          b.signedCount++;
          if (hasRev) b.signedRevenue = (b.signedRevenue ?? 0) + (e.revenue as number);
        } else {
          b.actionNeededCount++;
          if (hasRev) b.actionNeededRevenue = (b.actionNeededRevenue ?? 0) + (e.revenue as number);
        }
        break;
      }
    }
  }
  buckets.forEach((b, i) => {
    b.nearTermGap = i < opts.nearTermWeeks && b.count === 0;
  });
  return buckets;
}

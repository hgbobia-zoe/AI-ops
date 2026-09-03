// Sales Intelligence (MVP5) — pure booking-pipeline math. COUNT-based only: how many events
// are booked into each upcoming week. The $ pipeline / forecast needs Goodshuffle revenue
// (a deferred capture), so this module never touches money — it counts real bookings.

import { shiftYmd } from "@/lib/dates";

export interface WeekBucket {
  weekStart: string; // Sunday, YYYY-MM-DD
  weekEnd: string; // Saturday
  label: string; // "Sep 7 – 13"
  count: number;
  /** Near-term week with zero bookings — the one honest "attention" signal we can give from
   *  counts alone (far-out empties are normal and NOT flagged). */
  nearTermGap: boolean;
}

/** Sunday that starts the week containing `ymd`. */
export function weekStartOf(ymd: string): string {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return shiftYmd(ymd, -dow);
}

function weekLabel(start: string, end: string): string {
  const fmt = (d: string): string => {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

export interface PipelineOptions {
  weeks: number;
  /** How many leading weeks count as "near-term" for the empty-week flag. */
  nearTermWeeks: number;
}

/** Bucket booked events into `weeks` upcoming Sun–Sat weeks starting from today's week. */
export function bookingPipeline(
  events: { date: string }[],
  today: string,
  opts: PipelineOptions = { weeks: 8, nearTermWeeks: 2 },
): WeekBucket[] {
  const start0 = weekStartOf(today);
  const buckets: WeekBucket[] = [];
  for (let i = 0; i < opts.weeks; i++) {
    const ws = shiftYmd(start0, i * 7);
    const we = shiftYmd(ws, 6);
    buckets.push({ weekStart: ws, weekEnd: we, label: weekLabel(ws, we), count: 0, nearTermGap: false });
  }
  for (const e of events) {
    for (const b of buckets) {
      if (e.date >= b.weekStart && e.date <= b.weekEnd) {
        b.count++;
        break;
      }
    }
  }
  buckets.forEach((b, i) => {
    b.nearTermGap = i < opts.nearTermWeeks && b.count === 0;
  });
  return buckets;
}

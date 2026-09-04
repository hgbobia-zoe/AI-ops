// Sales Intelligence (MVP5) — the forward booking pipeline, from the Goodshuffle BOOKINGS feed
// (searchProjects), not routes. Routes only exist near delivery day, so the real pipeline lives in
// projects. Now that bookings carry contract totals, the $ pipeline is REAL (no longer UNAVAILABLE).

import { todayInOpsTz } from "@/lib/dates";
import { getUpcomingBookings } from "@/lib/db/repo";
import { financeConfig } from "@/lib/finance/config";
import { bookingPipeline, type WeekBucket } from "./calc";

export interface SalesOverview {
  today: string;
  horizonWeeks: number;
  pipeline: WeekBucket[];
  totalBooked: number; // live pipeline = signed + action-needed (lost/cancelled excluded)
  totalSignedCount: number; // committed contracts only
  totalActionNeededCount: number; // open quotes still to win
  totalRevenue: number | null; // $ across the live pipeline (signed + action-needed)
  totalSignedRevenue: number | null; // committed $ only
  totalActionNeededRevenue: number | null; // potential $ still to win
  maxWeekCount: number; // for bar scaling
  weeklyRevenueTarget: number | null; // $ (configured) — the weekly goal line
}

const sumOrNull = (vals: (number | null)[]): number | null => {
  const known = vals.filter((v): v is number => v != null);
  return known.length > 0 ? known.reduce((s, v) => s + v, 0) : null;
};

export function salesOverview(weeks = 8): SalesOverview {
  const today = todayInOpsTz();
  const bookings = getUpcomingBookings(today).map((b) => ({ date: b.eventDate as string, revenue: b.grandTotal, signed: b.signed }));
  const pipeline = bookingPipeline(bookings, today, { weeks, nearTermWeeks: 2 });
  return {
    today,
    horizonWeeks: weeks,
    pipeline,
    totalBooked: pipeline.reduce((n, b) => n + b.count, 0),
    totalSignedCount: pipeline.reduce((n, b) => n + b.signedCount, 0),
    totalActionNeededCount: pipeline.reduce((n, b) => n + b.actionNeededCount, 0),
    totalRevenue: sumOrNull(pipeline.map((b) => b.revenue)),
    totalSignedRevenue: sumOrNull(pipeline.map((b) => b.signedRevenue)),
    totalActionNeededRevenue: sumOrNull(pipeline.map((b) => b.actionNeededRevenue)),
    maxWeekCount: pipeline.reduce((m, b) => Math.max(m, b.count), 0),
    weeklyRevenueTarget: financeConfig().weeklyRevenueTarget,
  };
}

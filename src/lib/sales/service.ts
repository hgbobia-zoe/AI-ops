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
  totalBooked: number; // events booked within the horizon
  totalRevenue: number | null; // $ booked within the horizon (null if none priced)
  maxWeekCount: number; // for bar scaling
  weeklyRevenueTarget: number | null; // $ (configured) — the weekly goal line
}

export function salesOverview(weeks = 8): SalesOverview {
  const today = todayInOpsTz();
  const bookings = getUpcomingBookings(today).map((b) => ({ date: b.eventDate as string, revenue: b.grandTotal }));
  const pipeline = bookingPipeline(bookings, today, { weeks, nearTermWeeks: 2 });
  const totalBooked = pipeline.reduce((n, b) => n + b.count, 0);
  const revenueVals = pipeline.map((b) => b.revenue).filter((v): v is number => v != null);
  const totalRevenue = revenueVals.length > 0 ? revenueVals.reduce((s, v) => s + v, 0) : null;
  const maxWeekCount = pipeline.reduce((m, b) => Math.max(m, b.count), 0);
  return {
    today,
    horizonWeeks: weeks,
    pipeline,
    totalBooked,
    totalRevenue,
    maxWeekCount,
    weeklyRevenueTarget: financeConfig().weeklyRevenueTarget,
  };
}

// Sales Intelligence (MVP5) — assembles the count-based booking pipeline. The $ pipeline and
// forecast stay UNAVAILABLE until Goodshuffle revenue is captured; we surface the configured
// weekly $ target for context but never fabricate a $ pipeline to compare against it.

import { todayInOpsTz } from "@/lib/dates";
import { getBookedEventsFrom } from "@/lib/db/repo";
import { financeConfig } from "@/lib/finance/config";
import { bookingPipeline, type WeekBucket } from "./calc";

export interface SalesOverview {
  today: string;
  horizonWeeks: number;
  pipeline: WeekBucket[];
  totalBooked: number; // events booked within the horizon
  maxWeekCount: number; // for bar scaling
  weeklyRevenueTarget: number | null; // $ (configured) — context only; null = not configured
  revenuePipeline: null; // UNAVAILABLE — needs the revenue capture
}

export function salesOverview(weeks = 8): SalesOverview {
  const today = todayInOpsTz();
  const events = getBookedEventsFrom(today);
  const pipeline = bookingPipeline(events, today, { weeks, nearTermWeeks: 2 });
  const totalBooked = pipeline.reduce((n, b) => n + b.count, 0);
  const maxWeekCount = pipeline.reduce((m, b) => Math.max(m, b.count), 0);
  return {
    today,
    horizonWeeks: weeks,
    pipeline,
    totalBooked,
    maxWeekCount,
    weeklyRevenueTarget: financeConfig().weeklyRevenueTarget,
    revenuePipeline: null,
  };
}

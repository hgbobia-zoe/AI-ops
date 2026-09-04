// Sales Intelligence (MVP5) — the forward booking pipeline, from the Goodshuffle BOOKINGS feed
// (searchProjects), not routes. Routes only exist near delivery day, so the real pipeline lives in
// projects. Now that bookings carry contract totals, the $ pipeline is REAL (no longer UNAVAILABLE).

import { todayInOpsTz } from "@/lib/dates";
import { getUpcomingBookings, getPipelineBookingsInRange, getBookingYears } from "@/lib/db/repo";
import { financeConfig } from "@/lib/finance/config";
import { bookingPipeline, monthlyPipeline, type WeekBucket, type MonthBucket } from "./calc";

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

export interface SalesYearOverview {
  year: number;
  isCurrentYear: boolean;
  availableYears: number[]; // years with data (for the navigator), current year always included
  prevYear: number | null; // for the "‹" nav — null when nothing older exists
  nextYear: number | null; // for the "›" nav — null at the current year (no future-year bookings view)
  months: MonthBucket[]; // 12 months of the selected year
  totalBooked: number; // signed + action-needed across the year (lost/cancelled excluded)
  totalSignedCount: number;
  totalActionNeededCount: number;
  totalRevenue: number | null; // $ across the year (signed + action-needed)
  totalSignedRevenue: number | null;
  totalActionNeededRevenue: number | null;
  maxMonthCount: number; // for bar scaling
  weeklyRevenueTarget: number | null;
}

/** Full-year revenue + booking view for the Sales page, navigable across years. */
export function salesYearOverview(year: number): SalesYearOverview {
  const currentYear = Number(todayInOpsTz().slice(0, 4));
  const bookings = getPipelineBookingsInRange(`${year}-01-01`, `${year}-12-31`).map((b) => ({
    date: b.eventDate as string,
    revenue: b.grandTotal,
    signed: b.signed,
  }));
  const months = monthlyPipeline(bookings, year);

  const dataYears = getBookingYears();
  const availableYears = Array.from(new Set([...dataYears, currentYear])).sort((a, b) => a - b);
  const olderYears = availableYears.filter((y) => y < year);
  const prevYear = olderYears.length > 0 ? olderYears[olderYears.length - 1] : null;
  const nextYear = year < currentYear ? year + 1 : null; // step forward up to the current year

  return {
    year,
    isCurrentYear: year === currentYear,
    availableYears,
    prevYear,
    nextYear,
    months,
    totalBooked: months.reduce((n, m) => n + m.count, 0),
    totalSignedCount: months.reduce((n, m) => n + m.signedCount, 0),
    totalActionNeededCount: months.reduce((n, m) => n + m.actionNeededCount, 0),
    totalRevenue: sumOrNull(months.map((m) => m.revenue)),
    totalSignedRevenue: sumOrNull(months.map((m) => m.signedRevenue)),
    totalActionNeededRevenue: sumOrNull(months.map((m) => m.actionNeededRevenue)),
    maxMonthCount: months.reduce((mx, m) => Math.max(mx, m.count), 0),
    weeklyRevenueTarget: financeConfig().weeklyRevenueTarget,
  };
}

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

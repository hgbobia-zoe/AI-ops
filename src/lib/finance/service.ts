// Financial Intelligence — period service. Server-side. Combines Connecteam labor (planned
// shifts + actual timesheets × pay rates) with Goodshuffle revenue (event_financials) into an
// executive scorecard. RULES CALCULATE — every figure is deterministic or explicitly UNAVAILABLE.

import { getPlannedHours, getActualHours, getPayRates, rateForUserOn } from "@/lib/connecteam";
import { getBookingsRevenueInRange, getBookingsInRange, type EventFinancialView } from "@/lib/db/repo";
import { saveLaborSnapshot, getLaborTrajectory, type LaborSnapshotRow } from "./laborHistory";
import { financeConfig } from "./config";
import { computeVariance, laborPctOfRevenue, contribution, contributionMargin, type Variance, type MoneyStatus } from "./calc";
import type { Period } from "./periods";

export interface FinanceSummary {
  period: Period;
  /** True only when Connecteam labor data was actually retrieved. */
  laborVerified: boolean;
  revenue: {
    signed: number | null; // committed (signed contracts only)
    pipeline: number | null; // unsigned quotes — potential, not revenue
    pipelineCount: number;
    target: number | null;
    status: MoneyStatus;
    vsTarget: Variance;
    events: number; // signed event count
  };
  labor: {
    plannedHours: number | null;
    actualHours: number | null;
    plannedCost: number | null;
    actualCost: number | null;
    hoursVariance: Variance;
    costVariance: Variance;
    rateStatus: MoneyStatus; // ACTUAL when rates on file, UNAVAILABLE otherwise
    employeesMissingRate: number;
    pctOfRevenue: number | null;
  };
  contribution: {
    value: number | null;
    marginPct: number | null;
    status: MoneyStatus;
  };
  events: EventFinancialView[];
  /** planned→revised→actual labor over time for this week (empty for non-week periods). */
  laborTrajectory: LaborSnapshotRow[];
}

function sumHoursCost(hours: Map<number, number>, rateAt: (uid: number) => number | null): { cost: number | null; missing: number; anyRate: boolean } {
  let cost = 0;
  let missing = 0;
  let anyRate = false;
  for (const [uid, h] of hours) {
    const rate = rateAt(uid);
    if (rate == null) {
      missing++;
      continue;
    }
    anyRate = true;
    cost += h * rate;
  }
  return { cost: anyRate ? Math.round(cost * 100) / 100 : null, missing, anyRate };
}

export async function financeForPeriod(period: Period): Promise<FinanceSummary> {
  const cfg = financeConfig();
  const { start, end } = period;

  // Labor — Connecteam (planned shifts + actual timesheets + pay rates).
  const [planned, actual, rates] = await Promise.all([
    getPlannedHours(start, end),
    getActualHours(start, end),
    getPayRates(start, end),
  ]);
  const laborVerified = planned.ok && actual.ok;
  const rateAt = (uid: number) => rateForUserOn(rates, uid, end);
  const plannedHours = laborVerified && planned.hours.size > 0 ? round1(sumMap(planned.hours)) : null;
  // Empty timesheet = no time-clock data → actuals UNAVAILABLE (not "0 worked").
  const actualHours = laborVerified && actual.hours.size > 0 ? round1(sumMap(actual.hours)) : null;
  const pc = laborVerified ? sumHoursCost(planned.hours, rateAt) : { cost: null, missing: 0, anyRate: false };
  const ac = laborVerified ? sumHoursCost(actual.hours, rateAt) : { cost: null, missing: 0, anyRate: false };
  const rateStatus: MoneyStatus = !laborVerified || !(pc.anyRate || ac.anyRate) ? "UNAVAILABLE" : "ACTUAL";

  // Revenue — Goodshuffle BOOKINGS (searchProjects). SIGNED = committed contracts only; a quote is
  // not revenue (tracked separately as pipeline). Null until a pull runs.
  const rev = getBookingsRevenueInRange(start, end);
  const signed = rev.signed;
  const events = rev.signedCount;
  const target = period.isWeek ? cfg.weeklyRevenueTarget : null;
  const revenueStatus: MoneyStatus = signed == null ? "UNAVAILABLE" : "SIGNED";

  const contributionVal = contribution(signed, ac.cost);
  const marginPct = contributionMargin(signed, ac.cost);

  // Labor trajectory (MVP4 P3): for a week, snapshot the labor plan (deduped) as it evolves from
  // scheduled plan toward actual timesheets. Only when Connecteam actually responded (else all-null
  // noise). Piggybacks the numbers already computed above — no extra Connecteam calls.
  let laborTrajectory: LaborSnapshotRow[] = [];
  if (period.isWeek && laborVerified) {
    saveLaborSnapshot({ weekStart: start, plannedHours, plannedCost: pc.cost, actualHours, actualCost: ac.cost });
    laborTrajectory = getLaborTrajectory(start);
  }

  return {
    period,
    laborVerified,
    revenue: {
      signed,
      pipeline: rev.pipeline,
      pipelineCount: rev.pipelineCount,
      target,
      status: revenueStatus,
      vsTarget: computeVariance(target, signed, "revenue"),
      events,
    },
    labor: {
      plannedHours,
      actualHours,
      plannedCost: pc.cost,
      actualCost: ac.cost,
      hoursVariance: computeVariance(plannedHours, actualHours, "cost"),
      costVariance: computeVariance(pc.cost, ac.cost, "cost"),
      rateStatus,
      employeesMissingRate: Math.max(pc.missing, ac.missing),
      pctOfRevenue: laborPctOfRevenue(ac.cost, signed),
    },
    contribution: {
      value: contributionVal,
      marginPct,
      // UNAVAILABLE unless BOTH revenue and a real labor cost exist — never a costs-zeroed figure.
      status: contributionVal == null ? "UNAVAILABLE" : "PROJECTED",
    },
    events: getBookingsInRange(start, end).map(
      (b): EventFinancialView => ({
        eventId: b.bookingId,
        date: b.eventDate ?? "",
        label: b.eventName || `Booking ${b.bookingId}`,
        revenue: b.grandTotal,
        revenueStatus: b.signed ? "SIGNED" : "QUOTE",
      }),
    ),
    laborTrajectory,
  };
}

function sumMap(m: Map<number, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

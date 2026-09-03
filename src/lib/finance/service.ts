// Financial Intelligence — period service. Server-side. Combines Connecteam labor (planned
// shifts + actual timesheets × pay rates) with Goodshuffle revenue (event_financials) into an
// executive scorecard. RULES CALCULATE — every figure is deterministic or explicitly UNAVAILABLE.

import { getPlannedHours, getActualHours, getPayRates, rateForUserOn } from "@/lib/connecteam";
import { getRevenueInRange, getEventFinancialsInRange, type EventFinancialView } from "@/lib/db/repo";
import { financeConfig } from "./config";
import { computeVariance, laborPctOfRevenue, contribution, contributionMargin, type Variance, type MoneyStatus } from "./calc";
import type { Period } from "./periods";

export interface FinanceSummary {
  period: Period;
  /** True only when Connecteam labor data was actually retrieved. */
  laborVerified: boolean;
  revenue: {
    signed: number | null;
    target: number | null;
    status: MoneyStatus;
    vsTarget: Variance;
    events: number;
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

  // Revenue — Goodshuffle (event_financials). Null until the revenue import runs.
  const { revenue: signed, events } = getRevenueInRange(start, end);
  const target = period.isWeek ? cfg.weeklyRevenueTarget : null;
  const revenueStatus: MoneyStatus = signed == null ? "UNAVAILABLE" : "SIGNED";

  const contributionVal = contribution(signed, ac.cost);
  const marginPct = contributionMargin(signed, ac.cost);

  return {
    period,
    laborVerified,
    revenue: {
      signed,
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
      status: signed == null ? "UNAVAILABLE" : "PROJECTED",
    },
    events: getEventFinancialsInRange(start, end),
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

// Financial Intelligence — period service. Server-side. Combines Connecteam labor (planned
// shifts + actual timesheets × pay rates) with Goodshuffle revenue (event_financials) into an
// executive scorecard. RULES CALCULATE — every figure is deterministic or explicitly UNAVAILABLE.

import { getPlannedHours, getActualHours, getPayRates, rateForUserOn } from "@/lib/connecteam";
import { getBookingsRevenueInRange, getBookingsInRange, getEventDirectCosts, getLaborLedgerSummary, getBookingById, getProjectCostFamilies, getBookingUpdatedAt, getBookingRevenueComponents, getRecentReconciliationRuns, type LaborLedgerSummary } from "@/lib/db/repo";
import { saveLaborSnapshot, getLaborTrajectory, type LaborSnapshotRow } from "./laborHistory";
import { financeConfig, itemIntelligenceConfig, insightsConfig } from "./config";
import { projectSnapshot, type ProjectSnapshot } from "./projectSnapshot";
import { buildRevenueModel } from "./revenueModel";
import { estimateHandlingTime, type ItemHandlingEstimate } from "./itemIntelligence";
import { assembleInsightFacts, interpretInsights, type InsightsResult, type InsightProjectInput, type InsightRunInput } from "./insights";
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
  events: EventEconomics[];
  /** planned→revised→actual labor over time for this week (empty for non-week periods). */
  laborTrajectory: LaborSnapshotRow[];
  /** Attributed/REALIZED labor from the cost_entries ledger (buckets, internal/temp split, measured
   *  temp premium). Distinct from the planned Connecteam scorecard above; the ledger is what the
   *  deterministic worker→route→stop→project cascade actually attributed for the period. */
  laborLedger: LaborLedgerSummary;
}

/** Per-event economics: revenue − direct cost (labor today). Contribution UNAVAILABLE unless the
 *  labor is resolved (ACTUAL) — never revenue-with-zeroed-cost. */
export interface EventEconomics {
  eventId: string;
  date: string;
  label: string;
  revenue: number | null;
  revenueStatus: string; // SIGNED | QUOTE
  labor: number | null; // direct labor $ (ACTUAL or ESTIMATED — never a fake ACTUAL)
  laborStatus: "ACTUAL" | "ESTIMATED" | "UNAVAILABLE" | "NONE";
  internalLabor: number | null;
  tempLabor: number | null;
  /** How this project's labor was attributed (badge): PLANNED/DERIVED_STOP/ACTUAL_STOP + confidence. */
  method: "ACTUAL_STOP" | "DERIVED_STOP" | "PLANNED" | "ESTIMATED" | "UNALLOCATED" | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  contribution: number | null;
  contribStatus: "ACTUAL" | "ESTIMATED" | "UNAVAILABLE";
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
    events: eventsEconomics(start, end),
    laborTrajectory,
    laborLedger: getLaborLedgerSummary(start, end),
  };
}

/**
 * Per-project profitability snapshot (compute-on-read). Reads the bookings revenue row (SoT) + the
 * cost-family rollup of the ledger for one project and runs the PURE `projectSnapshot`. No persistence —
 * always recomputable from cost_entries + bookings (the first Profitability-capability build, extending
 * the existing FI engine per the Stage-1 audit). Returns null when the project isn't in bookings yet.
 * `now` is injectable for testing; staleness is the only clock-dependent input.
 */
export function projectFinancials(txId: string, now: Date = new Date()): ProjectSnapshot | null {
  const b = getBookingById(txId);
  if (!b) return null;
  const updatedAt = getBookingUpdatedAt(txId);
  const staleHours = financeConfig().revenueStaleHours;
  const updatedMs = updatedAt != null ? Date.parse(updatedAt) : NaN;
  const stale = Number.isFinite(updatedMs) ? (now.getTime() - updatedMs) / 3_600_000 > staleHours : false;
  // Stage 3: the per-tx revenue component breakdown (dollars) if the pull has captured it; build the honest
  // model from it. Null when not yet pulled → the snapshot falls back to grand-total-only (no regression).
  const storedComponents = getBookingRevenueComponents(txId);
  const components = storedComponents ? buildRevenueModel(storedComponents, b.signed) : null;
  return projectSnapshot({
    projectId: b.bookingId,
    label: b.eventName || `Project ${b.bookingId}`,
    eventDate: b.eventDate,
    revenue: { grandTotal: b.grandTotal, contractTotal: b.contractTotal, amountPaid: b.amountPaid, amountDue: b.amountDue, signed: b.signed, components },
    costFamilies: getProjectCostFamilies(txId),
    revenueAsOf: updatedAt,
    stale,
  });
}

/**
 * FI Stage 6 — a project's PROVISIONAL item-level handling-time estimate (setup/breakdown crew-minutes),
 * inferred from its captured line-item TITLES only (audit §2.5 — no price/qty exists). Compute-on-read:
 * reads the bookings title list + the configurable keyword→minutes map and runs the PURE estimator. This
 * is an operational-time estimate shown for context; it produces NO money figure and writes nothing.
 * Returns null when the project isn't in bookings yet; `available:false` when it has no usable titles.
 */
export function projectHandlingEstimate(txId: string): ItemHandlingEstimate | null {
  const b = getBookingById(txId);
  if (!b) return null;
  return estimateHandlingTime(b.lineItems, itemIntelligenceConfig());
}

/**
 * FI Stage 7c — historical learning / recommendations. Assembles DETERMINISTIC facts over the period's
 * project snapshots + reconciliation-run history, then runs the dormant-safe LLM interpretation pass (facts
 * computed here, the LLM only interprets them). Always returns the facts; the interpretation is null with an
 * honest note when no model is configured. `now` is injectable for staleness in the per-project snapshots.
 */
export async function financeInsights(period: Period, now: Date = new Date()): Promise<InsightsResult> {
  const { start, end } = period;
  const itemCfg = itemIntelligenceConfig();
  const bookings = getBookingsInRange(start, end);

  const projects: InsightProjectInput[] = [];
  for (const b of bookings) {
    const snap = projectFinancials(b.bookingId, now);
    if (!snap) continue;
    const laborFam = snap.costFamilies.find((f) => f.type === "labor") ?? null;
    const keywords = estimateHandlingTime(b.lineItems, itemCfg).keywords;
    projects.push({
      projectId: snap.projectId,
      label: snap.label,
      eventDate: snap.eventDate,
      marginPct: snap.marginPct,
      contribution: snap.contribution,
      revenue: snap.revenue.contracted,
      status: snap.status,
      directCostStatus: snap.directCostStatus,
      laborMethod: laborFam?.method ?? null,
      laborConfidence: laborFam?.confidence ?? null,
      keywords,
    });
  }

  // Reconciliation-run variance trends in the window — reduced to reason+delta (the only facts insights uses).
  const runs: InsightRunInput[] = getRecentReconciliationRuns(start, end).map((r) => ({
    projectId: r.projectId,
    lines: (r.variance?.lines ?? []).map((ln) => ({ reason: ln.reason, delta: ln.delta })),
  }));

  const { facts, overview } = assembleInsightFacts({ periodLabel: period.label, projects, runs, config: insightsConfig() });
  const { interpretation, note, error } = await interpretInsights(facts, period.label);
  return {
    periodLabel: period.label,
    facts,
    overview,
    llmAvailable: interpretation != null,
    interpretation,
    interpretationNote: note,
    llmError: error,
  };
}

function eventsEconomics(start: string, end: string): EventEconomics[] {
  const bookings = getBookingsInRange(start, end);
  const costs = getEventDirectCosts(bookings.map((b) => b.bookingId));
  return bookings.map((b) => {
    const c = costs.get(b.bookingId);
    // Labor is shown whether ACTUAL or ESTIMATED (planned/derived split) — but the status travels with it
    // so the UI never presents an estimate as an actual. Contribution inherits the labor's status.
    const labor = c && (c.laborStatus === "ACTUAL" || c.laborStatus === "ESTIMATED") ? c.labor : null;
    const contribution = b.grandTotal != null && labor != null ? Math.round((b.grandTotal - labor) * 100) / 100 : null;
    return {
      eventId: b.bookingId,
      date: b.eventDate ?? "",
      label: b.eventName || `Booking ${b.bookingId}`,
      revenue: b.grandTotal,
      revenueStatus: b.signed ? "SIGNED" : "QUOTE",
      labor,
      laborStatus: c?.laborStatus ?? "NONE",
      internalLabor: c?.internal ?? null,
      tempLabor: c?.temp ?? null,
      method: c?.method ?? null,
      confidence: c?.confidence ?? null,
      contribution,
      contribStatus: contribution == null ? "UNAVAILABLE" : c?.laborStatus === "ACTUAL" ? "ACTUAL" : "ESTIMATED",
    };
  });
}

function sumMap(m: Map<number, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

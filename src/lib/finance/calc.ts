// Financial Intelligence (MVP3) — deterministic calculation core. Pure, tested, no DB/AI.
// RULES CALCULATE — this layer never invents a number. Every figure carries a STATUS so the
// UI can distinguish a real value from "we can't compute this yet".

/** What a number represents — never blur these (a quote is not revenue, a plan is not actual). */
export type MoneyStatus = "ACTUAL" | "SIGNED" | "SCHEDULED" | "PLANNED" | "PROJECTED" | "ESTIMATED" | "UNAVAILABLE";

/** Which direction is "good" for a metric — variance color/meaning depends on this, not on sign. */
export type MetricKind = "revenue" | "cost" | "profit";

export interface Variance {
  plan: number | null;
  actual: number | null;
  /** actual − plan, or null when either side is unavailable. */
  variance: number | null;
  /** (actual − plan) / |plan|, or null when plan is 0/absent (no fake precision). */
  variancePct: number | null;
  /** True = the variance is GOOD for the business (revenue/profit up, or cost down). */
  favorable: boolean | null;
}

/** Compute a plan/actual variance with FINANCIAL meaning (not raw math sign). */
export function computeVariance(plan: number | null, actual: number | null, kind: MetricKind): Variance {
  if (plan == null || actual == null) {
    return { plan, actual, variance: null, variancePct: null, favorable: null };
  }
  const variance = round2(actual - plan);
  const variancePct = plan === 0 ? null : round4(variance / Math.abs(plan));
  // Revenue/profit: higher is good. Cost/expense: lower is good.
  const favorable = variance === 0 ? true : kind === "cost" ? variance < 0 : variance > 0;
  return { plan, actual, variance, variancePct, favorable };
}

export interface LaborLine {
  plannedHours: number | null;
  actualHours: number | null;
  /** Applicable pay rate ($/hr). Null when no rate is on file → costs become unavailable. */
  rate: number | null;
  plannedCost: number | null;
  actualCost: number | null;
  costVariance: Variance;
  hoursVariance: Variance;
  status: MoneyStatus;
}

/**
 * Labor line for one employee/role/day. Never guesses a rate: if `rate` is null the COSTS are
 * unavailable (only the hours variance is computed).
 */
export function laborLine(plannedHours: number | null, actualHours: number | null, rate: number | null): LaborLine {
  const plannedCost = rate != null && plannedHours != null ? round2(plannedHours * rate) : null;
  const actualCost = rate != null && actualHours != null ? round2(actualHours * rate) : null;
  return {
    plannedHours,
    actualHours,
    rate,
    plannedCost,
    actualCost,
    costVariance: computeVariance(plannedCost, actualCost, "cost"),
    hoursVariance: computeVariance(plannedHours, actualHours, "cost"),
    status: rate == null ? "UNAVAILABLE" : actualHours != null ? "ACTUAL" : "PLANNED",
  };
}

/** Labor cost as a % of revenue, or null when either side is missing (no fake ratio). */
export function laborPctOfRevenue(laborCost: number | null, revenue: number | null): number | null {
  if (laborCost == null || revenue == null || revenue === 0) return null;
  return round4(laborCost / revenue);
}

/** Contribution profit = revenue − direct costs. Unavailable if EITHER side is unknown — an unknown
 *  cost is NOT zero. (Zeroing a missing cost yields a fake 100%-margin figure; forbidden.) */
export function contribution(revenue: number | null, directCosts: number | null): number | null {
  if (revenue == null || directCosts == null) return null;
  return round2(revenue - directCosts);
}

/** Contribution margin % = contribution / revenue. Null when revenue is 0/unknown or costs unknown. */
export function contributionMargin(revenue: number | null, directCosts: number | null): number | null {
  if (revenue == null || revenue === 0 || directCosts == null) return null;
  const c = contribution(revenue, directCosts);
  return c == null ? null : round4(c / revenue);
}

/** Sum a list of possibly-null numbers; returns null only when EVERY input is null (all-unknown). */
export function sumKnown(values: (number | null | undefined)[]): number | null {
  const known = values.filter((v): v is number => typeof v === "number");
  if (known.length === 0) return null;
  return round2(known.reduce((a, b) => a + b, 0));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// Financial Intelligence — configurable targets & thresholds. NOT hard-coded through the
// codebase: one place, env-overridable (later movable to /admin). A target that isn't set
// reads back as null so the UI can show "TARGET NOT CONFIGURED" instead of inventing one.

function numEnv(key: string): number | null {
  const v = process.env[key];
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface FinanceConfig {
  /** Weekly signed-revenue target ($). Default 10000 (Zoe's stated target); override via env. */
  weeklyRevenueTarget: number | null;
  /** Target contribution margin (0-1), or null = not configured. */
  targetContributionMarginPct: number | null;
  /** Alert when revenue is this fraction below plan (default 10%). */
  revenueVarianceAlertPct: number;
  /** Alert when labor cost is this fraction above plan (default 10%). */
  laborVarianceAlertPct: number;
}

export function financeConfig(): FinanceConfig {
  return {
    weeklyRevenueTarget: numEnv("FINANCE_WEEKLY_REVENUE_TARGET") ?? 10000,
    targetContributionMarginPct: numEnv("FINANCE_TARGET_MARGIN_PCT"), // null until Zoe sets a real one
    revenueVarianceAlertPct: numEnv("FINANCE_REVENUE_ALERT_PCT") ?? 0.1,
    laborVarianceAlertPct: numEnv("FINANCE_LABOR_ALERT_PCT") ?? 0.1,
  };
}

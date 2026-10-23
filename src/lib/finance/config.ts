// Financial Intelligence — configurable targets & thresholds. NOT hard-coded through the
// codebase: one place, env-overridable (later movable to /admin). A target that isn't set
// reads back as null so the UI can show "TARGET NOT CONFIGURED" instead of inventing one.

import { getDb } from "@/lib/db";
import { DEFAULT_OPS_CYCLE, type OpsCycleConfig } from "./periods";

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
  /** Revenue older than this many hours is "stale" (Goodshuffle is pulled ~once/day). Drives the
   *  PROVISIONAL state on the per-project profitability snapshot. Default 36h; override via env. */
  revenueStaleHours: number;
}

export function financeConfig(): FinanceConfig {
  return {
    weeklyRevenueTarget: numEnv("FINANCE_WEEKLY_REVENUE_TARGET") ?? 10000,
    targetContributionMarginPct: numEnv("FINANCE_TARGET_MARGIN_PCT"), // null until Zoe sets a real one
    revenueVarianceAlertPct: numEnv("FINANCE_REVENUE_ALERT_PCT") ?? 0.1,
    laborVarianceAlertPct: numEnv("FINANCE_LABOR_ALERT_PCT") ?? 0.1,
    revenueStaleHours: numEnv("FINANCE_REVENUE_STALE_HOURS") ?? 36,
  };
}

// ── Operational-cycle config (dimension B) — settings KV, env fallback, hard default Thu/6 ──────────
const OPS_CYCLE_KEY = "finance.opsCycle";

/** The operational cycle (anchor day + length). Override order: settings-KV row → env → default Thu/6.
 *  CONFIGURABLE so Zoe can change the anchor/length without a deploy (the single biggest open decision
 *  in the design doc; defaulted to the confirmed Thu→Tue). */
export function opsCycleConfig(): OpsCycleConfig {
  const envDow = numEnv("FINANCE_OPS_CYCLE_ANCHOR_DOW");
  const envLen = numEnv("FINANCE_OPS_CYCLE_LENGTH");
  let anchorDow = envDow ?? DEFAULT_OPS_CYCLE.anchorDow;
  let lengthDays = envLen ?? DEFAULT_OPS_CYCLE.lengthDays;
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(OPS_CYCLE_KEY) as { value: string } | undefined;
    if (row) {
      const stored = JSON.parse(row.value) as Partial<OpsCycleConfig>;
      if (typeof stored.anchorDow === "number") anchorDow = stored.anchorDow;
      if (typeof stored.lengthDays === "number") lengthDays = stored.lengthDays;
    }
  } catch {
    /* fall back to env/default */
  }
  // Clamp to valid ranges (never let a bad stored value break period math).
  anchorDow = ((Math.round(anchorDow) % 7) + 7) % 7;
  lengthDays = Math.min(14, Math.max(1, Math.round(lengthDays)));
  return { anchorDow, lengthDays };
}

/** Persist a new operational-cycle config into the settings KV (team-editable, no deploy). */
export function saveOpsCycleConfig(cfg: OpsCycleConfig): void {
  const anchorDow = ((Math.round(cfg.anchorDow) % 7) + 7) % 7;
  const lengthDays = Math.min(14, Math.max(1, Math.round(cfg.lengthDays)));
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(OPS_CYCLE_KEY, JSON.stringify({ anchorDow, lengthDays } satisfies OpsCycleConfig), new Date().toISOString());
}

// ── Labor-attribution config (FI-Phase 1–4) — the carve-off/weighting knobs for laborAttribution.ts ─
export interface LaborAttributionConfig {
  /** Fraction of the customer-attributable window modeled as inter-stop TRAVEL at planned grain (L3).
   *  Labeled ESTIMATED; NOT a real measured travel cost until actual on-stop time exists (FI-Phase 6). */
  travelFractionL3: number;
  /** Carve the route's load+return buffer hours into the WAREHOUSE bucket (recommended). */
  warehouseFromBuffers: boolean;
  /** Weight the customer per-project split by each stop's line-item count (a 40x60 tent > a single table). */
  loadWeightByItems: boolean;
  /** Load/return buffer minutes — reuse the risk config so there is one source (never a magic number). */
  loadBufferMin: number;
  returnBufferMin: number;
}

export function laborAttributionConfig(): LaborAttributionConfig {
  return {
    travelFractionL3: numEnv("FINANCE_TRAVEL_FRACTION_L3") ?? 0.2,
    warehouseFromBuffers: (process.env.FINANCE_WAREHOUSE_FROM_BUFFERS ?? "1") !== "0",
    loadWeightByItems: (process.env.FINANCE_LOAD_WEIGHT_BY_ITEMS ?? "0") === "1",
    loadBufferMin: numEnv("FINANCE_LOAD_BUFFER_MIN") ?? 60,
    returnBufferMin: numEnv("FINANCE_RETURN_BUFFER_MIN") ?? 60,
  };
}

// ── Cost-families config (FI Stage 5) — the knobs for the non-labor derived estimators (costFamilies.ts).
//    No magic numbers: transport is distance × a cost-per-mile, overtime premium is a fraction of the base
//    rate. A knob set to 0 cleanly DISABLES its family (the estimator emits nothing → UNAVAILABLE, not 0).
export interface CostFamiliesConfig {
  /** Dollars of fuel + vehicle wear per driven mile — the basis for the transport/fuel ESTIMATE (G6) and
   *  the extra-trip cost (G7). This is a COST per mile, NOT the customer delivery price. Default $0.70/mi
   *  (a common blended fuel+maintenance figure for a box truck); override via env. 0 disables transport. */
  transportCostPerMile: number;
  /** Premium fraction of the base rate for overtime (G8). 0.5 = the +50% of time-and-a-half (the premium
   *  DELTA only; base hours are already costed by the cascade). Default 0.5; override via env. */
  overtimePremiumMultiplier: number;
  /** Master switch for the derived families recompute in the scan tick (geocoding + writes). Default on;
   *  set FINANCE_COST_FAMILIES=0 to turn the whole Stage-5 derived recompute off. */
  derivedEnabled: boolean;
}

export function costFamiliesConfig(): CostFamiliesConfig {
  return {
    transportCostPerMile: numEnv("FINANCE_TRANSPORT_COST_PER_MILE") ?? 0.7,
    overtimePremiumMultiplier: numEnv("FINANCE_OVERTIME_PREMIUM_MULT") ?? 0.5,
    derivedEnabled: (process.env.FINANCE_COST_FAMILIES ?? "1") !== "0",
  };
}

// ── Visit-reconciliation config (FI Stage 4) — GPS visit + dispatch two-evidence layer (audit §5.2).
//    No magic numbers: the geofence radius, poll cadence and discrepancy tolerance are all one place,
//    env-overridable (later movable to /admin like the ops-cycle knob). These knobs NEVER touch the
//    money-allocation math — they only decide WHEN we poll, WHERE a fix counts as "on site", and WHEN
//    two clocks are treated as agreeing.
export interface VisitReconcileConfig {
  /** Radius (metres) around a stop's geocoded address within which a GPS fix counts as "on site".
   *  Default 150 m (a venue parking lot / loading area); override via env. */
  geofenceRadiusM: number;
  /** Minimum seconds between stored GPS fixes PER VEHICLE — the poll cadence. Keeps us well under the
   *  provider's daily quota (eta/zonar.ts) however often the runtime tick fires. Default 300 s (5 min). */
  gpsPollSeconds: number;
  /** Tolerance (minutes) within which the GPS on-site enter and the dispatch arrived time are treated
   *  as AGREEING. Beyond it the visit is flagged for review (dispatch kept as the labeled default).
   *  Default 15 min. */
  visitDiscrepancyMinutes: number;
  /** Master switch for the Stage-4 visit layer (polling + geofence recompute). Default on; set
   *  FINANCE_VISIT_RECONCILE=0 to disable the whole layer (the ACTUAL_STOP feed then never fires). */
  enabled: boolean;
}

export function visitReconcileConfig(): VisitReconcileConfig {
  return {
    geofenceRadiusM: numEnv("FINANCE_GEOFENCE_RADIUS_M") ?? 150,
    gpsPollSeconds: numEnv("FINANCE_GPS_POLL_SECONDS") ?? 300,
    visitDiscrepancyMinutes: numEnv("FINANCE_VISIT_DISCREPANCY_MIN") ?? 15,
    enabled: (process.env.FINANCE_VISIT_RECONCILE ?? "1") !== "0",
  };
}

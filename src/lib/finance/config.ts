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

// ── Reconciliation-run config (FI Stage 7a) — the durable snapshot→revision→final lifecycle that records
//    how a project's profitability settled as late data arrived. The run itself invents nothing (it stores
//    the already-computed snapshot + the current−prior variance); the only knob is the master switch for the
//    recompute in the scan tick. Append-only + sig-deduped, so leaving it on is cheap (a run is written only
//    when the figures actually moved).
export interface ReconciliationRunsConfig {
  /** Master switch for producing reconciliation runs on the scan tick. Default on; set
   *  FINANCE_RECONCILIATION_RUNS=0 to disable the whole Stage-7a lifecycle recompute. */
  enabled: boolean;
}

export function reconciliationRunsConfig(): ReconciliationRunsConfig {
  return {
    enabled: (process.env.FINANCE_RECONCILIATION_RUNS ?? "1") !== "0",
  };
}

// ── Item-intelligence config (FI Stage 6 / audit G5) — the title-keyword → operational-MINUTES map used to
//    infer a PROVISIONAL setup/handling/breakdown time estimate from a project's line-item TITLES. This is
//    an OPERATIONAL-TIME estimate for context only: it NEVER produces a dollar cost and NEVER writes
//    cost_entries (line-item titles carry no price or quantity — audit §2.5). No magic numbers: every
//    minute figure lives here with a documented rationale, env- and settings-KV-overridable like the
//    ops-cycle knob. A keyword set to 0/absent simply adds no extra time (it is not an error).
export interface ItemHandlingRule {
  /** Lower-cased substring matched against each line-item title. */
  keyword: string;
  /** Extra setup/install minutes when a title matches (crew-minutes at the stop, one match per keyword). */
  setupMin: number;
  /** Extra breakdown/strike minutes at the pickup for the same keyword. */
  breakdownMin: number;
}

export interface ItemIntelligenceConfig {
  /** Baseline load+unload handling minutes charged PER captured line-item title, before keyword escalations.
   *  Covers the generic touch of moving one line off/on the truck. Default 5 min/item; override via env. */
  baseMinutesPerItem: number;
  /** The keyword → extra-minutes escalations. Heavier/structural rentals (tents, flooring, staging, drape,
   *  dance floors, lighting, bars) carry materially more setup + breakdown time than a stack of chairs. */
  rules: ItemHandlingRule[];
}

const ITEM_INTEL_KEY = "finance.itemIntelligence";

// Documented defaults (crew-minutes, NOT dollars). Rationale: a 5-minute baseline per line is a light
// off/on-truck touch; the escalations reflect structures that must be built and struck on site. These are
// deliberately conservative, labeled PROVISIONAL at the point of use, and fully overridable — they are a
// starting heuristic, never an authoritative time study.
const DEFAULT_ITEM_BASE_MINUTES = 5;
const DEFAULT_ITEM_RULES: ItemHandlingRule[] = [
  { keyword: "tent", setupMin: 90, breakdownMin: 60 }, // staking/framing + strike is the single biggest driver
  { keyword: "flooring", setupMin: 60, breakdownMin: 45 },
  { keyword: "floor", setupMin: 45, breakdownMin: 30 }, // dance floor / subfloor panels
  { keyword: "stage", setupMin: 60, breakdownMin: 40 },
  { keyword: "staging", setupMin: 60, breakdownMin: 40 },
  { keyword: "drape", setupMin: 40, breakdownMin: 25 }, // pipe-and-drape
  { keyword: "pipe and drape", setupMin: 40, breakdownMin: 25 },
  { keyword: "lighting", setupMin: 30, breakdownMin: 20 },
  { keyword: "bar", setupMin: 20, breakdownMin: 15 },
  { keyword: "lounge", setupMin: 20, breakdownMin: 15 },
  { keyword: "arch", setupMin: 15, breakdownMin: 10 }, // arbor / arch
];

/** The item-intelligence keyword→minutes map. Override order: settings-KV row → env JSON → documented
 *  defaults. A malformed stored/env value is ignored (fall back) — a bad knob never breaks the estimate. */
export function itemIntelligenceConfig(): ItemIntelligenceConfig {
  let baseMinutesPerItem = numEnv("FINANCE_ITEM_BASE_MINUTES") ?? DEFAULT_ITEM_BASE_MINUTES;
  let rules = parseItemRules(process.env.FINANCE_ITEM_RULES_JSON) ?? DEFAULT_ITEM_RULES;
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(ITEM_INTEL_KEY) as { value: string } | undefined;
    if (row) {
      const stored = JSON.parse(row.value) as Partial<ItemIntelligenceConfig>;
      if (typeof stored.baseMinutesPerItem === "number" && Number.isFinite(stored.baseMinutesPerItem)) {
        baseMinutesPerItem = stored.baseMinutesPerItem;
      }
      const storedRules = parseItemRules(JSON.stringify(stored.rules));
      if (storedRules) rules = storedRules;
    }
  } catch {
    /* fall back to env/default */
  }
  baseMinutesPerItem = Math.max(0, baseMinutesPerItem);
  return { baseMinutesPerItem, rules };
}

/** Persist a new item-intelligence map into the settings KV (team-editable, no deploy). */
export function saveItemIntelligenceConfig(cfg: ItemIntelligenceConfig): void {
  const clean: ItemIntelligenceConfig = {
    baseMinutesPerItem: Math.max(0, Number.isFinite(cfg.baseMinutesPerItem) ? cfg.baseMinutesPerItem : DEFAULT_ITEM_BASE_MINUTES),
    rules: (parseItemRules(JSON.stringify(cfg.rules)) ?? DEFAULT_ITEM_RULES),
  };
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(ITEM_INTEL_KEY, JSON.stringify(clean), new Date().toISOString());
}

/** Parse + sanitize a rules array from JSON (env or stored). Returns null on anything malformed so the
 *  caller cleanly falls back; drops individual bad rules but keeps the good ones. */
function parseItemRules(raw: string | null | undefined): ItemHandlingRule[] | null {
  if (raw == null || raw.trim() === "") return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const rules: ItemHandlingRule[] = [];
    for (const r of v) {
      if (r == null || typeof r !== "object") continue;
      const keyword = typeof (r as ItemHandlingRule).keyword === "string" ? (r as ItemHandlingRule).keyword.trim().toLowerCase() : "";
      if (!keyword) continue;
      const setupMin = Number((r as ItemHandlingRule).setupMin);
      const breakdownMin = Number((r as ItemHandlingRule).breakdownMin);
      rules.push({
        keyword,
        setupMin: Number.isFinite(setupMin) ? Math.max(0, setupMin) : 0,
        breakdownMin: Number.isFinite(breakdownMin) ? Math.max(0, breakdownMin) : 0,
      });
    }
    return rules.length > 0 ? rules : null;
  } catch {
    return null;
  }
}

// ── Insights config (FI Stage 7c / audit §6) — the historical-learning layer. The FACTS are computed
//    deterministically from the existing history; the LLM only INTERPRETS them (dormant-safe). The only
//    knobs here are the low-margin threshold used to flag categories and the minimum sample size before a
//    category trend is asserted (below it a category stays labeled THIN, never a confident claim).
export interface InsightsConfig {
  /** A project/category whose contribution margin is at or below this fraction is flagged "low margin".
   *  Defaults to financeConfig().targetContributionMarginPct when that is set, else this floor. Default 0.2. */
  lowMarginPct: number;
  /** Minimum number of margin-bearing projects in a category before its trend is asserted (not THIN). Default 3. */
  minCategorySample: number;
}

export function insightsConfig(): InsightsConfig {
  return {
    lowMarginPct: numEnv("FINANCE_LOW_MARGIN_PCT") ?? financeConfig().targetContributionMarginPct ?? 0.2,
    minCategorySample: Math.max(1, Math.round(numEnv("FINANCE_INSIGHTS_MIN_SAMPLE") ?? 3)),
  };
}

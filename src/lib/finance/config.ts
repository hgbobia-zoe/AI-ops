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
}

export function financeConfig(): FinanceConfig {
  return {
    weeklyRevenueTarget: numEnv("FINANCE_WEEKLY_REVENUE_TARGET") ?? 10000,
    targetContributionMarginPct: numEnv("FINANCE_TARGET_MARGIN_PCT"), // null until Zoe sets a real one
    revenueVarianceAlertPct: numEnv("FINANCE_REVENUE_ALERT_PCT") ?? 0.1,
    laborVarianceAlertPct: numEnv("FINANCE_LABOR_ALERT_PCT") ?? 0.1,
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

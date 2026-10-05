// Delivery pricing config — the team-editable, no-deploy layer for the delivery formula + route engine.
// Mirrors src/lib/finance/config.ts: a sensible DEFAULT (code + env) with an optional JSON OVERRIDE in the
// `settings` table (key "pricing.delivery"), so the app behaves exactly as today until someone edits it in
// /admin. Server-only (touches the DB via better-sqlite3); the pure formula/route engines READ this config
// and never hard-code constants.

import { getDb } from "@/lib/db";
import { DEFAULT_DELIVERY_FORMULA, type DeliveryFormulaConfig, type MileageTier } from "./delivery";

/** The full config: the pure formula inputs + the route-engine knobs. */
export interface PricingConfig extends DeliveryFormulaConfig {
  /** How far (driving miles) the new stop may be from an anchor to be route-eligible. */
  routeRadiusMiles: number;
  /** How many extra drive-minutes an insertion may add before it's deemed schedule-infeasible. */
  timingToleranceMinutes: number;
}

function numEnv(key: string): number | null {
  const v = process.env[key];
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The out-of-the-box config: the pure formula defaults + route knobs, with env overrides. */
export function defaultPricingConfig(): PricingConfig {
  return {
    baseFee: numEnv("PRICING_BASE_FEE") ?? DEFAULT_DELIVERY_FORMULA.baseFee,
    mileageTiers: DEFAULT_DELIVERY_FORMULA.mileageTiers.map((t) => ({ ...t })),
    pct: numEnv("PRICING_PCT") ?? DEFAULT_DELIVERY_FORMULA.pct,
    pctCap: numEnv("PRICING_PCT_CAP") ?? DEFAULT_DELIVERY_FORMULA.pctCap,
    routeRadiusMiles: numEnv("PRICING_ROUTE_RADIUS_MILES") ?? 15,
    timingToleranceMinutes: numEnv("PRICING_TIMING_TOLERANCE_MIN") ?? 45,
  };
}

const KEY = "pricing.delivery";

/** Sanitize an arbitrary tier list into a valid, ascending, open-ended-tailed ladder. */
export function sanitizeTiers(raw: unknown, fallback: MileageTier[]): MileageTier[] {
  if (!Array.isArray(raw)) return fallback.map((t) => ({ ...t }));
  const tiers: MileageTier[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const rate = Number(o.ratePerMile);
    if (!Number.isFinite(rate) || rate < 0) continue;
    const upRaw = o.uptoMile;
    const upto = upRaw == null || upRaw === "" ? null : Number(upRaw);
    tiers.push({ uptoMile: upto != null && Number.isFinite(upto) && upto > 0 ? upto : null, ratePerMile: rate });
  }
  if (tiers.length === 0) return fallback.map((t) => ({ ...t }));
  // Order by boundary (open-ended band last), then force the final band open-ended so no mile is uncharged.
  tiers.sort((a, b) => (a.uptoMile ?? Infinity) - (b.uptoMile ?? Infinity));
  tiers[tiers.length - 1] = { ...tiers[tiers.length - 1], uptoMile: null };
  return tiers;
}

function merge(base: PricingConfig, over: Partial<PricingConfig> | null): PricingConfig {
  if (!over) return base;
  const num = (v: unknown, fb: number, min = 0): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : fb;
  };
  return {
    baseFee: num(over.baseFee, base.baseFee),
    mileageTiers: over.mileageTiers !== undefined ? sanitizeTiers(over.mileageTiers, base.mileageTiers) : base.mileageTiers,
    pct: num(over.pct, base.pct),
    pctCap: num(over.pctCap, base.pctCap),
    routeRadiusMiles: num(over.routeRadiusMiles, base.routeRadiusMiles, 0.1),
    timingToleranceMinutes: num(over.timingToleranceMinutes, base.timingToleranceMinutes, 0),
  };
}

/** Current pricing config: DB override merged over the env/code defaults. Never throws (falls back). */
export function pricingConfig(): PricingConfig {
  const base = defaultPricingConfig();
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    if (!row) return base;
    return merge(base, JSON.parse(row.value) as Partial<PricingConfig>);
  } catch {
    return base;
  }
}

/** Persist a (partial) pricing config override. Returns the merged, sanitized, stored config. */
export function savePricingConfig(patch: Partial<PricingConfig>): PricingConfig {
  const next = merge(pricingConfig(), patch);
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(KEY, JSON.stringify(next), new Date().toISOString());
  return next;
}

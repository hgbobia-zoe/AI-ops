// Delivery pricing — the formula behind zoeeventsdmv.com/calculator, now in the ops app so a rep can
// price a run without leaving. Per LEG (drop-off and pick-up are priced INDEPENDENTLY, same formula):
//
//     leg fee = baseFee
//             + distanceCharge(miles)            // TIERED by mile band (config-driven)
//             + min(pct × subtotal, pctCap)      // pct of the FULL pre-discount subtotal, capped, per leg
//
// Setup / strike (Event Readiness) charges are SEPARATE and never folded in here. The delivery TIME
// WINDOW (Standard / Premium / Exact) is its own line item, so the base no longer varies by window.
//
// This module is PURE — no DB, no env, no I/O. The DB-backed, team-editable config lives in
// `src/lib/pricing/config.ts` (a superset of DeliveryFormulaConfig); callers pass it in. Everything here
// falls back to DEFAULT_DELIVERY_FORMULA so tests and config-less callers still work.

/** One band of the tiered mileage charge. Bands are cumulative and ordered ascending by `uptoMile`. */
export interface MileageTier {
  /** Upper mile boundary of this band (inclusive of miles up to it), or null for the open-ended last band. */
  uptoMile: number | null;
  /** Per-mile rate charged for the miles that fall inside this band. */
  ratePerMile: number;
}

/** The pure inputs the leg formula needs. The DB-backed PricingConfig (config.ts) is a superset of this. */
export interface DeliveryFormulaConfig {
  /** Flat base per leg. */
  baseFee: number;
  /** Ordered mile bands (ascending by uptoMile); the final band is open-ended (uptoMile = null). */
  mileageTiers: MileageTier[];
  /** Fraction of the FULL pre-discount subtotal charged per leg (0–1). */
  pct: number;
  /** Dollar cap on the per-leg subtotal fee. */
  pctCap: number;
}

/** The out-of-the-box formula — Zoe's current price list. The config layer overrides these in /admin. */
export const DEFAULT_DELIVERY_FORMULA: DeliveryFormulaConfig = {
  baseFee: 25,
  mileageTiers: [
    { uptoMile: 20, ratePerMile: 2.99 }, // miles 1–20
    { uptoMile: 40, ratePerMile: 1.75 }, // miles 21–40
    { uptoMile: null, ratePerMile: 1.5 }, // miles 41+
  ],
  pct: 0.05, // 5%
  pctCap: 300, // $300 cap per leg
};

// ── Back-compat scalar exports ───────────────────────────────────────────────────────────────────────
// Legacy callers / header copy referenced these constants. They now derive from the default formula; the
// REAL numbers come from the config and flow through the functions below. Kept so imports don't break.
export const BASE = DEFAULT_DELIVERY_FORMULA.baseFee;
export const PER_MILE = DEFAULT_DELIVERY_FORMULA.mileageTiers[0].ratePerMile;
export const SUBTOTAL_PCT = DEFAULT_DELIVERY_FORMULA.pct;

export interface LegBreakdown {
  base: number;
  mileage: number; // tiered distance charge
  subtotalFee: number; // min(pct × subtotal, pctCap)
  subtotalCapped: boolean; // true when the $ cap bit (so the UI can show "capped")
  total: number;
}

export interface DeliveryQuote {
  miles: number; // the BILLABLE one-way distance the legs were priced on
  subtotal: number;
  dropOff: LegBreakdown | null; // null on a pickup-only run
  pickup: LegBreakdown | null; // null on a drop-off-only run
  total: number; // sum of the priced legs
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The tiered mileage charge for a one-way distance. Each band (prevUpto, uptoMile] is charged at its own
 * rate and summed — e.g. with the default tiers a 30-mile leg = 20×2.99 + 10×1.75 = 77.30. Negative or
 * NaN miles floor at 0. If the tiers somehow don't cover every mile (no open-ended band), the leftover is
 * charged at the last band's rate rather than silently dropped.
 */
export function distanceCharge(miles: number, tiers: MileageTier[]): number {
  let remaining = Math.max(0, miles || 0);
  if (remaining === 0 || tiers.length === 0) return 0;
  let prevUpper = 0;
  let charge = 0;
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const upper = tier.uptoMile == null ? Infinity : tier.uptoMile;
    const bandWidth = Math.max(0, upper - prevUpper);
    const milesInBand = Math.min(remaining, bandWidth);
    charge += milesInBand * tier.ratePerMile;
    remaining -= milesInBand;
    prevUpper = upper;
  }
  // Misconfigured tiers (all finite, miles beyond the last boundary): charge the overflow at the last rate.
  if (remaining > 0) charge += remaining * tiers[tiers.length - 1].ratePerMile;
  return round2(charge);
}

/** One leg's fee, itemized. `miles` is the one-way (or incremental) distance; `subtotal` is pre-discount. */
export function deliveryLegFee(
  miles: number,
  subtotal: number,
  cfg: DeliveryFormulaConfig = DEFAULT_DELIVERY_FORMULA,
): LegBreakdown {
  const s = Math.max(0, subtotal || 0);
  const mileage = distanceCharge(miles, cfg.mileageTiers);
  const rawPct = s * cfg.pct;
  const subtotalCapped = rawPct > cfg.pctCap;
  const subtotalFee = round2(Math.min(rawPct, cfg.pctCap));
  return {
    base: cfg.baseFee,
    mileage,
    subtotalFee,
    subtotalCapped,
    total: round2(cfg.baseFee + mileage + subtotalFee),
  };
}

export type LegMode = "round_trip" | "drop_off" | "pickup";

/** Price a run. round_trip = both legs (delivery + pickup); drop_off / pickup = a single one-way leg. */
export function deliveryQuote(
  miles: number,
  subtotal: number,
  mode: LegMode = "round_trip",
  cfg: DeliveryFormulaConfig = DEFAULT_DELIVERY_FORMULA,
): DeliveryQuote {
  const leg = deliveryLegFee(miles, subtotal, cfg);
  const dropOff = mode === "pickup" ? null : leg;
  const pickup = mode === "drop_off" ? null : leg;
  const total = round2((dropOff?.total ?? 0) + (pickup?.total ?? 0));
  return { miles: round2(Math.max(0, miles || 0)), subtotal: Math.max(0, subtotal || 0), dropOff, pickup, total };
}

export const metersToMiles = (meters: number): number => meters / 1609.344;

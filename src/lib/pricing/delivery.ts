// Delivery pricing — the formula behind zoeeventsdmv.com/calculator, now in the ops app so a rep can
// price a run without leaving. Per LEG (drop-off and pick-up are priced separately, same formula):
//
//     leg fee = BASE + (one-way miles × PER_MILE) + (quote subtotal before discount × SUBTOTAL_PCT)
//
// BASE is a flat $25 now that the delivery TIME WINDOW (Standard / Premium / Exact) is its own line item,
// so the base no longer varies by window. Subtotal is the rental subtotal BEFORE any discount.

export const BASE = 25; // flat base per leg
export const PER_MILE = 2.99; // one-way mileage rate
export const SUBTOTAL_PCT = 0.05; // 5% of the pre-discount subtotal, per leg

export interface LegBreakdown {
  base: number;
  mileage: number; // miles × PER_MILE
  subtotalFee: number; // subtotal × SUBTOTAL_PCT
  total: number;
}

export interface DeliveryQuote {
  miles: number;
  subtotal: number;
  dropOff: LegBreakdown | null; // null on a pickup-only run
  pickup: LegBreakdown | null; // null on a drop-off-only run
  total: number; // sum of the priced legs
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** One leg's fee, itemized. `miles` is the one-way warehouse↔venue distance; `subtotal` is pre-discount. */
export function deliveryLegFee(miles: number, subtotal: number): LegBreakdown {
  const m = Math.max(0, miles || 0);
  const s = Math.max(0, subtotal || 0);
  const mileage = round2(m * PER_MILE);
  const subtotalFee = round2(s * SUBTOTAL_PCT);
  return { base: BASE, mileage, subtotalFee, total: round2(BASE + mileage + subtotalFee) };
}

export type LegMode = "round_trip" | "drop_off" | "pickup";

/** Price a run. round_trip = both legs (delivery + pickup); drop_off / pickup = a single one-way leg. */
export function deliveryQuote(miles: number, subtotal: number, mode: LegMode = "round_trip"): DeliveryQuote {
  const leg = deliveryLegFee(miles, subtotal);
  const dropOff = mode === "pickup" ? null : leg;
  const pickup = mode === "drop_off" ? null : leg;
  const total = round2((dropOff?.total ?? 0) + (pickup?.total ?? 0));
  return { miles: round2(Math.max(0, miles || 0)), subtotal: Math.max(0, subtotal || 0), dropOff, pickup, total };
}

export const metersToMiles = (meters: number): number => meters / 1609.344;

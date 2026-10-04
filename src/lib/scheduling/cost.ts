// Staffing COST — the deterministic economics layer for the scheduling board. Pure + unit-testable
// like coverage.ts. Wires the already-present rate sources (Connecteam getPayRates/rateForUserOn for
// internal, InstaworkShift.basePrice for temp) into worker hours x rate, and rolls them up into the
// TEMP EXPOSURE metric the dispatcher needs (count, hours, cost, % of labor hours, premium vs internal).
//
// HONESTY (the house law): where a worker/gig has NO rate or NO known window, the figure is null
// ("rate unknown" / "window unknown") and that seat is EXCLUDED from cost totals — never fabricated to
// 0 and never given an invented premium. Hours use the shift/gig window; an unknown window yields null.

import type { PayRate } from "@/lib/connecteam";
import { rateForUserOn } from "@/lib/connecteam";
import type { InstaworkShift } from "@/lib/instawork/types";

const MS_PER_HOUR = 3_600_000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Hours between two ISO instants, or null if either is missing/invalid or the span is non-positive. */
function hoursBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
  return round2((e - s) / MS_PER_HOUR);
}

/** Hours a shift window represents. Null when the window isn't known (never fabricated). */
export function shiftWindowHours(s: { startTime: string | null; endTime: string | null; windowKnown: boolean }): number | null {
  if (!s.windowKnown) return null;
  return hoursBetween(s.startTime, s.endTime);
}

/** Hours an Instawork gig window represents. Null when the window can't be parsed. */
export function gigWindowHours(gig: Pick<InstaworkShift, "startsAt" | "endsAt">): number | null {
  return hoursBetween(gig.startsAt, gig.endsAt);
}

/** The internal $/h applicable to a user on a date (Connecteam pay rates). Null = unknown (not 0). */
export function internalRateFor(rates: Map<number, PayRate[]>, userId: number, date: string): number | null {
  return rateForUserOn(rates, userId, date);
}

/** A single labor seat (one person on one shift/gig) reduced to the cost primitives. */
export interface LaborSeat {
  kind: "internal" | "temp";
  hours: number | null; // from the shift/gig window
  rate: number | null; // $/h when known (internal: rateForUserOn; temp: basePrice/hours when derivable)
  cost: number | null; // internal: hours*rate; temp: basePrice (captured dollars); null when unknown
}

/** Build an internal seat from a worker's shift window + Connecteam rate. */
export function internalSeat(hours: number | null, rate: number | null): LaborSeat {
  const cost = hours != null && rate != null ? round2(hours * rate) : null;
  return { kind: "internal", hours, rate, cost };
}

/** Build a temp seat from a gig's base price + window. basePrice is the captured per-seat dollar figure
 *  (per-gig vs per-hour is unconfirmed upstream, so it is used as the seat cost and a per-hour rate is
 *  derived only when the window is known). A null basePrice is "rate unknown", excluded from totals. */
export function tempSeat(hours: number | null, basePrice: number | null): LaborSeat {
  const rate = basePrice != null && hours != null && hours > 0 ? round2(basePrice / hours) : null;
  return { kind: "temp", hours, rate, cost: basePrice ?? null };
}

/** The day's temp-exposure + labor economics. Every money/hours figure is null when unknown. */
export interface TempExposure {
  internalCount: number;
  internalHours: number | null;
  internalCost: number | null;
  tempCount: number;
  tempHours: number | null;
  tempCost: number | null;
  totalLaborHours: number | null;
  /** tempHours / totalLaborHours (0..1), null when hours unknown. */
  tempHourShare: number | null;
  avgInternalRate: number | null;
  avgTempRate: number | null;
  /** avgTempRate / avgInternalRate — the MEASURED premium multiplier (null unless both sides known). */
  tempPremiumMultiplier: number | null;
  /** tempHours costed at the internal average rate (the "what it would cost internally"). */
  equivalentInternalCost: number | null;
  /** tempCost - equivalentInternalCost = the premium paid to use temps (null when either side unknown). */
  incrementalTempCost: number | null;
  /** Seats excluded from cost totals because rate/cost was unknown (surfaced for honesty). */
  rateUnknownSeats: number;
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v != null);
  return known.length > 0 ? round2(known.reduce((a, b) => a + b, 0)) : null;
}

/**
 * Roll a day's labor seats into the temp-exposure metric. Counts are headcount facts (every seat of a
 * kind counts); hours/cost sum only KNOWN values; averages/premium are computed only from seats whose
 * hours AND cost are both known. Nothing is fabricated: an unknown stays null, excluded, never 0.
 */
export function computeTempExposure(seats: LaborSeat[]): TempExposure {
  const internal = seats.filter((s) => s.kind === "internal");
  const temp = seats.filter((s) => s.kind === "temp");

  const internalHours = sumKnown(internal.map((s) => s.hours));
  const internalCost = sumKnown(internal.map((s) => s.cost));
  const tempHours = sumKnown(temp.map((s) => s.hours));
  const tempCost = sumKnown(temp.map((s) => s.cost));

  const totalLaborHours =
    internalHours != null || tempHours != null ? round2((internalHours ?? 0) + (tempHours ?? 0)) : null;
  const tempHourShare =
    tempHours != null && totalLaborHours != null && totalLaborHours > 0
      ? Math.round((tempHours / totalLaborHours) * 10000) / 10000
      : null;

  // Averages from seats with BOTH hours and cost known (so a rate-unknown seat never skews the mean).
  const internalPriced = internal.filter((s) => s.hours != null && s.cost != null);
  const tempPriced = temp.filter((s) => s.hours != null && s.cost != null);
  const internalPricedHours = sumKnown(internalPriced.map((s) => s.hours));
  const internalPricedCost = sumKnown(internalPriced.map((s) => s.cost));
  const tempPricedHours = sumKnown(tempPriced.map((s) => s.hours));
  const tempPricedCost = sumKnown(tempPriced.map((s) => s.cost));

  const avgInternalRate =
    internalPricedHours != null && internalPricedCost != null && internalPricedHours > 0
      ? round2(internalPricedCost / internalPricedHours)
      : null;
  const avgTempRate =
    tempPricedHours != null && tempPricedCost != null && tempPricedHours > 0
      ? round2(tempPricedCost / tempPricedHours)
      : null;
  const tempPremiumMultiplier =
    avgInternalRate != null && avgTempRate != null && avgInternalRate > 0 ? round2(avgTempRate / avgInternalRate) : null;

  // Incremental cost compares the SAME temp hours costed at the internal average rate.
  const equivalentInternalCost =
    tempHours != null && avgInternalRate != null ? round2(tempHours * avgInternalRate) : null;
  const incrementalTempCost =
    tempCost != null && equivalentInternalCost != null ? round2(tempCost - equivalentInternalCost) : null;

  const rateUnknownSeats = seats.filter((s) => s.cost == null).length;

  return {
    internalCount: internal.length,
    internalHours,
    internalCost,
    tempCount: temp.length,
    tempHours,
    tempCost,
    totalLaborHours,
    tempHourShare,
    avgInternalRate,
    avgTempRate,
    tempPremiumMultiplier,
    equivalentInternalCost,
    incrementalTempCost,
    rateUnknownSeats,
  };
}

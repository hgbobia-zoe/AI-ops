// Route-aware delivery quote. Staff-session-gated (not public; the proxy requires a valid session). Given
// a venue (address to geocode, or manual miles) + the delivery date + the pickup date + the pre-discount
// subtotal + the leg mode, it:
//   1. geocodes the venue and computes the one-way warehouse to venue driving distance (cached, bounded),
//   2. for EACH leg, on that leg's own date (drop-off on the delivery date, pickup on the pickup date),
//      gathers the CONFIRMED scheduled stops: ONLY jobs already on a route (real stops with a precise
//      address + window + truck). A signed-but-unrouted booking is NEVER used: we do not assume a booking
//      has a delivery (guessing wrong mis-prices a real quote and costs money),
//   3. runs the DETERMINISTIC route optimizer (STANDARD / ROUTE_OPTIMIZED / DEDICATED) per leg to pick
//      that leg's billable distance, and
//   4. prices each leg on its own billable miles with the team-editable pricing config.
// RULES CALCULATE: no LLM in the price path. Returns the full per-leg breakdown so the UI (or an AI) can
// explain it; unknowns (geocode/route failures, unknown anchor windows) are surfaced, never invented.

import { NextResponse } from "next/server";
import { geocode, driveTime, type LatLng } from "@/lib/eta/geo";
import { WAREHOUSE_COORDS, WAREHOUSE_ADDRESS, pricingDeparture } from "@/lib/pricing/warehouse";
import { pricingConfig } from "@/lib/pricing/config";
import { deliveryQuoteLegs, metersToMiles, pushPerLeg, type LegBreakdown, type LegMode } from "@/lib/pricing/delivery";
import { buildDistanceFn } from "@/lib/pricing/routeDistance";
import { routeOptimize, neededPairs, haversineMiles, type RouteAnchor, type RouteOptimizeResult } from "@/lib/pricing/routeOptimize";
import { looksCityLevel } from "@/lib/pricing/address";
import { getStopsOnDate } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

const MODES: LegMode[] = ["round_trip", "drop_off", "pickup"];
/** Bound geocodes + routing pairs per leg: at most this many routes (nearest first) are checked. Every stop
 *  of a checked route is kept, so its real sequence is priced, never a shortened one. */
const ROUTE_CAP = 6;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

interface Body {
  address?: string;
  miles?: number; // one-way miles: the fallback when geocoding fails, or the price basis when milesOverride
  milesOverride?: boolean; // the rep typed the miles by hand: they win over the geocoded distance
  eventDate?: string; // YYYY-MM-DD, the delivery (drop-off) date
  pickupDate?: string; // YYYY-MM-DD, the pickup date (defaults to the delivery date)
  subtotal?: number;
  mode?: LegMode;
  projectId?: string; // the quote's own project, excluded from its own anchor set
}

type LegKey = "dropOff" | "pickup";

interface LegResult {
  leg: LegKey;
  date: string | null;
  pricingMode: RouteOptimizeResult["mode"];
  warehouseMiles: number;
  billableMiles: number;
  incrementalMiles: number | null;
  savingsMiles: number | null;
  anchor: RouteOptimizeResult["anchor"];
  anchorsConsidered: number;
  reasons: string[];
  anchorNote: string | null;
  fee: LegBreakdown;
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const cfg = pricingConfig();
  const subtotal = Math.max(0, Number(body.subtotal) || 0);
  const mode: LegMode = MODES.includes(body.mode as LegMode) ? (body.mode as LegMode) : "round_trip";
  const address = (body.address ?? "").trim();
  const manualMiles =
    body.miles != null && Number.isFinite(Number(body.miles)) && Number(body.miles) >= 0 ? Number(body.miles) : null;
  const milesOverride = body.milesOverride === true && manualMiles != null;
  const eventDate = YMD.test((body.eventDate ?? "").trim()) ? (body.eventDate ?? "").trim() : "";
  const pickupDate = YMD.test((body.pickupDate ?? "").trim()) ? (body.pickupDate ?? "").trim() : eventDate;

  const formula = { baseFee: cfg.baseFee, mileageTiers: cfg.mileageTiers, pct: cfg.pct, pctCap: cfg.pctCap };
  const base = {
    formula,
    radiusMiles: cfg.routeRadiusMiles,
    toleranceMinutes: cfg.timingToleranceMinutes,
    warehouseAddress: WAREHOUSE_ADDRESS,
    mode,
    subtotal,
  };

  // Resolve the venue + one-way warehouse miles. Typed miles win when the rep overrode them; otherwise
  // prefer a geocoded address and fall back to manual miles.
  let venue: LatLng | null = null;
  let warehouseMiles: number | null = null;
  let distanceSource: "geocoded" | "manual" | "unresolved" = "unresolved";
  const warnings: string[] = [];

  if (milesOverride) {
    warehouseMiles = manualMiles;
    distanceSource = "manual";
  } else if (address) {
    venue = await geocode(address);
    if (venue) {
      const drive = await driveTime(WAREHOUSE_COORDS, venue, { departAt: pricingDeparture() });
      if (drive?.meters != null) {
        warehouseMiles = Math.round(metersToMiles(drive.meters) * 10) / 10;
        distanceSource = "geocoded";
      }
    }
    if (warehouseMiles == null) venue = null;
  }
  if (warehouseMiles == null && manualMiles != null) {
    warehouseMiles = manualMiles;
    distanceSource = "manual";
    venue = null; // no coords, so route optimization isn't possible: price STANDARD
  }

  if (warehouseMiles == null) {
    // Couldn't resolve a distance and no manual miles given: be honest, let the rep type miles by hand.
    return NextResponse.json({
      ok: true,
      resolved: false,
      distanceSource: "unresolved",
      note: address ? "Couldn't find that address. Type the miles in by hand." : "Enter an address or the miles to price this run.",
      ...base,
    });
  }

  const addressPrecision: "street" | "city" | null = distanceSource === "geocoded" ? (looksCityLevel(address) ? "city" : "street") : null;
  if (addressPrecision === "city") {
    warnings.push("This address has no street number, so the miles are to the town center, not the venue. Add the street address for exact miles.");
  }

  const whMiles = warehouseMiles;
  const standard = (reasons: string[]): RouteOptimizeResult => {
    const r = routeOptimize({
      venue: venue ?? WAREHOUSE_COORDS,
      warehouse: WAREHOUSE_COORDS,
      warehouseMiles: whMiles,
      anchors: [],
      dist: () => ({ miles: 0, minutes: 0 }),
      routeRadiusMiles: cfg.routeRadiusMiles,
      timingToleranceMinutes: cfg.timingToleranceMinutes,
      mode,
    });
    r.reasons = reasons;
    return r;
  };

  // One optimize run per distinct date (a same-day pickup reuses the drop-off's result).
  const byDate = new Map<string, { optimize: RouteOptimizeResult; anchorNote: string | null }>();
  async function optimizeForDate(date: string): Promise<{ optimize: RouteOptimizeResult; anchorNote: string | null }> {
    if (!venue) {
      const why = milesOverride
        ? `Priced on the ${whMiles} mi you typed, as a standalone trip. Clear the miles to price from the address and check for a shared route.`
        : "No venue location, so shared routes can't be checked. Priced as a standalone trip.";
      return { optimize: standard([why]), anchorNote: null };
    }
    if (!date) {
      return { optimize: standard(["No date given, so same-day routes can't be found. Priced as a standalone trip. Add the date to check for a shared route."]), anchorNote: null };
    }
    const hit = byDate.get(date);
    if (hit) return hit;
    const { anchors, note } = await gatherAnchors(date, venue, cfg.routeRadiusMiles, body.projectId);
    let optimize: RouteOptimizeResult;
    if (anchors.length === 0) {
      optimize = standard([note ?? `No confirmed scheduled stops near this venue on ${date}, so it is priced as a standalone trip from the warehouse.`]);
    } else {
      const input = {
        venue,
        warehouse: WAREHOUSE_COORDS,
        warehouseMiles: whMiles,
        anchors,
        routeRadiusMiles: cfg.routeRadiusMiles,
        timingToleranceMinutes: cfg.timingToleranceMinutes,
        mode,
        air: haversineMiles,
      };
      const { dist, failures } = await buildDistanceFn(neededPairs(input));
      optimize = routeOptimize({ ...input, dist });
      if (failures > 0) {
        optimize.reasons.push(`${failures} driving distance(s) could not be verified (routing service) and were estimated as the crow flies.`);
      }
    }
    const out = { optimize, anchorNote: note };
    byDate.set(date, out);
    return out;
  }

  const legDates: Array<[LegKey, string]> = [];
  if (mode !== "pickup") legDates.push(["dropOff", eventDate]);
  if (mode !== "drop_off") legDates.push(["pickup", pickupDate]);

  const runs: Array<{ leg: LegKey; date: string; optimize: RouteOptimizeResult; anchorNote: string | null }> = [];
  for (const [leg, date] of legDates) runs.push({ leg, date, ...(await optimizeForDate(date)) });

  const legMiles = { dropOff: whMiles, pickup: whMiles };
  for (const r of runs) legMiles[r.leg] = r.optimize.billableMiles;
  const quote = deliveryQuoteLegs(legMiles, subtotal, mode, cfg);
  const perLeg = pushPerLeg(quote);

  const legResults: Partial<Record<LegKey, LegResult>> = {};
  for (const { leg, date, optimize, anchorNote } of runs) {
    const fee = leg === "dropOff" ? quote.dropOff : quote.pickup;
    if (!fee) continue;
    legResults[leg] = {
      leg,
      date: date || null,
      pricingMode: optimize.mode,
      warehouseMiles: optimize.warehouseMiles,
      billableMiles: optimize.billableMiles,
      incrementalMiles: optimize.incrementalMiles,
      savingsMiles: optimize.savingsMiles,
      anchor: optimize.anchor,
      anchorsConsidered: optimize.anchorsConsidered,
      reasons: [...optimize.reasons],
      anchorNote,
      fee,
    };
  }

  // Top-level single-leg fields are kept for older readers: they describe the first priced leg.
  const primary = (legResults.dropOff ?? legResults.pickup)!;

  return NextResponse.json({
    ok: true,
    resolved: true,
    distanceSource,
    addressPrecision,
    warnings,
    mode,
    subtotal,
    eventDate: eventDate || null,
    pickupDate: pickupDate || null,
    legs: { dropOff: legResults.dropOff ?? null, pickup: legResults.pickup ?? null },
    warehouseMiles: primary.warehouseMiles,
    billableMiles: primary.billableMiles,
    incrementalMiles: primary.incrementalMiles,
    savingsMiles: primary.savingsMiles,
    pricingMode: primary.pricingMode,
    anchor: primary.anchor,
    anchorsConsidered: primary.anchorsConsidered,
    reasons: primary.reasons,
    anchorNote: primary.anchorNote,
    quote,
    perLeg,
    formula,
    radiusMiles: cfg.routeRadiusMiles,
    toleranceMinutes: cfg.timingToleranceMinutes,
    warehouseAddress: WAREHOUSE_ADDRESS,
  });
}

/**
 * Gather one date's CONFIRMED scheduled stops as anchors: ONLY stops on a live route (precise address, a
 * known window, a truck). A signed-but-unrouted booking is NOT used: we never assume it has a delivery
 * (mis-pricing that costs real money). Stops the truck won't drive to (Exception, lost/cancelled/archived
 * projects) are already left out by getStopsOnDate, and the quote's own project is excluded so it never
 * anchors to itself.
 *
 * Trips are built from WHOLE routes, so the optimizer sees the real sequence. A route is checked only if at
 * least one of its stops is within the radius by air (air is never longer than road, so a route with none
 * can't share), and at most ROUTE_CAP routes are checked, nearest first. A route with a stop we can't
 * locate is skipped rather than priced on a shortened sequence (that gap would never be driven).
 */
async function gatherAnchors(
  date: string,
  venue: LatLng,
  radiusMiles: number,
  selfId: string | undefined,
): Promise<{ anchors: RouteAnchor[]; note: string | null }> {
  const self = (selfId ?? "").trim();
  const stops = getStopsOnDate(date);
  if (stops.length === 0) {
    return { anchors: [], note: `No routes are scheduled on ${date} yet, so it is priced as a standalone trip from the warehouse.` };
  }

  type RouteGroup = { routeId: string; anchors: RouteAnchor[]; minAir: number; unlocated: boolean };
  const routes = new Map<string, RouteGroup>();
  for (const s of stops) {
    if (self && s.txId === self) continue;
    const g = routes.get(s.routeId) ?? { routeId: s.routeId, anchors: [], minAir: Infinity, unlocated: false };
    routes.set(s.routeId, g);
    const coords = s.address.trim() ? await geocode(s.address) : null;
    if (!coords) {
      g.unlocated = true;
      continue;
    }
    g.minAir = Math.min(g.minAir, haversineMiles(venue, coords));
    g.anchors.push({
      id: s.txId || s.stopId,
      label: s.custName || s.address,
      coords,
      truckId: s.truckId,
      routeId: s.routeId,
      kind: s.kind,
      order: s.sequence,
      windowKnown: !!(s.plannedWindow || s.eta),
      source: "route",
    });
  }

  const all = [...routes.values()];
  const nearby = all.filter((r) => r.minAir <= radiusMiles);
  const usable = nearby.filter((r) => !r.unlocated);
  usable.sort((a, b) => a.minAir - b.minAir || a.routeId.localeCompare(b.routeId));
  const kept = usable.slice(0, ROUTE_CAP);
  const anchors = kept.flatMap((r) => r.anchors);

  const notes: string[] = [];
  if (kept.length < all.length) {
    notes.push(`${all.length} route(s) on this date; ${kept.length} with a stop within ${radiusMiles} mi were checked.`);
  }
  const skipped = nearby.length - usable.length;
  if (skipped > 0) notes.push(`${skipped} nearby route(s) skipped because a stop address could not be located.`);
  if (anchors.length === 0 && notes.length === 0) notes.push(`No confirmed scheduled stops near this venue on ${date}.`);
  return { anchors, note: notes.length ? notes.join(" ") : null };
}

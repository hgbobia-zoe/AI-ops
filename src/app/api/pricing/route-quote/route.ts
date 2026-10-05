// Route-aware delivery quote. Staff-session-gated (not public; the proxy requires a valid session). Given
// a venue (address to geocode, or manual miles when geocoding fails) + the event date + the pre-discount
// subtotal + the leg mode, it:
//   1. geocodes the venue and computes the one-way warehouse→venue driving distance (cached, bounded),
//   2. gathers the day's SIGNED jobs that have a delivery component — both routed stops (precise address +
//      window + truck) and signed-but-unrouted bookings (city-level location, window unknown),
//   3. runs the DETERMINISTIC route optimizer (STANDARD / ROUTE_OPTIMIZED / DEDICATED) to pick the
//      billable distance, and
//   4. prices the leg(s) with the team-editable pricing config.
// RULES CALCULATE — no LLM in the price path. Returns the full breakdown so the UI (or an AI) can explain
// it; unknowns (geocode/route failures, unknown anchor windows) are surfaced, never invented.

import { NextResponse } from "next/server";
import { geocode, driveTime, type LatLng } from "@/lib/eta/geo";
import { WAREHOUSE_COORDS, WAREHOUSE_ADDRESS } from "@/lib/pricing/warehouse";
import { pricingConfig } from "@/lib/pricing/config";
import { deliveryQuote, metersToMiles, type LegMode } from "@/lib/pricing/delivery";
import { buildDistanceFn, haversineMiles } from "@/lib/pricing/routeDistance";
import { routeOptimize, type RouteAnchor } from "@/lib/pricing/routeOptimize";
import { getStopsOnDate, getSignedBookingsOnDate } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

const MODES: LegMode[] = ["round_trip", "drop_off", "pickup"];
const ANCHOR_CAP = 8; // bound geocodes + OSRM pairs per quote (nearest-by-air anchors within the radius)

interface Body {
  address?: string;
  miles?: number; // manual one-way miles (fallback when geocoding fails)
  eventDate?: string; // YYYY-MM-DD
  subtotal?: number;
  mode?: LegMode;
  projectId?: string; // the quote's own project, excluded from its own anchor set
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
  const manualMiles = Number.isFinite(Number(body.miles)) && Number(body.miles) >= 0 ? Number(body.miles) : null;
  const eventDate = (body.eventDate ?? "").trim();

  const formula = { baseFee: cfg.baseFee, mileageTiers: cfg.mileageTiers, pct: cfg.pct, pctCap: cfg.pctCap };
  const base = {
    formula,
    radiusMiles: cfg.routeRadiusMiles,
    toleranceMinutes: cfg.timingToleranceMinutes,
    warehouseAddress: WAREHOUSE_ADDRESS,
    mode,
    subtotal,
  };

  // Resolve the venue + one-way warehouse miles. Prefer a geocoded address; fall back to manual miles.
  let venue: LatLng | null = null;
  let warehouseMiles: number | null = null;
  let distanceSource: "geocoded" | "manual" | "unresolved" = "unresolved";

  if (address) {
    venue = await geocode(address);
    if (venue) {
      const drive = await driveTime(WAREHOUSE_COORDS, venue);
      if (drive?.meters != null) {
        warehouseMiles = Math.round(metersToMiles(drive.meters) * 10) / 10;
        distanceSource = "geocoded";
      }
    }
  }
  if (warehouseMiles == null && manualMiles != null) {
    warehouseMiles = manualMiles;
    distanceSource = "manual";
    venue = null; // no coords → route optimization isn't possible, price STANDARD
  }

  if (warehouseMiles == null) {
    // Couldn't resolve a distance and no manual miles given — be honest, let the rep type miles by hand.
    return NextResponse.json({
      ok: true,
      resolved: false,
      distanceSource: "unresolved",
      note: address ? "Couldn't find that address — type the miles in by hand." : "Enter an address or the miles to price this run.",
      ...base,
    });
  }

  // STANDARD by default (manual miles, or no event date to find same-day jobs, or no venue coords).
  let optimize = routeOptimize({
    venue: venue ?? WAREHOUSE_COORDS,
    warehouse: WAREHOUSE_COORDS,
    warehouseMiles,
    anchors: [],
    dist: () => ({ miles: 0, minutes: 0 }),
    routeRadiusMiles: cfg.routeRadiusMiles,
    timingToleranceMinutes: cfg.timingToleranceMinutes,
    mode,
  });
  let anchorNote: string | null = null;

  if (venue && eventDate) {
    const { anchors, note } = await gatherAnchors(eventDate, venue, cfg.routeRadiusMiles, body.projectId);
    anchorNote = note;
    if (anchors.length > 0) {
      const { dist, failures } = await buildDistanceFn([WAREHOUSE_COORDS, venue, ...anchors.map((a) => a.coords)]);
      optimize = routeOptimize({
        venue,
        warehouse: WAREHOUSE_COORDS,
        warehouseMiles,
        anchors,
        dist,
        routeRadiusMiles: cfg.routeRadiusMiles,
        timingToleranceMinutes: cfg.timingToleranceMinutes,
        mode,
      });
      if (failures > 0) {
        optimize.reasons.push(`${failures} driving distance(s) could not be verified (routing service) and were estimated as the crow flies.`);
      }
    } else {
      // Keep the STANDARD result but surface how many signed jobs existed (0 shareable).
      optimize.reasons = [
        note ?? "No other signed jobs with a delivery component on this date — priced as a standalone trip from the warehouse.",
      ];
    }
  } else if (venue && !eventDate) {
    optimize.reasons = ["No event date given, so same-day jobs can't be found — priced as a standalone trip. Add the event date to check for a shared route."];
  }

  const quote = deliveryQuote(optimize.billableMiles, subtotal, mode, cfg);
  const perLeg = (quote.dropOff ?? quote.pickup)?.total ?? 0;

  return NextResponse.json({
    ok: true,
    resolved: true,
    distanceSource,
    mode,
    subtotal,
    warehouseMiles: optimize.warehouseMiles,
    billableMiles: optimize.billableMiles,
    incrementalMiles: optimize.incrementalMiles,
    savingsMiles: optimize.savingsMiles,
    pricingMode: optimize.mode,
    anchor: optimize.anchor,
    anchorsConsidered: optimize.anchorsConsidered,
    reasons: optimize.reasons,
    anchorNote,
    quote,
    perLeg,
    formula,
    radiusMiles: cfg.routeRadiusMiles,
    toleranceMinutes: cfg.timingToleranceMinutes,
    warehouseAddress: WAREHOUSE_ADDRESS,
  });
}

/**
 * Gather the day's signed delivery jobs as anchors. Routed stops give a precise street address + window +
 * truck; signed-but-unrouted bookings give a city-level location with an unknown window. Each is geocoded
 * (cached). A straight-line prefilter drops anchors beyond the radius (air distance ≤ road, so this is
 * safe), and we keep at most ANCHOR_CAP nearest to bound geocodes + OSRM pairs. The quote's own project is
 * excluded so it never anchors to itself.
 */
async function gatherAnchors(
  eventDate: string,
  venue: LatLng,
  radiusMiles: number,
  selfId: string | undefined,
): Promise<{ anchors: RouteAnchor[]; note: string | null }> {
  const self = (selfId ?? "").trim();
  const stops = getStopsOnDate(eventDate);
  const bookings = getSignedBookingsOnDate(eventDate);

  // Dedupe: a signed booking that's already on a route is represented by its (precise) routed stop.
  const routedTxIds = new Set(stops.map((s) => s.txId).filter((x): x is string => !!x));

  type Raw = { id: string; label: string; addr: string; truckId: string | null; order?: number; windowKnown: boolean; source: "route" | "booking"; kind?: "delivery" | "pickup" };
  const raw: Raw[] = [];

  for (const s of stops) {
    if (self && s.txId === self) continue;
    if (!s.address.trim()) continue;
    raw.push({
      id: s.txId || s.stopId,
      label: s.custName || s.address,
      addr: s.address,
      truckId: s.truckId,
      order: s.sequence,
      windowKnown: !!(s.plannedWindow || s.eta),
      source: "route",
      kind: s.kind,
    });
  }
  for (const b of bookings) {
    if (self && b.bookingId === self) continue;
    if (routedTxIds.has(b.bookingId)) continue; // already covered by its routed stop
    const loc = (b.location || b.venue || "").trim();
    if (!loc) continue;
    raw.push({
      id: b.bookingId,
      label: b.eventName || b.clientName || loc,
      addr: loc,
      truckId: null,
      windowKnown: false,
      source: "booking",
    });
  }

  if (raw.length === 0) return { anchors: [], note: null };

  // Geocode (cached), prefilter by straight-line radius, then keep the nearest ANCHOR_CAP.
  const geocoded: Array<{ r: Raw; coords: LatLng; air: number }> = [];
  for (const r of raw) {
    const coords = await geocode(r.addr);
    if (!coords) continue;
    const air = haversineMiles(venue, coords);
    if (air > radiusMiles) continue; // beyond the radius by air ⇒ beyond by road too — safe to drop
    geocoded.push({ r, coords, air });
  }
  geocoded.sort((a, b) => a.air - b.air);
  const kept = geocoded.slice(0, ANCHOR_CAP);

  const anchors: RouteAnchor[] = kept.map(({ r, coords }) => ({
    id: r.id,
    label: r.label,
    coords,
    truckId: r.truckId,
    kind: r.kind,
    order: r.order,
    windowKnown: r.windowKnown,
    source: r.source,
  }));

  const signedCount = raw.length;
  const note =
    anchors.length < signedCount
      ? `${signedCount} signed job(s) on this date; ${anchors.length} within ${radiusMiles} mi and geocodable were considered.`
      : null;
  return { anchors, note };
}

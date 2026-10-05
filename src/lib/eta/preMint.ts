// PRE-MINT selection + window math (PURE — no DB, no network). These are the shared, unit-tested pieces
// that the runtime pre-mint tick (src/lib/eta/preMintTick.ts) uses to decide WHICH upcoming stops get an
// Ignition etaLink minted ahead of departure, and over WHAT validity window.
//
// Why pre-mint: today the live Ignition etaLink is only minted at the split-second of departure, and only
// if the office machine's Ignition session happens to be signed in + polling THEN. If it lapses, every
// "on the way" text falls back to the basic /track page. Pre-minting enqueues the mint DURING THE DAY —
// while the session is fresh — so the real live link is already waiting at departure. The extension drains
// these via the existing /api/etalink/pending loop; no extension change.
//
// Honest by construction: we never fabricate a stop time or an ETA. A stop with no scheduled time gets an
// end-of-day window (supplied by the caller); the window is always clamped to a sane max Ignition accepts.

import type { Route, Stop } from "@/lib/types";

/** How far into TOMORROW we pre-mint timed stops (only tomorrow stops scheduled within this horizon). */
export const PREMINT_LOOKAHEAD_H = 12;
/** Buffer added after a stop's scheduled time so the link is still valid if the driver runs late. */
export const PREMINT_BUFFER_H = 3;
/** Hard clamp on the mint's validity window (Ignition accepts a bounded dateRange). */
export const PREMINT_MAX_WINDOW_H = 24;

// Matches an ISO-8601 datetime (Goodshuffle windows/ETAs). Free-text values ("morning") are treated as
// "no scheduled time" so we never parse them into a fabricated instant.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A stop's scheduled instant for window math: prefer the computed ETA, then the planned window. Returns
 *  null when neither is a real ISO datetime (manual free-text entries don't count — never fabricated). */
export function stopScheduledISO(stop: Stop): string | null {
  for (const v of [stop.eta, stop.plannedWindow]) {
    const t = v?.trim();
    if (t && ISO_DATETIME.test(t)) return t;
  }
  return null;
}

/** An UPCOMING, customer-facing stop worth minting a link for: still Waiting/EnRoute (not Arrived/
 *  Completed/Returned/etc.), has a usable street address to geocode, and has someone to text (the
 *  customer or a day-of coordinator) — otherwise the minted link would go nowhere. */
export function isPreMintableStop(stop: Stop): boolean {
  if (stop.state !== "Waiting" && stop.state !== "EnRoute") return false;
  if (!stop.address || !stop.address.trim()) return false;
  if (!stop.custPhone?.trim() && !stop.dayOfPhone?.trim()) return false;
  return true;
}

/** A delivery (drop-off) stop. `kind` defaults to "delivery" when unknown (matches the Stop contract), so
 *  only an explicit "pickup" is excluded. Used for the "are there deliveries to track today?" alert gate. */
export function isDeliveryStop(stop: Stop): boolean {
  return stop.kind !== "pickup";
}

/** True when `routes` contain at least one upcoming delivery stop that would send a customer link today —
 *  i.e. the Ignition mint path actually MATTERS right now. Drives the alert/dot gate so we never nag about
 *  a signed-out Ignition when there's nothing to mint. */
export function hasUpcomingDeliveries(routes: Route[]): boolean {
  return routes.some((r) => r.stops.some((s) => isPreMintableStop(s) && isDeliveryStop(s)));
}

export interface PreMintPlanItem {
  stop: Stop;
  routeId: string;
  truckId: string;
  truckLabel: string;
  stopTimeISO: string | null;
}

export interface RouteForPreMint {
  route: Route;
  truckId: string;
  truckLabel: string;
  /** Today's routes mint every upcoming stop; tomorrow's only the ones scheduled within the horizon. */
  isToday: boolean;
}

/** Pick the stops to pre-mint from a day's routes. Today: every pre-mintable stop. Tomorrow (early):
 *  only stops with a real scheduled time within `lookaheadH` of `now` (never fabricate a time, so an
 *  untimed tomorrow stop is skipped — it isn't demonstrably imminent). Pure + order-stable. */
export function selectStopsToPreMint(input: {
  routes: RouteForPreMint[];
  now: Date;
  lookaheadH?: number;
}): PreMintPlanItem[] {
  const lookaheadMs = input.now.getTime() + (input.lookaheadH ?? PREMINT_LOOKAHEAD_H) * 3_600_000;
  const out: PreMintPlanItem[] = [];
  for (const { route, truckId, truckLabel, isToday } of input.routes) {
    for (const stop of route.stops) {
      if (!isPreMintableStop(stop)) continue;
      const stopTimeISO = stopScheduledISO(stop);
      if (!isToday) {
        const t = stopTimeISO ? Date.parse(stopTimeISO) : NaN;
        if (!Number.isFinite(t) || t > lookaheadMs) continue; // only demonstrably-imminent tomorrow stops
      }
      out.push({ stop, routeId: route.routeId, truckId, truckLabel, stopTimeISO });
    }
  }
  return out;
}

/**
 * The mint's validity window [startISO, endISO], from NOW through the stop's scheduled time + a buffer,
 * floored at a minimum window and clamped to a sane max (Ignition accepts a bounded dateRange). A stop
 * with no real scheduled time falls back to `fallbackEndISO` (the caller supplies end-of-day). This is
 * what lets a link minted at 10am still be live at a 7pm departure.
 */
export function preMintWindow(opts: {
  now: Date;
  stopTimeISO?: string | null;
  fallbackEndISO: string;
  minWindowH: number;
  bufferH?: number;
  maxH?: number;
}): { startISO: string; endISO: string; hours: number } {
  const nowMs = opts.now.getTime();
  const buffer = opts.bufferH ?? PREMINT_BUFFER_H;
  const maxH = opts.maxH ?? PREMINT_MAX_WINDOW_H;

  const stopMs = opts.stopTimeISO ? Date.parse(opts.stopTimeISO) : NaN;
  let endMs = Number.isFinite(stopMs) ? stopMs + buffer * 3_600_000 : Date.parse(opts.fallbackEndISO);
  if (!Number.isFinite(endMs)) endMs = nowMs + maxH * 3_600_000; // last-resort: a full max window

  // Floor: never shorter than the minimum window (so a near/just-past stop still gets a usable link).
  const floorMs = nowMs + Math.max(0, opts.minWindowH) * 3_600_000;
  if (endMs < floorMs) endMs = floorMs;
  // Clamp: never longer than the max Ignition accepts.
  const capMs = nowMs + maxH * 3_600_000;
  if (endMs > capMs) endMs = capMs;

  return { startISO: new Date(nowMs).toISOString(), endISO: new Date(endMs).toISOString(), hours: (endMs - nowMs) / 3_600_000 };
}

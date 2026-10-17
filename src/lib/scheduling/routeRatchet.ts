// Route-change shift RATCHET (expand-only). When a Goodshuffle route grows (runs later, or starts earlier),
// the worker's shift window should grow to cover it. When the route SHRINKS, the shift is HELD as-is — we
// never reduce a scheduled worker's hours, so no one feels their pay got cut. PURE + deterministic
// (RULES CALCULATE): the new window is the union (min start, max end) of the current shift and the route,
// which by construction only ever expands. The effectful pass (update the app shift + push the grown window
// to Connecteam silently) lives in routeAutoSync.ts.

import { routeWindow } from "@/lib/risk/engine";
import { DEFAULT_RISK_CONFIG, type EngineRoute } from "@/lib/risk/types";
import type { Route } from "@/lib/types";

export interface WindowISO {
  start: string | null;
  end: string | null;
  windowKnown: boolean;
}

export interface RatchetOutcome {
  start: string | null;
  end: string | null;
  windowKnown: boolean;
  /** True when the window actually grew (so the caller writes it); false = hold (route same/shorter/unknown). */
  changed: boolean;
  /** Deterministic reason the window grew ("route runs later", …), null when unchanged. */
  reason: string | null;
}

/**
 * PURE. The expand-only new window for a shift given its route's own window. Grows the shift to cover the
 * route (earlier start and/or later end); NEVER shrinks it (a shorter route → changed:false, hold). An
 * unknown/absent shift window adopts the route's window (information gain, not a shrink).
 */
export function ratchetWindow(shift: WindowISO, route: { start: string | null; end: string | null; known: boolean }): RatchetOutcome {
  const hold: RatchetOutcome = { start: shift.start, end: shift.end, windowKnown: shift.windowKnown, changed: false, reason: null };
  if (!route.known || !route.start || !route.end) return hold;
  const rS = Date.parse(route.start);
  const rE = Date.parse(route.end);
  if (!Number.isFinite(rS) || !Number.isFinite(rE) || rE <= rS) return hold;

  const adoptRoute: RatchetOutcome = { start: route.start, end: route.end, windowKnown: true, changed: true, reason: "set the shift window from the route" };
  if (!shift.windowKnown || !shift.start || !shift.end) return adoptRoute;
  const sS = Date.parse(shift.start);
  const sE = Date.parse(shift.end);
  if (!Number.isFinite(sS) || !Number.isFinite(sE)) return adoptRoute;

  const newS = Math.min(sS, rS);
  const newE = Math.max(sE, rE);
  const earlier = newS < sS;
  const later = newE > sE;
  if (!earlier && !later) return hold; // route is the same or shorter → never shrink

  const parts: string[] = [];
  if (later) parts.push("the route now runs later");
  if (earlier) parts.push("the route now starts earlier");
  return { start: new Date(newS).toISOString(), end: new Date(newE).toISOString(), windowKnown: true, changed: true, reason: parts.join(" and ") };
}

/** A route's OWN stop-derived window (not the shift's) — the signal for whether the route itself grew.
 *  Mirrors preCheck.routeAssignWindow's EngineRoute mapping but always the route's own window. */
export function routeOwnWindow(route: Route): { start: string | null; end: string | null; known: boolean } {
  const er: EngineRoute = {
    routeId: route.routeId,
    truckId: route.truckId,
    date: route.date,
    status: route.status,
    gsRouteId: route.gsRouteId,
    driverId: route.driverId,
    driverName: route.driverName,
    stops: route.stops.map((s) => ({ sequence: s.sequence, custName: s.custName, kind: s.kind, plannedWindow: s.plannedWindow, eta: s.eta, items: s.items })),
  };
  const w = routeWindow(er, DEFAULT_RISK_CONFIG);
  if (!w) return { start: null, end: null, known: false };
  return { start: new Date(w.startUnix * 1000).toISOString(), end: new Date(w.endUnix * 1000).toISOString(), known: true };
}

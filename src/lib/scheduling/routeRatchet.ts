// Route-change shift TRACKING. When Goodshuffle re-optimizes a route (its AI does the auto-routing; Zoe only
// reads it), the assigned worker's shift should FOLLOW the route — move earlier or later with it, and grow to
// cover a longer route — so Connecteam, the schedule, and /dispatch all agree with what the route now is.
//
// The one guardrail (owner's call, 2026-10-19): we MOVE the window but never AUTO-SHRINK a worker's hours. A
// route that got shorter keeps the worker's existing hours (the block can slide to the route's new time, but
// its duration is held). Cutting someone's scheduled hours stays a human decision.
//
// PURE + deterministic (RULES CALCULATE). The effectful pass — update the app shift + push the moved window to
// Connecteam silently, then announce it — lives in routeAutoSync.ts (applyRouteWindowRatchet).

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
  /** True when the window should move/grow (so the caller writes it); false = hold (covers it / same / unknown). */
  changed: boolean;
  /** Deterministic reason the window moved ("the route moved later", …), null when unchanged. */
  reason: string | null;
}

/**
 * PURE. The new window for a shift given its route's own (buffer-inclusive) window. Follows the route:
 *  - already covers the route (start ≤ route start AND end ≥ route end) → HOLD (no churn, and never shrink);
 *  - otherwise MOVE/GROW to cover the route, anchored to the route's start, keeping AT LEAST the shift's
 *    current duration — so a route that slid later slides the whole block later (instead of stretching it),
 *    and a route that got shorter keeps the worker's hours.
 * An unknown/absent shift window adopts the route's window (information gain, not a shrink).
 */
export function trackWindow(shift: WindowISO, route: { start: string | null; end: string | null; known: boolean }): RatchetOutcome {
  const hold: RatchetOutcome = { start: shift.start, end: shift.end, windowKnown: shift.windowKnown, changed: false, reason: null };
  if (!route.known || !route.start || !route.end) return hold;
  const rS = Date.parse(route.start);
  const rE = Date.parse(route.end);
  if (!Number.isFinite(rS) || !Number.isFinite(rE) || rE <= rS) return hold;

  const adoptRoute: RatchetOutcome = { start: route.start, end: route.end, windowKnown: true, changed: true, reason: "set the shift window from the route" };
  if (!shift.windowKnown || !shift.start || !shift.end) return adoptRoute;
  const sS = Date.parse(shift.start);
  const sE = Date.parse(shift.end);
  if (!Number.isFinite(sS) || !Number.isFinite(sE) || sE <= sS) return adoptRoute;

  // The shift already brackets the route → the worker is present for the whole route; leave it (and never
  // shrink a generous window down to the route).
  if (sS <= rS && sE >= rE) return hold;

  // Move/grow to cover the route. Anchor the start to the route's start and preserve at least the current
  // duration (never shrink hours) — so a later route slides the block later, a shorter route keeps the hours.
  const curDur = sE - sS;
  const routeDur = rE - rS;
  const keepDur = Math.max(curDur, routeDur);
  const newS = rS;
  const newE = rS + keepDur;

  const parts: string[] = [];
  if (newS < sS) parts.push("the route now starts earlier");
  if (newS > sS) parts.push("the route moved later");
  if (newE > sE && newS <= sS) parts.push("the route now runs later");
  const reason = parts.join(" and ") || "the route window shifted";

  return { start: new Date(newS).toISOString(), end: new Date(newE).toISOString(), windowKnown: true, changed: true, reason };
}

/** A route's OWN stop-derived window (not the shift's), buffers included — the signal for where the route
 *  now sits in the day. Mirrors preCheck.routeAssignWindow's EngineRoute mapping but always the route's own. */
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

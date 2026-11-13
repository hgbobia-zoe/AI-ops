// A route's own crew window: the time a route shift should have. First stop minus the load buffer, rounded to
// the nearest quarter hour (quarterHour.ts), through last stop plus the return buffer. The policy that keeps
// route shifts on this window ("Shifts have to match the route unless someone overrides it", owner rule
// 2026-11-12) is routeMatch.ts; it replaced the older "never auto shrink" tracking that lived here.
//
// PURE + deterministic (RULES CALCULATE). The effectful pass lives in routeAutoSync.ts (applyRouteWindowRatchet).

import { routeWindow } from "@/lib/risk/engine";
import { crewWindow } from "./quarterHour";
import { DEFAULT_RISK_CONFIG, type EngineRoute } from "@/lib/risk/types";
import type { Route } from "@/lib/types";

export interface WindowISO {
  start: string | null;
  end: string | null;
  windowKnown: boolean;
}

/** A route's OWN stop-derived CREW window (not the shift's), buffers included, start rounded to the nearest quarter
 *  hour, end unchanged (quarterHour.ts) — the signal for where the route now sits in the day. Mirrors
 *  preCheck.routeAssignWindow's EngineRoute mapping but always the route's own. `opts.raw` skips the rounding
 *  (used to tell a rounding-only move from a real route change). */
export function routeOwnWindow(route: Route, opts: { raw?: boolean } = {}): { start: string | null; end: string | null; known: boolean } {
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
  const raw = routeWindow(er, DEFAULT_RISK_CONFIG);
  if (!raw) return { start: null, end: null, known: false };
  const w = opts.raw ? raw : crewWindow(raw);
  return { start: new Date(w.startUnix * 1000).toISOString(), end: new Date(w.endUnix * 1000).toISOString(), known: true };
}

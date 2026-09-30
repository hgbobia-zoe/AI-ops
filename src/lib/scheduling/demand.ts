// Demand generation — turn a day's routes into a first draft of the shifts that day needs.
// Deterministic, reusing the SAME primitives the Event Risk engine uses, so the schedule the app
// proposes matches what Risk already tells you:
//   • routeWindow()  → each route's operational window (first stop − load buffer … last + return)
//   • crewForRoute() → how many people the route's items need (tent rules)
//   • warehousePerRoutes (RiskConfig) → prep crew = ceil(delivery routes / N), done the day BEFORE
//
// Rules (mirror the risk engine; documented here so they're easy to tune once Zoe reacts):
//   - DRIVER: one shift per active route, spanning the route window (headcount 1).
//   - FIELD:  extra on-site crew beyond the driver = crewForRoute.crew − 1, same window as the route.
//   - PREP:   warehouse load/prep the day BEFORE the events = ceil(deliveryRoutes / warehousePerRoutes).
//             We do NOT know the prep clock time, so its window is left unknown (windowKnown=false)
//             for the human to set — never fabricated.
//
// FACTS ONLY: a route with no usable stop times yields a driver shift with windowKnown=false rather
// than a made-up time. Done/closed routes are skipped.

import { routeWindow } from "@/lib/risk/engine";
import { DEFAULT_RISK_CONFIG, type RiskConfig, type EngineRoute } from "@/lib/risk/types";
import { crewForRoute } from "@/lib/crewRules";
import { shiftYmd } from "@/lib/dates";
import type { Route } from "@/lib/types";
import type { DemandShift } from "./types";

const WAREHOUSE = "Warehouse";

function toEngineRoute(r: Route): EngineRoute {
  return {
    routeId: r.routeId,
    truckId: r.truckId,
    date: r.date,
    status: r.status,
    gsRouteId: r.gsRouteId,
    driverId: r.driverId,
    driverName: r.driverName,
    stops: r.stops.map((s) => ({
      sequence: s.sequence,
      custName: s.custName,
      kind: s.kind,
      plannedWindow: s.plannedWindow,
      eta: s.eta,
      items: s.items,
    })),
  };
}

function isoFromUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** A short human label for a route's shift (truck + stop count / first customer). */
function routeLabel(r: Route): string {
  const n = r.stops.length;
  const first = r.stops[0]?.custName;
  if (n === 1 && first) return first;
  return `${r.truckId} · ${n} stop${n === 1 ? "" : "s"}`;
}

/**
 * Build the suggested shifts for ONE day's routes. Driver + field shifts land on the event day;
 * the prep shift lands the day before. Pure — pass the day's routes (all trucks) and get a draft.
 */
export function buildDemand(routes: Route[], cfg: RiskConfig = DEFAULT_RISK_CONFIG): DemandShift[] {
  const active = routes.filter((r) => r.status !== "done" && r.stops.length > 0);
  if (active.length === 0) return [];

  const out: DemandShift[] = [];
  const eventDate = active[0].date;

  for (const r of active) {
    const win = routeWindow(toEngineRoute(r), cfg);
    const start = win ? isoFromUnix(win.startUnix) : null;
    const end = win ? isoFromUnix(win.endUnix) : null;
    const label = routeLabel(r);

    // DRIVER — one per route, spanning its window.
    out.push({
      date: r.date,
      role: "driver",
      headcount: 1,
      startTime: start,
      endTime: end,
      windowKnown: win != null,
      location: WAREHOUSE,
      routeId: r.routeId,
      truckId: r.truckId,
      eventLabel: label,
      reasons: ["1 driver per route"],
    });

    // FIELD — helpers beyond the driver, from the route's tent/item rules.
    const need = crewForRoute(r.stops.map((s) => s.items ?? []));
    const extra = need.crew - 1;
    if (extra > 0) {
      out.push({
        date: r.date,
        role: "field",
        headcount: extra,
        startTime: start,
        endTime: end,
        windowKnown: win != null,
        location: WAREHOUSE,
        routeId: r.routeId,
        truckId: r.truckId,
        eventLabel: label,
        reasons: need.reasons.length ? need.reasons : [`${need.crew} crew on this route`],
      });
    }
  }

  // PREP — warehouse load the day before, sized by delivery-route count. One shift for the day.
  const deliveryRoutes = active.filter((r) => r.stops.some((s) => s.kind !== "pickup")).length;
  const per = cfg.warehousePerRoutes || 3;
  const prepCount = Math.ceil(deliveryRoutes / per);
  if (prepCount > 0) {
    out.push({
      date: shiftYmd(eventDate, -1), // Zoe preps/loads the day before
      role: "prep",
      headcount: prepCount,
      startTime: null, // prep clock time is unknown — the human sets it (never fabricated)
      endTime: null,
      windowKnown: false,
      location: WAREHOUSE,
      eventLabel: `Prep for ${eventDate}`,
      reasons: [`${deliveryRoutes} delivery route${deliveryRoutes === 1 ? "" : "s"} → ${prepCount} prep crew`],
    });
  }

  return out;
}

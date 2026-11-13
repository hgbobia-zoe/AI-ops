// The day's routes as Add shift choices: each with its crew window, so a new route shift takes the route's
// time (owner rule: shifts match the route unless someone overrides it). Pure; built server side.

import type { Route } from "@/lib/types";
import { routeOwnWindow } from "./routeRatchet";
import { formatClockTime } from "@/lib/dates";

export interface RouteOption {
  routeId: string;
  truckId: string;
  /** "Isuzu NPR 1, 7:45 AM to 5:00 PM". */
  label: string;
  start: string | null;
  end: string | null;
}

export function buildRouteOptions(routes: Route[], truckName: (truckId: string) => string): RouteOption[] {
  return routes
    .map((r) => {
      const w = routeOwnWindow(r);
      const when = w.known && w.start && w.end ? `${formatClockTime(w.start)} to ${formatClockTime(w.end)}` : "no stop times yet";
      return { routeId: r.routeId, truckId: r.truckId, label: `${truckName(r.truckId)}, ${when}`, start: w.known ? w.start : null, end: w.known ? w.end : null };
    })
    .sort((a, b) => (a.start ?? "~").localeCompare(b.start ?? "~"));
}

/** The route a tap at `ms` on the Day schedule belongs to: the one whose crew window contains it, else the
 *  nearest by time. Null when the day has no timed routes. Pure. */
export function routeNearest(options: RouteOption[], ms: number): RouteOption | null {
  let best: RouteOption | null = null;
  let bestGap = Infinity;
  for (const o of options) {
    if (!o.start || !o.end) continue;
    const s = Date.parse(o.start);
    const e = Date.parse(o.end);
    const gap = ms >= s && ms <= e ? 0 : Math.min(Math.abs(ms - s), Math.abs(ms - e));
    if (gap < bestGap) {
      bestGap = gap;
      best = o;
    }
  }
  return best;
}

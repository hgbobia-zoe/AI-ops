// Server side lookup: a route's crew window by route id (DB read). The pure policy is routeMatch.ts.

import { getRouteById } from "@/lib/db/repo";
import { routeOwnWindow } from "./routeRatchet";
import type { CrewWin } from "./routeMatch";

export function crewWindowForRoute(routeId: string | null | undefined): CrewWin {
  if (!routeId) return { start: null, end: null, known: false };
  const route = getRouteById(routeId);
  return route ? routeOwnWindow(route) : { start: null, end: null, known: false };
}

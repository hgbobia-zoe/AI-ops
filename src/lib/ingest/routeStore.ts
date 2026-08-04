// Server-side route store. The migration seam: today an in-memory map (fine for
// single-instance dev and demos); at production this is the Zapier `Routes`/`Stops`
// tables (or Supabase). The tablet reads status through /api/route and never cares
// which backing store answered.
//
// Backed by globalThis so the SAME map is shared across route-handler bundles
// (Next builds each API route separately) within one Node process. Production
// replaces this with the external store, where cross-invocation sharing is the
// store's job, not the process's.

import type { Route, RouteStatus } from "@/lib/types";

const g = globalThis as unknown as { __aiopsRoutes?: Map<string, Route> };
const routes: Map<string, Route> = (g.__aiopsRoutes ??= new Map());

export function getRoute(truckId: string): Route | null {
  return routes.get(truckId) ?? null;
}

export function setRoute(route: Route): void {
  routes.set(route.truckId, route);
}

export function setStatus(truckId: string, status: RouteStatus): Route | null {
  const r = routes.get(truckId);
  if (!r) return null;
  const updated = { ...r, status };
  routes.set(truckId, updated);
  return updated;
}

export function clearRoute(truckId: string): void {
  routes.delete(truckId);
}

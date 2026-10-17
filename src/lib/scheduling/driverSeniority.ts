// Driver seniority router (PURE) — the tiebreak the user asked for: when two (or more) routes start at the
// SAME time and more than one scheduled driver could take either, put the MORE SENIOR driver on the
// specialty / harder route and the NEWER driver on the easier one. This resolves exactly the case the plain
// auto-assign leaves ambiguous (a driver who fits several same-time routes), turning it into a deterministic,
// auto-committable assignment.
//
// DESIGN LAW (RULES CALCULATE): a pure function of the candidate drivers (their eligible routes + seniority)
// and the routes' start times + specialty difficulty. No LLM, no DB, no clock. Seniority = earlier
// hire/created date; unknown date is treated as the NEWEST (never a fabricated tenure). It only acts inside a
// cluster of >= 2 same-start routes with >= 2 eligible drivers — the scenario the user described; anything
// else is left to the existing one-click prompt (we never guess a lone driver's route by seniority).

import type { AutoAssignDecision } from "./routeAutoAssign";

/** A scheduled driver who could fill more than one route (the ambiguous case), with their seniority anchor. */
export interface SeniorityDriverCandidate {
  userId: number;
  name: string;
  /** Routes this driver is eligible to fill right now (driver seat open + window compatible). */
  eligibleRouteIds: string[];
  /** ISO hire/created date; earlier = more senior. null = unknown (treated as newest). */
  seniorityDate: string | null;
}

/** One route the router can place a driver on, with its start time + specialty difficulty. */
export interface SeniorityRouteMeta {
  routeId: string;
  /** Unix seconds start, used to cluster "same time" routes. null → excluded (can't compare start times). */
  startUnix: number | null;
  /** Open driver seats on the route (usually 1). */
  driverGap: number;
  /** Sortable difficulty (routeSpecialty.difficulty): higher = harder/specialty. */
  difficulty: number;
  specialty: boolean;
  /** Specialty signals ("large tent", "dance floor", …) for the decision's reasons. */
  reasons: string[];
}

export interface DriverSeniorityPlan {
  autoAssign: AutoAssignDecision[];
  /** userIds the rule placed — the caller drops these from the ambiguous prompt list. */
  resolvedUserIds: number[];
}

/** Most-senior-first comparator: earlier date wins; a known date beats an unknown one; then userId. */
function bySeniorityDesc(a: SeniorityDriverCandidate, b: SeniorityDriverCandidate): number {
  if (a.seniorityDate && b.seniorityDate) {
    if (a.seniorityDate !== b.seniorityDate) return a.seniorityDate < b.seniorityDate ? -1 : 1;
    return a.userId - b.userId;
  }
  if (a.seniorityDate && !b.seniorityDate) return -1; // known tenure is more senior than unknown
  if (!a.seniorityDate && b.seniorityDate) return 1;
  return a.userId - b.userId;
}

/**
 * PURE. For each cluster of same-start routes with >= 2 eligible drivers, pair the most-senior driver with
 * the hardest (highest-difficulty / specialty) route, the next-most-senior with the next, and so on — only
 * ever onto a route the driver is actually eligible for. Returns the auto-assign decisions + the resolved
 * userIds. Leaves everything else untouched (the caller's prompt path still handles it).
 */
export function resolveDriverSeniority(drivers: SeniorityDriverCandidate[], routes: SeniorityRouteMeta[]): DriverSeniorityPlan {
  const autoAssign: AutoAssignDecision[] = [];
  const resolved = new Set<number>();

  // Cluster routes with an open driver seat by exact start time.
  const byStart = new Map<number, SeniorityRouteMeta[]>();
  for (const r of routes) {
    if (r.driverGap <= 0 || r.startUnix == null) continue;
    const list = byStart.get(r.startUnix) ?? [];
    list.push(r);
    byStart.set(r.startUnix, list);
  }

  for (const cluster of byStart.values()) {
    if (cluster.length < 2) continue; // the rule is about TWO+ routes starting together
    const routeIds = new Set(cluster.map((r) => r.routeId));
    const candidates = drivers.filter((d) => !resolved.has(d.userId) && d.eligibleRouteIds.some((id) => routeIds.has(id)));
    if (candidates.length < 2) continue; // need a real contest between drivers

    const sortedRoutes = [...cluster].sort((a, b) => b.difficulty - a.difficulty || a.routeId.localeCompare(b.routeId));
    const sortedDrivers = [...candidates].sort(bySeniorityDesc);
    const used = new Set<number>();

    for (const route of sortedRoutes) {
      let seats = route.driverGap;
      for (const d of sortedDrivers) {
        if (seats <= 0) break;
        if (used.has(d.userId)) continue;
        if (!d.eligibleRouteIds.includes(route.routeId)) continue; // never place a driver on a route they don't fit
        used.add(d.userId);
        resolved.add(d.userId);
        seats -= 1;
        autoAssign.push({
          userId: d.userId,
          name: d.name,
          routeId: route.routeId,
          fillRole: "driver",
          reasons: [
            `${cluster.length} routes start at the same time — seniority routing`,
            route.specialty
              ? `specialty route (${route.reasons.join(", ") || "specialty items"}) → more senior driver`
              : "standard route → newer driver",
            d.seniorityDate ? `driver since ${d.seniorityDate.slice(0, 10)}` : "driver seniority unknown (treated as newest)",
          ],
        });
      }
    }
  }

  return { autoAssign, resolvedUserIds: [...resolved] };
}

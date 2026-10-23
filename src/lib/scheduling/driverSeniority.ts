// Driver seniority router (PURE) — resolves the AMBIGUOUS driver case (a scheduled driver who fits more than
// one open route) into a deterministic, auto-committable route assignment, so driver gaps actually get filled
// instead of being punted to the one-click prompt. Two-stage, both human-free:
//
//   1. FORCED-MOVE PROPAGATION (coverage first). Repeatedly assign every move that has only ONE legal answer:
//      a route whose open driver seat has exactly one eligible driver, or a driver who has exactly one open
//      eligible route. Each forced assignment can make another move forced, so we loop to a fixpoint. This
//      maximizes how many routes get covered before any preference is applied — it never guesses, because a
//      forced move is the only legal assignment.
//   2. SENIORITY TIEBREAK (the rule the user asked for). For the seats that remain a genuine free choice, fill
//      the hardest / specialty routes first with the most-senior available driver, the next with the next, and
//      so on — senior drivers on the specialty routes, newer drivers on the easy ones.
//
// DESIGN LAW (RULES CALCULATE): a pure function of the candidate drivers (their eligible routes + seniority)
// and the routes' driver gap + specialty difficulty. No LLM, no DB, no clock. Seniority = earlier hire/created
// date; unknown date is treated as the NEWEST (never a fabricated tenure). Eligibility ALWAYS wins over
// seniority: a driver is only ever placed on a route in their eligibleRouteIds (the detector already enforced
// an open seat + a compatible work window), and never on more seats than a route actually has open.
//
// HISTORY: this used to act ONLY inside a cluster of >= 2 routes that start at the SAME time with >= 2
// contesting drivers — which left the common staggered-start day (several driver-gapped routes at different
// times) entirely to the prompt. The owner asked for the gaps to be filled on a match (2026-10-23), so the
// same-start restriction was dropped: the router now assigns across ALL driver-gapped routes. The same-start
// case is still recognized — it just surfaces in the decision's reasons, not as a gate.

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

/** One route the router can place a driver on, with its specialty difficulty + open driver seats. */
export interface SeniorityRouteMeta {
  routeId: string;
  /** Unix seconds start. Used ONLY to note a same-time contest in the reasons; no longer a gate. null = unknown. */
  startUnix: number | null;
  /** Open driver seats on the route (usually 1). Routes with <= 0 are not assignable. */
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
 * PURE. Assign ambiguous drivers to open driver seats across ALL driver-gapped routes: forced moves first
 * (coverage), then the senior→specialty tiebreak for the genuine free choices. Returns the auto-assign
 * decisions + the resolved userIds. Leaves a driver unresolved only when there is no open seat they fit.
 */
export function resolveDriverSeniority(drivers: SeniorityDriverCandidate[], routes: SeniorityRouteMeta[]): DriverSeniorityPlan {
  const autoAssign: AutoAssignDecision[] = [];
  const resolved = new Set<number>();

  // Remaining open driver seats per route (only routes with a real gap are assignable).
  const seats = new Map<string, number>();
  for (const r of routes) if (r.driverGap > 0) seats.set(r.routeId, r.driverGap);
  if (seats.size === 0) return { autoAssign: [], resolvedUserIds: [] };

  const routeById = new Map(routes.map((r) => [r.routeId, r] as const));
  const sortedDrivers = [...drivers].sort(bySeniorityDesc); // most senior first (stable)

  // How many driver-gapped routes start at each time — for the "same-time contest" note in the reasons only.
  const startCounts = new Map<number, number>();
  for (const r of routes) if (r.driverGap > 0 && r.startUnix != null) startCounts.set(r.startUnix, (startCounts.get(r.startUnix) ?? 0) + 1);

  const hasSeat = (routeId: string): boolean => (seats.get(routeId) ?? 0) > 0;
  /** Open routes, hardest/specialty first; ties by routeId so the choice is stable. */
  const openRoutesHardestFirst = (): string[] =>
    [...seats.keys()].filter(hasSeat).sort((a, b) => routeById.get(b)!.difficulty - routeById.get(a)!.difficulty || a.localeCompare(b));
  /** A driver's eligible routes that still have an open seat. */
  const openEligibleFor = (d: SeniorityDriverCandidate): string[] => d.eligibleRouteIds.filter(hasSeat);
  /** Eligible, not-yet-placed drivers for a route, most senior first. */
  const driversForRoute = (routeId: string): SeniorityDriverCandidate[] =>
    sortedDrivers.filter((d) => !resolved.has(d.userId) && d.eligibleRouteIds.includes(routeId));

  const place = (d: SeniorityDriverCandidate, routeId: string): void => {
    const route = routeById.get(routeId)!;
    resolved.add(d.userId);
    seats.set(routeId, (seats.get(routeId) ?? 1) - 1);
    const sameStart = route.startUnix != null && (startCounts.get(route.startUnix) ?? 0) >= 2;
    autoAssign.push({
      userId: d.userId,
      name: d.name,
      routeId,
      fillRole: "driver",
      reasons: [
        sameStart
          ? `${startCounts.get(route.startUnix!)} routes start at the same time — seniority routing`
          : "scheduled driver assigned to an open route — seniority routing",
        route.specialty
          ? `specialty route (${route.reasons.join(", ") || "specialty items"}) → more senior driver`
          : "standard route → newer driver",
        d.seniorityDate ? `driver since ${d.seniorityDate.slice(0, 10)}` : "driver seniority unknown (treated as newest)",
      ],
    });
  };

  // 1. FORCED-MOVE PROPAGATION — assign every move with a single legal answer, to a fixpoint. Routes are
  //    checked hardest-first and drivers most-senior-first so that when two forced moves would collide (the
  //    same driver is the only option for two routes), the harder route / the resolution order stays
  //    deterministic. A forced move never guesses: it is the only eligible assignment left.
  let changed = true;
  while (changed) {
    changed = false;
    for (const routeId of openRoutesHardestFirst()) {
      const cands = driversForRoute(routeId);
      if (cands.length === 1) {
        place(cands[0], routeId);
        changed = true;
      }
    }
    for (const d of sortedDrivers) {
      if (resolved.has(d.userId)) continue;
      const open = openEligibleFor(d);
      if (open.length === 1) {
        place(d, open[0]);
        changed = true;
      }
    }
  }

  // 2. SENIORITY TIEBREAK — fill the remaining genuinely-free seats, hardest route first, each with the most
  //    senior eligible driver still available (senior → specialty, newer → easy).
  for (const routeId of openRoutesHardestFirst()) {
    while (hasSeat(routeId)) {
      const cand = driversForRoute(routeId)[0];
      if (!cand) break;
      place(cand, routeId);
    }
  }

  return { autoAssign, resolvedUserIds: [...resolved] };
}

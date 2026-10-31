// "Scheduled in Connecteam, but not on any route" — the schedule → route bridge detector. This closes the
// recurring confusion (a staffer schedules crew in Connecteam and is surprised the route still shows a
// gap) by PROMPTING to assign those people onto a route — WITHOUT ever crediting a Connecteam schedule as
// coverage. The gate (preCheck.ts computeRouteGap / assignedCrewForRoute) is untouched: it still clears
// only on a real app assignment. This module only surfaces WHO is scheduled yet unrouted, and the route
// gap each could fill, so the UI can offer a one-click assign through the existing assign path.
//
// DESIGN LAW (docs/work-schedule-vs-route-assignment.md §2.1, §4): a Connecteam work shift is a WORKFORCE
// COMMITMENT (this person is expected to work today), never a route assignment and never "busy". A person
// is "on a route" ONLY when they are in a route-tied app shift's assignees. The role a scheduled person can
// fill follows the same rule availability.candidateRoles uses: a Connecteam "driver" fills a driver seat;
// a "prep" (warehouse / asset processor) worker is NOT truck crew and is never suggested onto a route (owner
// directive 2026-10-30 — field help is Instawork), and office/admin ("other") never was.
//
// HONESTY: when Connecteam is unreachable the list is UNKNOWN (reachable:false, empty people) — never a
// fabricated "nobody is scheduled". RULES CALCULATE: the core is a pure function of the scheduled people,
// the route-tied assignees, and each route's gap + window; a thin wrapper does the DB/Connecteam reads.

import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate } from "@/lib/db/repo";
import { getShiftsForDate } from "./store";
import {
  requiredCrewForRoute,
  assignedCrewForRoute,
  computeRouteGap,
  routeAssignWindow,
  type RouteCrewRole,
  type RoleCount,
} from "./preCheck";
import { getCrewForDateSafe, connecteamConfigured, type CrewRole, type CrewShift } from "@/lib/connecteam";

/** A person on the Connecteam schedule for the day, collapsed to one row (userId) with their widest work
 *  window across the day's shifts. Windows are Unix seconds; null when the shift carried no usable time. */
export interface ScheduledPerson {
  userId: number;
  name: string;
  role: CrewRole;
  title: string | null;
  window: { start: number; end: number } | null;
}

/** One present route the detector can suggest, with its app-assignment gap (from computeRouteGap) and
 *  window (Unix seconds, null when unknown). The gap is the SAME honest gap the pre-check shows. */
export interface UnroutedRouteCandidate {
  routeId: string;
  truckId: string;
  truckName: string;
  window: { start: number; end: number } | null;
  gapByRole: RoleCount;
}

export interface ScheduledUnroutedInput {
  /** Did Connecteam actually answer? false → the whole result is UNKNOWN (never "nobody scheduled"). */
  reachable: boolean;
  scheduled: ScheduledPerson[];
  /** userIds already on ANY route-tied app shift that day (staff_shifts.assignees). */
  routeAssignedUserIds: number[];
  routes: UnroutedRouteCandidate[];
}

/** One scheduled-but-unrouted person + the route(s) they could be assigned to. Serializable. */
export interface ScheduledUnroutedPerson {
  userId: number;
  name: string;
  /** The Connecteam role (driver / prep / other) — "other" is never surfaced. */
  role: CrewRole;
  /** The route seat this person can fill, following candidateRoles (driver→driver, prep→field). */
  fillRole: RouteCrewRole;
  title: string | null;
  /** The person's Connecteam work window (Unix seconds), null when the shift carried no usable time. */
  window: { start: number; end: number } | null;
  /** The best route to default the picker to, else null (only routes with a matching gap are eligible). */
  suggestedRouteId: string | null;
  /** Every route this person is eligible to fill right now (gap in their seat + compatible window). */
  eligibleRouteIds: string[];
  /** Deterministic, human-free facts for the UI / for AI to narrate later. */
  reasons: string[];
}

export interface ScheduledUnroutedResult {
  reachable: boolean;
  people: ScheduledUnroutedPerson[];
}

/** Which route (TRUCK) seat a Connecteam role can fill (mirrors availability.candidateRoles). ONLY a driver:
 *  a "prep" (warehouse / asset processor) worker is NOT delivery crew and is never surfaced onto a truck
 *  (owner directive 2026-10-30 — the "Raquel" fix; see routeAutoAssign POLICY NOTE), and office/admin never
 *  was. Field-helper seats are Instawork, not an auto-pulled warehouse person. */
function fillRoleFor(role: CrewRole): RouteCrewRole | null {
  if (role === "driver") return "driver";
  return null; // prep (warehouse) + other (office/admin) are not truck crew — never recommended onto a route
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd && bStart < aEnd;

/** True when the person's work window is compatible with the route window: unknown on either side → we
 *  can't overlap-check, so we DON'T fabricate a conflict (eligible, flagged). Else they must overlap. */
function windowCompatible(person: ScheduledPerson["window"], route: UnroutedRouteCandidate["window"]): boolean {
  if (!person || !route) return true;
  return overlaps(person.start, person.end, route.start, route.end);
}

/**
 * PURE detector. For each Connecteam-scheduled person NOT on any route-tied app shift, find the route gaps
 * they could fill (their seat has a gap + their schedule window is compatible) and pick a deterministic
 * suggestion. A person with no fillable gap is NOT surfaced (there is nothing to assign them to). Connecteam
 * unreachable → reachable:false with no people (honest unknown, never fabricated).
 */
export function detectScheduledUnrouted(input: ScheduledUnroutedInput): ScheduledUnroutedResult {
  if (!input.reachable) return { reachable: false, people: [] };

  const assigned = new Set(input.routeAssignedUserIds);
  const people: ScheduledUnroutedPerson[] = [];

  for (const p of input.scheduled) {
    if (assigned.has(p.userId)) continue; // already on a route in the app — nothing to prompt
    const fillRole = fillRoleFor(p.role);
    if (!fillRole) continue; // office/admin — never suggested onto a route

    const eligible = input.routes.filter((r) => r.gapByRole[fillRole] > 0 && windowCompatible(p.window, r.window));
    if (eligible.length === 0) continue; // scheduled, but no route gap they can fill — don't nag

    // Suggest the route with the largest matching gap (where help is wanted most), ties by truck name so the
    // choice is stable. Window compatibility is already enforced above.
    const suggested = [...eligible].sort(
      (a, b) => b.gapByRole[fillRole] - a.gapByRole[fillRole] || a.truckName.localeCompare(b.truckName),
    )[0];

    const reasons: string[] = [];
    reasons.push(
      p.window
        ? "on the Connecteam schedule today, not yet on a route"
        : "scheduled in Connecteam (work window not set), not yet on a route",
    );
    if (!p.window) reasons.push("route-window overlap not checked (no schedule time)");

    people.push({
      userId: p.userId,
      name: p.name,
      role: p.role,
      fillRole,
      title: p.title,
      window: p.window,
      suggestedRouteId: suggested.routeId,
      eligibleRouteIds: eligible.map((r) => r.routeId),
      reasons,
    });
  }

  return { reachable: true, people };
}

/**
 * Collapse a day's Connecteam shifts to one row per assigned person. PURE (testable without DB/network).
 *
 * The displayed window is the person's OWN EARLIEST Connecteam shift — NOT a min/max span across all their
 * shifts. The old span was the bug behind "7:30 AM – 2:30 AM": a driver on a morning shift (7:30a–1:00p)
 * who is ALSO an assignee on a shared late/evening shift (…–2:30a) had their window widened to cover the
 * dead time between them, and every person on that shared late shift ended up showing the SAME 2:30 AM end
 * while keeping their own start. A person's real shift hours are a real shift, never an invented span.
 */
export function collapseScheduledPeople(shifts: CrewShift[]): ScheduledPerson[] {
  const byUser = new Map<number, ScheduledPerson>();
  for (const cs of shifts) {
    const win =
      Number.isFinite(cs.startUnix) && Number.isFinite(cs.endUnix) && cs.endUnix > cs.startUnix
        ? { start: cs.startUnix, end: cs.endUnix }
        : null;
    for (const a of cs.assignees) {
      const prev = byUser.get(a.userId);
      if (!prev) {
        byUser.set(a.userId, { userId: a.userId, name: a.name, role: a.role, title: a.title ?? null, window: win });
      } else if (win && (!prev.window || win.start < prev.window.start)) {
        // Keep the person's earliest real shift window — do NOT span across separate shifts.
        prev.window = win;
      }
    }
  }
  return [...byUser.values()];
}

// ── Thin wrapper: the DB + Connecteam reads, then the pure detector ──────────────────────────────────────

/** Convert an ISO window (routeAssignWindow) to Unix seconds, or null when unknown. */
function toUnixWindow(w: { start: string | null; end: string | null; known: boolean }): { start: number; end: number } | null {
  if (!w.known || !w.start || !w.end) return null;
  const s = Math.floor(Date.parse(w.start) / 1000);
  const e = Math.floor(Date.parse(w.end) / 1000);
  return Number.isNaN(s) || Number.isNaN(e) ? null : { start: s, end: e };
}

/** Build the detector input for a day from the live routes, app shifts, and the Connecteam schedule, then
 *  classify. Reuses the SAME gap readers the pre-check uses (requiredCrewForRoute / assignedCrewForRoute /
 *  computeRouteGap), so the gap a person could fill is exactly the gap the pre-check shows. */
export async function scheduledUnroutedForDate(date: string): Promise<ScheduledUnroutedResult> {
  const trucks = getActiveVehicles();
  const routes = trucks
    .flatMap((t) => getRoutesForDate(t.truckId, date))
    .filter((r) => r.status !== "done" && r.stops.length > 0);

  if (!connecteamConfigured()) return { reachable: false, people: [] };
  const crew = await getCrewForDateSafe(date);
  if (!crew.ok) return { reachable: false, people: [] };

  const shifts = getShiftsForDate(date);
  const truckName = (id: string): string => trucks.find((t) => t.truckId === id)?.name ?? id;

  // Everyone on a route-tied app shift today (the real "on a route" signal — never a Connecteam schedule).
  const routeAssignedUserIds = shifts.filter((s) => s.routeId).flatMap((s) => s.assignees);

  // Collapse the day's Connecteam shifts to one row per person, each showing their own real shift window
  // (earliest shift — never a fabricated span across separate shifts). See collapseScheduledPeople.
  const scheduled = collapseScheduledPeople(crew.shifts);

  const routeCandidates: UnroutedRouteCandidate[] = routes.map((route) => {
    const routeShifts = shifts.filter((s) => s.routeId === route.routeId);
    const gap = computeRouteGap({
      requiredByRole: requiredCrewForRoute(route),
      assignedByRole: assignedCrewForRoute(route, routeShifts),
    });
    return {
      routeId: route.routeId,
      truckId: route.truckId,
      truckName: truckName(route.truckId),
      window: toUnixWindow(routeAssignWindow(route, routeShifts)),
      gapByRole: gap.gapByRole,
    };
  });

  return detectScheduledUnrouted({
    reachable: true,
    scheduled,
    routeAssignedUserIds,
    routes: routeCandidates,
  });
}

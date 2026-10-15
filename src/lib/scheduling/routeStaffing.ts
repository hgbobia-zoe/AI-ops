// Shared, authoritative per-route STAFFING STATE — the one source both Dispatch and Scheduling read so
// they never disagree about whether a route is covered. It REUSES the existing pre-check engine
// (requiredCrewForRoute / assignedCrewForRoute / computeRouteGap in ./preCheck) — the same pure, deterministic
// gap math the Scheduling "Staffing pre-check" already gates on — so Dispatch's "Understaffed · 1 open" and
// Scheduling's "needs 2 · 1 assigned · 1 open" come from ONE calculation.
//
// DESIGN LAW (docs/work-schedule-vs-route-assignment.md §2.2): a Connecteam WORK SHIFT is NOT a route
// assignment. "Covered" counts ONLY explicit app assignments (a Dispatch driver or an app staff_shift
// assignee). This selector is fully LOCAL + SYNC (no Connecteam, no LLM, no network) so Dispatch's frequent
// auto-refresh never hammers an external API — required crew comes from crew rules, assigned from the app.
//
// Unknown stays unknown: confirmation state is only knowable once the comms loop is live (SHIFT_COMMS_ENABLED);
// until then `confirmationsKnown` is false and `pendingConfirmations` is 0 (never a fabricated "all confirmed").

import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate } from "@/lib/db/repo";
import { getShiftsForDate } from "./store";
import { getAssignmentsForDate } from "./assignments";
import { isLiveAssignment } from "./lifecycle";
import { shiftCommsEnabled } from "./commsFlag";
import {
  requiredCrewForRoute,
  assignedCrewForRoute,
  computeRouteGap,
  type RouteGap,
} from "./preCheck";
import type { Route } from "@/lib/types";
import type { ShiftAssignment, StaffShift } from "./types";

/** One route's staffing state, ready to render on either blade. Extends the pure RouteGap verdict with the
 *  route identity, the authoritative recorded driver, and confirmation state. Serializable. */
export interface RouteStaffingState extends RouteGap {
  routeId: string;
  truckId: string;
  truckName: string;
  /** This route actually needs crew (has stops). An empty, not-yet-populated route requires nothing yet. */
  requiresCrew: boolean;
  /** A driver is RECORDED on the route in the app (Dispatch assignment or a driver app-shift assignee).
   *  Never inferred from a Connecteam schedule. */
  hasDriver: boolean;
  /** The recorded Dispatch driver's display name, when set. */
  driverName: string | null;
  /** Live assignments (internal + temp) on this route's shifts not yet confirmed. 0 when comms isn't wired. */
  pendingConfirmations: number;
  /** Whether confirmation state is knowable at all (comms loop live). false → pendingConfirmations is UNKNOWN. */
  confirmationsKnown: boolean;
  /** A short staffing label for a compact cell ("Fully staffed" / "Understaffed · 1 open" / "No crew assigned"). */
  label: string;
}

/** The day's staffing roll-up, for a blade header/summary strip. */
export interface DayStaffingSummary {
  date: string;
  routes: RouteStaffingState[];
  /** Routes that need crew (have stops). */
  routesRequiringCrew: number;
  /** Routes meeting their required crew (status "ok"). */
  routesCovered: number;
  /** Routes under-assigned (status "gap"). */
  routesWithGap: number;
  /** Total driver+field seats still unassigned across the day. */
  totalGapSeats: number;
  /** Live assignments across the day not yet confirmed (0 when comms isn't wired). */
  pendingConfirmations: number;
  confirmationsKnown: boolean;
}

/** Short, deterministic staffing label from the pure gap verdict. */
export function routeStaffingLabel(gap: RouteGap, requiresCrew: boolean): string {
  if (!requiresCrew) return "No crew required";
  if (gap.status === "ok") return "Fully staffed";
  if (gap.nobody) return "No crew assigned";
  return `Understaffed · ${gap.totalGap} open`;
}

/** Count live (non-terminal, acknowledged-pending) assignments on a set of shifts that are not yet confirmed. */
function pendingConfirmationsFor(routeShiftIds: string[], assignmentsByShift: Map<string, ShiftAssignment[]>): number {
  let n = 0;
  for (const id of routeShiftIds) {
    for (const a of assignmentsByShift.get(id) ?? []) {
      if (isLiveAssignment(a.state) && a.confirmedAt == null) n++;
    }
  }
  return n;
}

/** Pure assembly from data already in hand. Scheduling (which already holds routes + shifts + assignments)
 *  uses this directly so its numbers are literally the same calculation Dispatch shows. */
export function buildRouteStaffingStates(
  routes: Route[],
  shifts: StaffShift[],
  assignmentsByShift: Map<string, ShiftAssignment[]>,
  commsWired: boolean,
  truckName: (id: string) => string,
): RouteStaffingState[] {
  return routes
    .filter((r) => r.status !== "done")
    .map((route) => {
      const routeShifts = shifts.filter((s) => s.routeId === route.routeId);
      const requiresCrew = route.stops.length > 0;
      const required = requiredCrewForRoute(route);
      const assigned = assignedCrewForRoute(route, routeShifts);
      const gap = computeRouteGap({ requiredByRole: required, assignedByRole: assigned });
      const hasDriver = Boolean(route.driverId) || assigned.driver > 0;
      const pending = commsWired ? pendingConfirmationsFor(routeShifts.map((s) => s.id), assignmentsByShift) : 0;
      return {
        ...gap,
        routeId: route.routeId,
        truckId: route.truckId,
        truckName: truckName(route.truckId),
        requiresCrew,
        hasDriver,
        driverName: route.driverName ?? null,
        pendingConfirmations: pending,
        confirmationsKnown: commsWired,
        label: routeStaffingLabel(gap, requiresCrew),
      } satisfies RouteStaffingState;
    });
}

/** Roll a list of per-route states into a day summary. Only routes that actually need crew count toward
 *  covered/gap, matching the Scheduling pre-check (which ignores empty routes). */
export function summarizeDayStaffing(date: string, states: RouteStaffingState[], confirmationsKnown: boolean): DayStaffingSummary {
  const needing = states.filter((s) => s.requiresCrew);
  return {
    date,
    routes: states,
    routesRequiringCrew: needing.length,
    routesCovered: needing.filter((s) => s.status === "ok").length,
    routesWithGap: needing.filter((s) => s.status === "gap").length,
    totalGapSeats: needing.reduce((n, s) => n + s.totalGap, 0),
    pendingConfirmations: states.reduce((n, s) => n + s.pendingConfirmations, 0),
    confirmationsKnown,
  };
}

/** Dispatch convenience: read the DB for a date and assemble the day's staffing summary. Fully LOCAL + SYNC
 *  (no Connecteam), so it is safe to call on Dispatch's frequent auto-refresh. */
export function getDayStaffingSummary(date: string): DayStaffingSummary {
  const trucks = getActiveVehicles();
  const routes = trucks.flatMap((t) => getRoutesForDate(t.truckId, date)).filter((r) => r.status !== "done");
  const shifts = getShiftsForDate(date);
  const assignmentsByShift = getAssignmentsForDate(date);
  const commsWired = shiftCommsEnabled();
  const truckName = (id: string): string => trucks.find((t) => t.truckId === id)?.name ?? id;
  const states = buildRouteStaffingStates(routes, shifts, assignmentsByShift, commsWired, truckName);
  return summarizeDayStaffing(date, states, commsWired);
}

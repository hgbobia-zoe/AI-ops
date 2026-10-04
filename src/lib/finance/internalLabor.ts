// FI-Phase 4 — source INTERNAL labor from the per-worker shift_assignments entity (drivers + FIELD +
// PREP), not just the Connecteam driver-day window. This is the DATA-SOURCE swap at the module boundary
// the design doc calls for: it produces the exact `WorkerShiftCost` rows the existing laborAttribution
// cascade already understands, so NONE of the allocation math changes.
//
// Pure + unit-testable (no DB): the caller (risk/scan.ts) fetches the day's staff_shifts + assignments +
// Connecteam pay rates and passes them in. Honesty (the house law): an unknown window or rate → the hours
// or cost stay null (excluded, surfaced), never fabricated to 0.
//
// ANTI-DOUBLE-COUNT: a worker is aggregated to EXACTLY ONE WorkerShiftCost per day (keyed by their
// Connecteam userId), summing their shift windows and unioning the routes they served. The caller uses
// this source OR the legacy driver-day source for a given day, never both — so no (worker, day) is
// counted twice and the reconciliation invariant (Σ leaves === shift cost) is preserved.

import { shiftWindowHours } from "@/lib/scheduling/cost";
import type { AssignmentState, ShiftAssignment, ShiftRole, StaffShift } from "@/lib/scheduling/types";
import type { WorkerShiftCost } from "./laborAttribution";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** States that represent a worker actually committed to the shift (so their planned labor is costed).
 *  PROPOSED is an uncommitted suggestion; DECLINED/NO_SHOW/CANCELLED/REPLACED did not work — all excluded. */
const COSTABLE_STATES: ReadonlySet<AssignmentState> = new Set<AssignmentState>([
  "ASSIGNED",
  "NOTIFIED",
  "CONFIRMED",
  "CLOCKED_IN",
  "CLOCKED_OUT",
]);

/** The subset of a staff_shift the cost source needs (window + route). */
type ShiftFacts = Pick<StaffShift, "id" | "routeId" | "startTime" | "endTime" | "windowKnown">;

interface WorkerAcc {
  userId: number;
  displayName?: string;
  hours: number; // sum of KNOWN shift-window hours
  hoursKnown: boolean; // any window known at all
  routes: Set<string>;
  roles: Set<ShiftRole>;
}

/** driver > field > prep: only `prep` is special in the cascade (whole slice → non-customer), so a worker
 *  with any route-bearing role is treated as route labor; a purely-prep worker stays prep. */
function rollupRole(roles: Set<ShiftRole>): ShiftRole {
  if (roles.has("driver")) return "driver";
  if (roles.has("field")) return "field";
  return "prep";
}

/**
 * Build internal `WorkerShiftCost` rows for a day from its shift_assignments. One row per Connecteam
 * worker (aggregated across all their shifts that day), costed at their Connecteam rate. Returns [] when
 * the day has no costable internal assignments — the signal for the caller to fall back to the legacy
 * driver-day source (graceful degradation).
 */
export function internalShiftCostsFromAssignments(
  date: string,
  shifts: ShiftFacts[],
  assignmentsByShift: Map<string, ShiftAssignment[]>,
  rateFor: (userId: number) => number | null,
): WorkerShiftCost[] {
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const byUser = new Map<number, WorkerAcc>();

  for (const [shiftId, assignments] of assignmentsByShift) {
    const shift = shiftById.get(shiftId);
    if (!shift) continue;
    const wh = shiftWindowHours({ startTime: shift.startTime, endTime: shift.endTime, windowKnown: shift.windowKnown });
    for (const a of assignments) {
      if (a.workerKind !== "internal" || a.connecteamUserId == null) continue;
      if (!COSTABLE_STATES.has(a.state)) continue;
      const acc =
        byUser.get(a.connecteamUserId) ??
        ({ userId: a.connecteamUserId, hours: 0, hoursKnown: false, routes: new Set<string>(), roles: new Set<ShiftRole>() } satisfies WorkerAcc);
      if (wh != null) {
        acc.hours += wh;
        acc.hoursKnown = true;
      }
      if (shift.routeId) acc.routes.add(shift.routeId);
      acc.roles.add(a.role);
      if (!acc.displayName && a.displayName) acc.displayName = a.displayName;
      byUser.set(a.connecteamUserId, acc);
    }
  }

  const out: WorkerShiftCost[] = [];
  for (const acc of byUser.values()) {
    const rate = rateFor(acc.userId);
    const hours = acc.hoursKnown ? round2(acc.hours) : null;
    const cost = hours != null && rate != null ? round2(hours * rate) : null;
    out.push({
      workerKey: `ct:${acc.userId}`,
      kind: "internal",
      displayName: acc.displayName,
      role: rollupRole(acc.roles),
      routesServed: [...acc.routes],
      hours,
      rate,
      cost,
      // Scheduled assignments are PLANNED (not timesheet-verified); the cascade labels every leaf ESTIMATED
      // regardless, so this never presents a planned split as an ACTUAL.
      status: "PLANNED",
    });
  }
  // Stable order (by userId) so the derived ledger is deterministic across scans.
  out.sort((a, b) => a.workerKey.localeCompare(b.workerKey));
  return out;
}

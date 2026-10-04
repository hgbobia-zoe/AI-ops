// Pure derivation of the DB writes an optimizer StaffingPlan implies, so the write path (the
// /optimize/apply route) is a thin, auditable executor over a unit-testable function. RULES CALCULATE:
// this only re-shapes the plan the optimizer already computed into per-shift intent; it makes no new
// staffing decision and reaches no integration.
//
// Honest boundary (lifecycle doc + cost-opt doc): INTERNAL picks become real assignments (dual-write to
// assignees). TEMP seats are RECORDED as a recommendation (count + reason + est hours) only — never a
// booked assignment row and never an Instawork post (that stays record-only until the gig-post write is
// captured). So apply writes exactly the half we control (internal) and records the rest.

import type { PlannedAssignment, StaffingPlan } from "./optimize";

export interface PlanShiftWrite {
  shiftId: string;
  routeId: string | null;
  /** Internal Connecteam userIds the plan places on this shift (the new assignees set for it). */
  internalUserIds: number[];
  /** Per-internal-seat detail for the economics snapshot + audit note. */
  internal: Array<{ userId: number; hours: number | null; whyThisRoute: string; moved: boolean; fromRouteId: string | null }>;
  /** Temp seats the plan leaves on this shift (recorded as a recommendation, not posted). */
  tempCount: number;
  /** Deterministic reason strings from the optimizer (first temp seat), null when no temp. */
  tempReason: string | null;
  routeReason: string | null;
  /** Sum of temp seat hours on this shift (null when any seat's window is unknown → not summable). */
  tempHours: number | null;
}

/** Map a human temp reason sentence back to the stored enum (temp_reason column), honestly. */
function tempReasonCode(why: string | null): string | null {
  if (!why) return null;
  return /qualified/i.test(why) ? "no_internal_qualified" : "internal_exhausted";
}

/**
 * Re-shape an optimizer plan into per-shift write intent. Pure + deterministic. Only shifts the optimizer
 * actually touched (its optimization surface) appear; everything else is left alone by the caller.
 */
export function derivePlanWrites(plan: StaffingPlan): PlanShiftWrite[] {
  const byShift = new Map<string, PlannedAssignment[]>();
  for (const a of plan.assignments) {
    const list = byShift.get(a.shiftId) ?? [];
    list.push(a);
    byShift.set(a.shiftId, list);
  }

  const writes: PlanShiftWrite[] = [];
  for (const [shiftId, seats] of byShift) {
    const internalSeats = seats.filter((s) => s.kind === "internal" && s.userId != null);
    const tempSeats = seats.filter((s) => s.kind === "temp");
    const tempHoursKnown = tempSeats.every((s) => s.hours != null);
    writes.push({
      shiftId,
      routeId: seats[0]?.routeId ?? null,
      internalUserIds: internalSeats.map((s) => s.userId as number),
      internal: internalSeats.map((s) => ({ userId: s.userId as number, hours: s.hours, whyThisRoute: s.whyThisRoute, moved: s.moved, fromRouteId: s.fromRouteId })),
      tempCount: tempSeats.length,
      tempReason: tempReasonCode(tempSeats[0]?.whyTemp ?? null),
      routeReason: tempSeats.length > 0 ? "shortest_eligible_route" : null,
      tempHours: tempSeats.length === 0 ? null : tempHoursKnown ? Math.round(tempSeats.reduce((n, s) => n + (s.hours ?? 0), 0) * 100) / 100 : null,
    });
  }
  // Stable order for deterministic application + tests.
  return writes.sort((a, b) => a.shiftId.localeCompare(b.shiftId));
}

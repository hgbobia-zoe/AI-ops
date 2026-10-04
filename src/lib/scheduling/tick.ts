// Pure helpers for the runtime shift-lifecycle tick (and the board), so the tick's core logic is
// deterministic + unit-testable. RULES CALCULATE: these assemble readiness inputs and lifecycle facts
// from already-known data; they decide nothing an LLM should, and never fabricate (unknown stays unknown).

import type { ShiftReadinessInput } from "./readiness";
import type { ShiftLifecycleFacts } from "./lifecycle";
import type { ShiftAssignment, StaffShift } from "./types";

/** Build the readiness input for a shift from its coverage gap + live per-worker assignments. Shared by
 *  the board and the tick so both score identically. COMMUNICATION/CONFIRMATION stay UNVERIFIED until the
 *  comms loop is live (commsWired); TIMEKEEPING is a real LINK (internal once published, temp once booked). */
export function buildReadinessInput(
  shift: StaffShift,
  gap: number,
  live: ShiftAssignment[],
  opts: { coverageOk: boolean; commsWired: boolean },
): ShiftReadinessInput {
  const assignmentCount = live.length;
  const timekeepingLinked =
    assignmentCount > 0 &&
    live.every((a) => (a.workerKind === "internal" ? Boolean(shift.connecteamShiftId) : Boolean(a.instaworkGigId)));
  return {
    gap,
    staffingUnverified: !opts.coverageOk,
    hasRoute: Boolean(shift.routeId),
    truckSet: Boolean(shift.truckId),
    windowKnown: shift.windowKnown,
    reportTimeSet: Boolean(shift.reportTime) || (shift.windowKnown && Boolean(shift.startTime)),
    reportLocationSet: Boolean(shift.reportLocation || shift.location),
    assignmentCount,
    allPacketsSent: assignmentCount > 0 && live.every((a) => a.packetSentAt != null),
    commsUnverified: !opts.commsWired,
    timekeepingLinked,
    timekeepingUnverified: false,
    allConfirmed: assignmentCount > 0 && live.every((a) => a.confirmedAt != null),
    confirmationUnverified: !opts.commsWired,
  };
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Assemble the deterministic facts the shift lifecycle rolls up from (D.4). "Posted/recorded" counts a
 *  recorded Instawork request (instaworkHeadcount) as well as a real gig id, per the design. */
export function buildLifecycleFacts(
  shift: StaffShift,
  gap: number,
  live: ShiftAssignment[],
  flags: { readinessReady: boolean; blockingException: boolean; now: number },
): ShiftLifecycleFacts {
  return {
    cancelled: shift.status === "cancelled",
    gap,
    windowKnown: shift.windowKnown,
    published: Boolean(shift.connecteamShiftId),
    gigPosted: Boolean(shift.instaworkGigId) || shift.instaworkHeadcount > 0,
    assignmentCount: live.length,
    allPacketsSent: live.length > 0 && live.every((a) => a.packetSentAt != null),
    allConfirmed: live.length > 0 && live.every((a) => a.confirmedAt != null),
    readinessReady: flags.readinessReady,
    anyClockIn: live.some((a) => a.clockInAt != null),
    blockingException: flags.blockingException,
    now: flags.now,
    startMs: shift.windowKnown ? parseMs(shift.startTime) : null,
    endMs: shift.windowKnown ? parseMs(shift.endTime) : null,
  };
}

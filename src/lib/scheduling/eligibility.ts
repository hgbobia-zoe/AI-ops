// The one deterministic eligibility classifier every scheduling engine reads. It exists to kill a single
// architectural conflation: the old code asked "does this worker have ANY overlapping Connecteam shift?"
// and used the answer to mean BOTH "they're busy" (availability.ts/optimize.ts) AND "they're already
// covering a route" (coverage.ts) — two opposite misreadings of the same work-schedule window. See
// docs/work-schedule-vs-route-assignment.md.
//
// The distinction this draws, from records that already exist:
//   • WORK SCHEDULE  — a Connecteam shift = "expected to work that day." SOFT. It makes someone a
//                      PREFERRED candidate (convert a sunk commitment into coverage), never "busy".
//   • ROUTE ASSIGNMENT — a Zoe staff_shifts.assignees entry overlapping the window = ASSIGNED. HARD:
//                      not double-offered to another route (unless a reassign/override).
//   • AVAILABILITY   — a Connecteam time-off / unavailability block overlapping the window = UNAVAILABLE.
//                      HARD. This is the real "they marked their calendar" signal (now that the
//                      /scheduler/v1/.../user-unavailability feed exists — connecteam.ts). It is NOT an
//                      inference and NOT a manual flag; when the feed didn't answer we say so (availability
//                      unknown) and never fabricate the block's absence into a confident "free".
//
// RULES CALCULATE, AI INTERPRETS: every state here is a pure function of (Connecteam shifts, Connecteam
// unavailability blocks, Zoe assignments, route window, feed-reachability). No LLM participates; AI only
// narrates the deterministic `reasons[]` after the fact.

import type { CrewShift, UnavailabilityBlock, UnavailabilityKind } from "@/lib/connecteam";

export type WorkerEligibility =
  | "AVAILABLE" // free this window, nothing scheduled
  | "SCHEDULED_UNASSIGNED" // on the Connecteam schedule covering this window, no Zoe route yet → PREFERRED
  | "ASSIGNED" // already on a Zoe route overlapping this window (this shift or another)
  | "SCHEDULE_CONFLICT" // scheduled, but the work window only partially covers the route (soft flag)
  | "UNAVAILABLE"; // a Connecteam time-off / unavailability block overlaps this window (hard)

/** A Zoe route assignment window (one per worker × staff_shift). Windows may be unknown (null). */
export interface AssignmentWindow {
  userId: number;
  shiftId: string;
  start: number | null; // Unix seconds
  end: number | null;
}

export interface EligibilityInput {
  userId: number;
  /** The role being filled — the caller still gates on role qualification (candidateRoles). */
  routeWindow: { start: number; end: number } | null; // Unix seconds; null = window not yet known
  /** Connecteam work-schedule shifts for the day (any workers; filtered by userId here). */
  dayShifts: CrewShift[];
  /** Zoe route assignments overlapping the day (any workers; filtered by userId here). */
  assignments: AssignmentWindow[];
  /** This worker's Connecteam time-off / unavailability blocks (already scoped to the user). */
  unavailability: UnavailabilityBlock[];
  /** Did the Connecteam unavailability feed actually answer for this worker? false → availability UNKNOWN,
   *  so we never treat "no block seen" as a confident "free". */
  availabilityKnown: boolean;
  /** The shift currently being filled — an assignment to THIS shift reads as "already on this route". */
  thisShiftId?: string;
}

export interface EligibilityResult {
  state: WorkerEligibility;
  /** Can this worker be placed on THIS route right now? */
  eligible: boolean;
  /** Turn a sunk commitment into coverage: SCHEDULED_UNASSIGNED ranks above a fully-unscheduled AVAILABLE. */
  preferred: boolean;
  /** True only when the Connecteam availability feed answered; false → "availability unknown", shown as such. */
  availabilityKnown: boolean;
  /** Deterministic, human-free facts for the UI / for AI to narrate later. */
  reasons: string[];
  /** The conflicting block, when state is UNAVAILABLE. */
  block?: { start: number; end: number; kind: UnavailabilityKind; reason?: string };
  /** The worker's own Connecteam work window touching this route (for SCHEDULED_UNASSIGNED / SCHEDULE_CONFLICT). */
  scheduleWindow?: { start: number; end: number };
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd && bStart < aEnd;
const covers = (outerStart: number, outerEnd: number, innerStart: number, innerEnd: number): boolean =>
  outerStart <= innerStart && outerEnd >= innerEnd;

/**
 * Classify one (worker, candidate route+window). Pure + deterministic. Precedence, strongest constraint
 * first: already-on-this-route → UNAVAILABLE (marked off) → ASSIGNED elsewhere → SCHEDULED/CONFLICT →
 * AVAILABLE. A Connecteam shift NEVER makes someone ineligible on its own — only a Zoe assignment or a
 * real time-off block does.
 */
export function eligibilityFor(input: EligibilityInput): EligibilityResult {
  const { userId, routeWindow, dayShifts, assignments, unavailability, availabilityKnown, thisShiftId } = input;
  const reasons: string[] = [];
  const base = { preferred: false, availabilityKnown };

  // The worker's own windows, pulled from the shared day data.
  const myShifts = dayShifts
    .filter((s) => s.assignees.some((a) => a.userId === userId))
    .map((s) => ({ start: s.startUnix, end: s.endUnix }));
  const myAssignments = assignments.filter((a) => a.userId === userId && a.start != null && a.end != null) as Array<{
    userId: number;
    shiftId: string;
    start: number;
    end: number;
  }>;

  // Window unknown → we can't do overlap math. Don't fabricate a conflict; flag it and let the human set the time.
  if (!routeWindow) {
    if (!availabilityKnown) reasons.push("availability unverified (Connecteam feed did not answer)");
    reasons.push("route window not set — schedule conflicts not checked");
    const scheduledToday = myShifts.length > 0;
    return {
      state: scheduledToday ? "SCHEDULED_UNASSIGNED" : "AVAILABLE",
      eligible: true,
      preferred: scheduledToday,
      availabilityKnown,
      reasons,
    };
  }

  const { start, end } = routeWindow;
  if (!availabilityKnown) reasons.push("availability unverified (Connecteam feed did not answer)");

  // 1. Already committed to THIS route.
  if (thisShiftId && myAssignments.some((a) => a.shiftId === thisShiftId)) {
    reasons.push("already on this route");
    return { ...base, state: "ASSIGNED", eligible: false, reasons };
  }

  // 2. UNAVAILABLE — a real time-off / unavailability block overlaps the route window. Hard, and it wins
  //    over a work shift (a marked-off worker is out even if also "scheduled").
  const block = unavailability.find((b) => overlaps(start, end, b.startUnix, b.endUnix));
  if (block) {
    const label = block.kind === "timeOff" ? "time off" : "marked unavailable";
    reasons.push(block.reason ? `${label}: ${block.reason}` : label);
    return {
      ...base,
      state: "UNAVAILABLE",
      eligible: false,
      reasons,
      block: { start: block.startUnix, end: block.endUnix, kind: block.kind, reason: block.reason },
    };
  }

  // 3. ASSIGNED elsewhere — on another Zoe route overlapping this window. Not double-offered.
  const clash = myAssignments.find((a) => overlaps(start, end, a.start, a.end));
  if (clash) {
    reasons.push("already assigned to another route this window");
    return { ...base, state: "ASSIGNED", eligible: false, reasons };
  }

  // 4. On the Connecteam work schedule touching this window? Soft — a candidate, never "busy".
  const touching = myShifts.filter((s) => overlaps(start, end, s.start, s.end));
  if (touching.length > 0) {
    const fullyCovers = touching.some((s) => covers(s.start, s.end, start, end));
    const w = touching[0];
    if (fullyCovers) {
      reasons.push("on the schedule this window, not yet on a route");
      return { ...base, state: "SCHEDULED_UNASSIGNED", eligible: true, preferred: true, reasons, scheduleWindow: w };
    }
    // Partial: scheduled, but the work window doesn't fully cover the route. Still eligible (the shift is a
    // soft signal, not a constraint) but flagged so the dispatcher sees the edges don't line up.
    reasons.push("scheduled nearby, but the work window does not fully cover this route");
    return { ...base, state: "SCHEDULE_CONFLICT", eligible: true, preferred: true, reasons, scheduleWindow: w };
  }

  // 5. Nothing scheduled this window → free.
  reasons.push("free this window, not scheduled");
  return { ...base, state: "AVAILABLE", eligible: true, reasons };
}

// Availability-based crew recommendations — the heart of the scheduling redesign. Instead of guessing
// who's covering a shift, we recommend who's actually ELIGIBLE for it, through the one deterministic
// classifier every engine reads (eligibilityFor): the right role for the shift (hard pre-gate), not
// already on an overlapping Zoe route, not on a real Connecteam time-off block — and a worker who is on
// the Connecteam schedule but has no Zoe route yet is SCHEDULED_UNASSIGNED → eligible AND PREFERRED (a
// sunk commitment to turn into coverage), never "busy". Preferred first, least-loaded as the tiebreaker.
// The human then picks (or posts to Instawork). Pure + deterministic.
//
// Role grounding (from Zoe's real Connecteam titles): driver → "Driver"/"Delivery Driver"; prep →
// "Warehouse Associate"/"Event Asset Processor". Office/admin titles (Operations Coordinator, Executive
// Assistant, Digital Sales Marketer, any `manager` type) map to CrewRole "other" and are NEVER
// recommended. There is NO internal "field" title — field/tent help is Instawork "General Labor" (or a
// free warehouse person pulled over), so a field shift recommends free PREP crew as optional helpers and
// the UI points to Instawork for the rest.

import type { CrewMember, CrewShift, CrewRole, UnavailabilityBlock } from "@/lib/connecteam";
import { eligibilityFor, type AssignmentWindow, type EligibilityResult } from "./eligibility";
import type { ShiftRole, StaffShift } from "./types";

/** Which Connecteam crew roles can fill a scheduling role. "other" (office/admin) is never included. */
export function candidateRoles(role: ShiftRole): CrewRole[] {
  if (role === "driver") return ["driver"];
  if (role === "prep") return ["prep"];
  return ["prep"]; // field: no internal field title → free warehouse/prep as optional helpers (else Instawork)
}

export interface CrewRecommendation {
  userId: number;
  name: string;
  role: CrewRole;
  bookedHours: number; // already-assigned hours that day
  reason: string;
  /** The eligibility state behind the pick (SCHEDULED_UNASSIGNED = the sunk-commitment pick), for the UI. */
  state: EligibilityResult["state"];
  /** SCHEDULED_UNASSIGNED ranks ahead of a fully-unscheduled AVAILABLE worker. */
  preferred: boolean;
  /** False → the Connecteam availability feed did not answer for this worker (shown as "unverified"). */
  availabilityKnown: boolean;
}

/** Everything the classifier needs that the caller already holds, so recommendCrew doesn't re-pull it. */
export interface RecommendContext {
  /** Zoe route assignments across the day (staff_shifts.assignees → windows). */
  assignments: AssignmentWindow[];
  /** The day's Connecteam time-off / unavailability blocks, keyed by userId (only users WITH blocks). */
  unavailabilityByUser: Map<number, UnavailabilityBlock[]>;
  /** Did the Connecteam availability feed answer for the day? false → "availability unverified". */
  availabilityKnown: boolean;
}

const EMPTY_CTX: RecommendContext = { assignments: [], unavailabilityByUser: new Map(), availabilityKnown: true };

/** Hours each user is already booked across the day's Connecteam shifts. */
function bookedHoursByUser(dayShifts: CrewShift[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of dayShifts) {
    const h = Math.max(0, (s.endUnix - s.startUnix) / 3600);
    for (const a of s.assignees) m.set(a.userId, (m.get(a.userId) ?? 0) + h);
  }
  return m;
}

function bookedLabel(bookedHours: number): string {
  if (bookedHours <= 0) return "not booked today";
  return `${bookedHours % 1 === 0 ? bookedHours : bookedHours.toFixed(1)}h booked`;
}

/**
 * Recommend eligible, role-matched crew for a shift, through the shared eligibility classifier. `dayShifts`
 * are the Connecteam work-schedule shifts that day; `ctx` carries the Zoe assignments + Connecteam
 * unavailability the classifier needs. Role qualification (candidateRoles) is the hard pre-gate; anyone the
 * classifier marks ineligible (UNAVAILABLE, or ASSIGNED to an overlapping route) is dropped. Returns up to
 * `limit`, SCHEDULED_UNASSIGNED (preferred) ahead of AVAILABLE, least-loaded as the tiebreaker.
 */
export function recommendCrew(
  shift: StaffShift,
  dayShifts: CrewShift[],
  roster: CrewMember[],
  ctx: RecommendContext = EMPTY_CTX,
  limit = 5,
): CrewRecommendation[] {
  const start = shift.startTime ? Date.parse(shift.startTime) / 1000 : null;
  const end = shift.endTime ? Date.parse(shift.endTime) / 1000 : null;
  const routeWindow = start != null && end != null && !Number.isNaN(start) && !Number.isNaN(end) ? { start, end } : null;
  const roles = candidateRoles(shift.role);

  const booked = bookedHoursByUser(dayShifts);
  const already = new Set(shift.assignees);

  return roster
    .filter((u) => roles.includes(u.role) && !already.has(u.userId))
    .map((u) => {
      const elig = eligibilityFor({
        userId: u.userId,
        routeWindow,
        dayShifts,
        assignments: ctx.assignments,
        unavailability: ctx.unavailabilityByUser.get(u.userId) ?? [],
        availabilityKnown: ctx.availabilityKnown,
        thisShiftId: shift.id || undefined,
      });
      return { u, elig, bookedHours: booked.get(u.userId) ?? 0 };
    })
    .filter((c) => c.elig.eligible)
    .sort(
      (a, b) =>
        Number(b.elig.preferred) - Number(a.elig.preferred) ||
        a.bookedHours - b.bookedHours ||
        a.u.name.localeCompare(b.u.name),
    )
    .slice(0, limit)
    .map((c) => {
      const scheduled = c.elig.state === "SCHEDULED_UNASSIGNED" || c.elig.state === "SCHEDULE_CONFLICT";
      const lead = scheduled ? "On the schedule, not yet on a route" : "Free this window";
      const unverified = c.elig.availabilityKnown ? "" : " · availability unverified";
      return {
        userId: c.u.userId,
        name: c.u.name,
        role: c.u.role,
        bookedHours: c.bookedHours,
        reason: `${lead} · ${bookedLabel(c.bookedHours)}${unverified}`,
        state: c.elig.state,
        preferred: c.elig.preferred,
        availabilityKnown: c.elig.availabilityKnown,
      };
    });
}

// Availability-based crew recommendations — the heart of the scheduling redesign. Instead of guessing
// who's covering a shift, we recommend who's actually FREE for it: the right role for the shift, not
// already on an overlapping Connecteam shift that day, least-loaded first. The human then picks (or posts
// to Instawork). This is an INFERENCE from the Connecteam schedule ("free at this time"), not a personal
// calendar — the UI says so. Pure + deterministic.
//
// Role grounding (from Zoe's real Connecteam titles): driver → "Driver"/"Delivery Driver"; prep →
// "Warehouse Associate"/"Event Asset Processor". Office/admin titles (Operations Coordinator, Executive
// Assistant, Digital Sales Marketer, any `manager` type) map to CrewRole "other" and are NEVER
// recommended. There is NO internal "field" title — field/tent help is Instawork "General Labor" (or a
// free warehouse person pulled over), so a field shift recommends free PREP crew as optional helpers and
// the UI points to Instawork for the rest.

import type { CrewMember, CrewShift, CrewRole } from "@/lib/connecteam";
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
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd && bStart < aEnd;

/** Hours each user is already booked across the day's Connecteam shifts. */
function bookedHoursByUser(dayShifts: CrewShift[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of dayShifts) {
    const h = Math.max(0, (s.endUnix - s.startUnix) / 3600);
    for (const a of s.assignees) m.set(a.userId, (m.get(a.userId) ?? 0) + h);
  }
  return m;
}

/**
 * Recommend free, role-matched crew for a shift. `dayShifts` are the Connecteam shifts that day (to see
 * who's busy during this window); `roster` is everyone. Returns up to `limit`, least-loaded first.
 * When the shift has no known window, we can't check overlaps, so we rank by role + least-loaded only.
 */
export function recommendCrew(shift: StaffShift, dayShifts: CrewShift[], roster: CrewMember[], limit = 5): CrewRecommendation[] {
  const start = shift.startTime ? Date.parse(shift.startTime) / 1000 : null;
  const end = shift.endTime ? Date.parse(shift.endTime) / 1000 : null;
  const roles = candidateRoles(shift.role);

  const busy = new Set<number>();
  if (start != null && end != null && !Number.isNaN(start) && !Number.isNaN(end)) {
    for (const s of dayShifts) {
      if (overlaps(start, end, s.startUnix, s.endUnix)) for (const a of s.assignees) busy.add(a.userId);
    }
  }
  const booked = bookedHoursByUser(dayShifts);
  const already = new Set(shift.assignees);

  return roster
    .filter((u) => roles.includes(u.role) && !busy.has(u.userId) && !already.has(u.userId))
    .map((u) => ({ userId: u.userId, name: u.name, role: u.role, bookedHours: booked.get(u.userId) ?? 0 }))
    .sort((a, b) => a.bookedHours - b.bookedHours || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((c) => ({
      ...c,
      reason: `Free this window · ${c.bookedHours <= 0 ? "not booked today" : `${c.bookedHours % 1 === 0 ? c.bookedHours : c.bookedHours.toFixed(1)}h booked`}`,
    }));
}

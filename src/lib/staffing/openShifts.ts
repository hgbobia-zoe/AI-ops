// Open-shift detection + crew suggestions. A shift that's on the Connecteam schedule with NOBODY
// assigned is a coverage hole. For each one we suggest who could take it — grounded ONLY in the real
// schedule: the right role for the shift, and no other shift overlapping that time (so they're actually
// free), least-loaded first. This is an INFERENCE from the schedule ("free at that time"), NOT a claim
// about anyone's personal availability calendar — the UI must say so. Pure + deterministic.

import type { CrewShift, CrewMember, CrewRole } from "@/lib/connecteam";

export type NeededRole = CrewRole | "any";

export interface CrewSuggestion {
  member: CrewMember;
  bookedHours: number; // hours this person is already assigned that day
  roleMatch: boolean; // their role matches what the shift looks like it needs
  reason: string;
}

export interface OpenShiftView {
  shift: CrewShift;
  neededRole: NeededRole;
  suggestions: CrewSuggestion[];
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd && bStart < aEnd;

/** Infer the role a shift needs from its title. Conservative — unknown ⇒ "any" (suggest everyone free). */
export function neededRoleFor(title: string): NeededRole {
  const t = (title || "").toLowerCase();
  if (/\b(driver|delivery|deliver|route|truck|pickup|pick[\s-]?up|dispatch)\b/.test(t)) return "driver";
  if (/\b(warehouse|load|prep|pull|stage|return|unload|clean|asset)\b/.test(t)) return "prep";
  return "any";
}

const ROLE_LABEL: Record<CrewRole, string> = { driver: "Driver", prep: "Warehouse/prep", other: "Crew" };

/** Hours each user is already booked among the day's assigned shifts. */
function bookedHoursByUser(dayShifts: CrewShift[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of dayShifts) {
    const h = Math.max(0, (s.endUnix - s.startUnix) / 3600);
    for (const a of s.assignees) m.set(a.userId, (m.get(a.userId) ?? 0) + h);
  }
  return m;
}

function reasonFor(roleMatch: boolean, neededRole: NeededRole, member: CrewMember, bookedHours: number): string {
  const roleBit = neededRole === "any" ? ROLE_LABEL[member.role] : roleMatch ? `${ROLE_LABEL[member.role]} ✓` : ROLE_LABEL[member.role];
  const loadBit = bookedHours <= 0 ? "not booked today" : `${bookedHours % 1 === 0 ? bookedHours : bookedHours.toFixed(1)}h booked today`;
  return `Free at this time · ${roleBit} · ${loadBit}`;
}

/** Candidates for one open shift: everyone with no overlapping assigned shift, ranked role-first then
 *  least-loaded. `limit` caps the list. */
export function suggestForOpenShift(open: CrewShift, dayShifts: CrewShift[], allUsers: CrewMember[], limit = 5): OpenShiftView {
  const busy = new Set<number>();
  for (const s of dayShifts) {
    if (s.id === open.id) continue;
    if (overlaps(open.startUnix, open.endUnix, s.startUnix, s.endUnix)) for (const a of s.assignees) busy.add(a.userId);
  }
  const neededRole = neededRoleFor(open.title);
  const booked = bookedHoursByUser(dayShifts);

  const suggestions = allUsers
    .filter((u) => !busy.has(u.userId))
    .map((u) => {
      const roleMatch = neededRole === "any" ? true : u.role === neededRole;
      const bookedHours = booked.get(u.userId) ?? 0;
      return { member: u, bookedHours, roleMatch, reason: "" };
    })
    .sort((a, b) => Number(b.roleMatch) - Number(a.roleMatch) || a.bookedHours - b.bookedHours || a.member.name.localeCompare(b.member.name))
    .slice(0, limit)
    .map((c) => ({ ...c, reason: reasonFor(c.roleMatch, neededRole, c.member, c.bookedHours) }));

  return { shift: open, neededRole, suggestions };
}

/** All open (unassigned) shifts in a day, each with suggested crew. A shift is open when nobody is
 *  assigned (covers Connecteam's explicit "open shift" flag and any zero-assignee shift). */
export function openShiftsWithSuggestions(dayShifts: CrewShift[], allUsers: CrewMember[], limit = 5): OpenShiftView[] {
  return dayShifts
    .filter((s) => s.assignees.length === 0)
    .sort((a, b) => a.startUnix - b.startUnix)
    .map((s) => suggestForOpenShift(s, dayShifts, allUsers, limit));
}

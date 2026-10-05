// Coverage netting — reconcile the day's demand against the people ACTUALLY committed to each route
// (staff_shifts.assignees). Pure + deterministic.
//
// IMPORTANT (the refinement in docs/work-schedule-vs-route-assignment.md §2.2): a Connecteam WORK SHIFT is
// NOT a route assignment. This function used to silently credit a scheduled-but-unassigned driver/prep as
// "covering" a seat — the inverse bug: it shrank the gap for a decision that was never made (no assignment,
// no packet, no publish, no readiness). We no longer do that. Coverage now counts ONLY explicit route
// assignments, so the gap is HONEST. The scheduled-unassigned crew are not lost: they surface as the
// PREFERRED candidates in recommendCrew / the optimizer (both read eligibilityFor), which turns a sunk
// Connecteam commitment into a real assignment instead of a fake coverage credit.
//
// Field was already never auto-credited (it maps to Connecteam's catch-all "other" bucket, which also
// holds admins) — so this change brings driver + prep in line with how field already behaved. Reachability
// honesty is unchanged: this function makes no claim about who is off; an outage is handled upstream
// (getCrewForDateSafe.ok) and never read here as coverage.

import type { ShiftRole, StaffShift } from "./types";

/** Per-shift coverage. Counted from explicit route assignments only (no Connecteam-schedule credit). */
export interface ShiftCoverage {
  headcount: number;
  assigned: number; // explicit app assignees (the only thing that covers a seat)
  scheduledCredit: number; // DEPRECATED — always 0 now (kept for the server→client shape; see note above)
  scheduledNames: string[]; // always [] now
  scheduledUserIds: number[]; // always [] now
  covered: number; // = assigned, capped at headcount
  gap: number; // headcount − covered → still needs a decision (internal pick or Instawork)
}

export interface DayCoverage {
  /** shift id → coverage. Plain object so it crosses the server→client boundary. */
  byShift: Record<string, ShiftCoverage>;
  internalTotal: number; // people covered by an explicit route assignment
  gapTotal: number; // total still needing a staffing decision
}

/**
 * Coverage for the day's shifts from explicit route assignments only. A Connecteam work shift never
 * credits coverage here (see the file header + doc §2.2) — the scheduled-unassigned pool is surfaced as
 * eligible candidates by recommendCrew / optimize, not counted as covered.
 */
export function computeCoverage(shifts: StaffShift[]): DayCoverage {
  const byShift: Record<string, ShiftCoverage> = {};
  let internalTotal = 0;
  let gapTotal = 0;

  const roles: ShiftRole[] = ["driver", "field", "prep"];
  for (const role of roles) {
    const roleShifts = shifts.filter((s) => s.role === role);
    if (roleShifts.length === 0) continue;
    for (const s of roleShifts) {
      const assigned = s.assignees.length;
      const covered = Math.min(s.headcount, assigned);
      const gap = Math.max(0, s.headcount - covered);
      byShift[s.id] = { headcount: s.headcount, assigned, scheduledCredit: 0, scheduledNames: [], scheduledUserIds: [], covered, gap };
      internalTotal += covered;
      gapTotal += gap;
    }
  }

  return { byShift, internalTotal, gapTotal };
}

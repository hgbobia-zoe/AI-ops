// Coverage netting — reconcile who's ALREADY scheduled in Connecteam against the day's demand, so a
// shift a scheduled crew member covers doesn't falsely read as an Instawork gap. Pure + deterministic.
//
// Connecteam is the internal schedule of record. If Michael is on today as a driver, a driver shift is
// covered — the human doesn't have to re-assign him in the app for the board to reflect reality, and the
// Instawork gap drops accordingly. Explicit app assignees still count first; scheduled crew fill the
// remaining need, and are never double-counted with an explicit assignee of the same person.
//
// Role mapping: the app's field crew maps to Connecteam's "other" title bucket (driver→driver,
// prep→prep, field→other), per roleFromTitle in connecteam.ts.

import type { CrewMember } from "@/lib/connecteam";
import type { ShiftRole, StaffShift } from "./types";

const CREW_ROLE: Record<ShiftRole, CrewMember["role"]> = {
  driver: "driver",
  prep: "prep",
  field: "other",
};

/** Per-shift coverage after crediting scheduled Connecteam crew. */
export interface ShiftCoverage {
  headcount: number;
  assigned: number; // explicit app assignees
  scheduledCredit: number; // Connecteam-scheduled crew credited to this shift
  scheduledNames: string[]; // their names, for display ("via Connecteam: Michael")
  scheduledUserIds: number[]; // their Connecteam userIds, for exact rate lookup (cost economics)
  covered: number; // assigned + scheduledCredit, capped at headcount
  gap: number; // headcount − covered → still needs Instawork
}

export interface DayCoverage {
  /** shift id → coverage. Plain object so it crosses the server→client boundary. */
  byShift: Record<string, ShiftCoverage>;
  internalTotal: number; // people covered internally (explicit + scheduled)
  gapTotal: number; // total still needing Instawork
}

/**
 * Credit scheduled Connecteam crew against the day's shifts, per role. `scheduled` is the distinct
 * crew already on the Connecteam schedule for the day (from getCrewForDateSafe → shift assignees).
 */
export function computeCoverage(shifts: StaffShift[], scheduled: CrewMember[]): DayCoverage {
  const byShift: Record<string, ShiftCoverage> = {};
  let internalTotal = 0;
  let gapTotal = 0;

  const roles: ShiftRole[] = ["driver", "field", "prep"];
  for (const role of roles) {
    const roleShifts = shifts.filter((s) => s.role === role);
    if (roleShifts.length === 0) continue;
    // People already explicitly assigned to ANY of this role's shifts — don't credit them twice.
    const assignedIds = new Set<number>(roleShifts.flatMap((s) => s.assignees));
    // Only auto-credit roles Connecteam tags CLEANLY: driver (title "Driver") and prep (Warehouse/Asset).
    // "field" maps to Connecteam's catch-all "other" bucket, which also contains admins/office staff — so
    // auto-crediting it is wrong (e.g. an admin shown as field crew). Field needs real availability + an
    // explicit pick (the recommendation engine), so it's NEVER auto-credited here — explicit assignees only.
    const pool = role === "field" ? [] : scheduled.filter((c) => c.role === CREW_ROLE[role] && !assignedIds.has(c.userId));
    let pi = 0; // walk the scheduled pool across this role's shifts

    for (const s of roleShifts) {
      const assigned = s.assignees.length;
      let residual = Math.max(0, s.headcount - assigned);
      const names: string[] = [];
      const userIds: number[] = [];
      while (residual > 0 && pi < pool.length) {
        names.push(pool[pi].name);
        userIds.push(pool[pi].userId);
        pi += 1;
        residual -= 1;
      }
      const scheduledCredit = names.length;
      const covered = Math.min(s.headcount, assigned + scheduledCredit);
      const gap = Math.max(0, s.headcount - covered);
      byShift[s.id] = { headcount: s.headcount, assigned, scheduledCredit, scheduledNames: names, scheduledUserIds: userIds, covered, gap };
      internalTotal += covered;
      gapTotal += gap;
    }
  }

  return { byShift, internalTotal, gapTotal };
}

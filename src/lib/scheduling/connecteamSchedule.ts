// Connecteam schedule MIRROR — an honest, role-agnostic summary of exactly who a coordinator scheduled in
// Connecteam for the day. Pure + deterministic.
//
// WHY THIS EXISTS (Lisa's report, 2026-10-15): the scheduling blade is app-first — it derives demand from
// routes and only NETS Connecteam shifts into side flows (recommendations, the schedule→route bridge, the
// coverage headline). A coordinator who schedules DIRECTLY in Connecteam expects Dispatch to accurately
// reflect what she entered, and the old headline counted only driver + prep roles, so anyone whose
// Connecteam Title mapped to the catch-all "other" bucket (an unusual/blank title, a new hire, office crew
// she put on the day) was silently dropped from the count. That read as "Dispatch isn't pulling
// accurately." This summarizer surfaces the WHOLE schedule — every assigned person, every role — so nothing
// Connecteam holds is invisible, WITHOUT changing who the eligibility engine will recommend onto a route
// (office/admin stay excluded there, by design).
//
// HONESTY (the house law): when Connecteam is unreachable the summary is UNKNOWN (reachable:false, empty),
// never a fabricated "nobody scheduled". An unknown is never a zero.

import type { CrewRole, CrewShift } from "@/lib/connecteam";

/** One Connecteam work shift a person is on today (Unix seconds). */
export interface ScheduledShiftWindow {
  start: number;
  end: number;
  title: string;
  schedulerName: string;
}

/** One person on the Connecteam schedule today, collapsed across all their shifts. */
export interface ScheduledPersonRow {
  userId: number;
  name: string;
  /** The Connecteam "Title" custom field, or null when unset. */
  title: string | null;
  /** The ops role derived from the title (driver / prep / other). "other" is still surfaced here. */
  role: CrewRole;
  /** Every Connecteam shift this person is assigned to today, earliest first. */
  windows: ScheduledShiftWindow[];
}

export interface ConnecteamScheduleSummary {
  /** True only when Connecteam actually answered. false → the whole summary is UNKNOWN, never "nobody". */
  reachable: boolean;
  /** Distinct people with at least one assigned shift today. */
  totalScheduled: number;
  /** Distinct people per role (every role, INCLUDING "other" — never dropped). */
  byRole: Record<CrewRole, number>;
  /** Open (unassigned) Connecteam shifts for the day — seats Connecteam has posted but not filled. */
  openShiftCount: number;
  /** Every scheduled person, sorted by name then userId (stable). */
  people: ScheduledPersonRow[];
}

const EMPTY_BY_ROLE = (): Record<CrewRole, number> => ({ driver: 0, prep: 0, other: 0 });

/**
 * Collapse a day's Connecteam shifts into an accurate, role-agnostic schedule mirror. Pure: pass the
 * reachability-flagged CrewShift[] (getCrewForDateSafe) and get the honest summary. A person on several
 * shifts is one row carrying all their windows; open shifts (no assignees) are counted but add no person.
 * Connecteam unreachable (ok:false) → reachable:false and everything empty (UNKNOWN, never fabricated 0).
 */
export function summarizeConnecteamSchedule(crew: { ok: boolean; shifts: CrewShift[] }): ConnecteamScheduleSummary {
  if (!crew.ok) {
    return { reachable: false, totalScheduled: 0, byRole: EMPTY_BY_ROLE(), openShiftCount: 0, people: [] };
  }

  const byUser = new Map<number, ScheduledPersonRow>();
  let openShiftCount = 0;

  for (const s of crew.shifts) {
    if (s.assignees.length === 0) {
      if (s.isOpen) openShiftCount++;
      continue;
    }
    const win: ScheduledShiftWindow | null =
      Number.isFinite(s.startUnix) && Number.isFinite(s.endUnix) && s.endUnix > s.startUnix
        ? { start: s.startUnix, end: s.endUnix, title: s.title || "", schedulerName: s.schedulerName }
        : null;
    for (const a of s.assignees) {
      const prev = byUser.get(a.userId);
      if (!prev) {
        byUser.set(a.userId, {
          userId: a.userId,
          name: a.name,
          title: a.title ?? null,
          role: a.role,
          windows: win ? [win] : [],
        });
      } else if (win) {
        prev.windows.push(win);
      }
    }
  }

  const byRole = EMPTY_BY_ROLE();
  const people = [...byUser.values()];
  for (const p of people) {
    byRole[p.role] += 1;
    p.windows.sort((a, b) => a.start - b.start);
  }
  people.sort((a, b) => a.name.localeCompare(b.name) || a.userId - b.userId);

  return { reachable: true, totalScheduled: people.length, byRole, openShiftCount, people };
}

/** A short, accurate headline for the day's Connecteam schedule (all roles, never undercounting). Honest
 *  when unreachable. e.g. "9 scheduled (4 drivers, 3 prep, 2 other)". Office/other only shown when present. */
export function connecteamScheduleHeadline(summary: ConnecteamScheduleSummary): string {
  if (!summary.reachable) {
    return "Connecteam coverage unverified — couldn't reach it, so this is not “nobody scheduled.”";
  }
  if (summary.totalScheduled === 0 && summary.openShiftCount === 0) {
    return "Connecteam today: nobody scheduled for this day.";
  }
  const { driver, prep, other } = summary.byRole;
  const parts: string[] = [`${driver} driver${driver === 1 ? "" : "s"}`, `${prep} prep`];
  if (other > 0) parts.push(`${other} other`);
  const open = summary.openShiftCount > 0 ? `, ${summary.openShiftCount} open shift${summary.openShiftCount === 1 ? "" : "s"}` : "";
  return `Connecteam today: ${summary.totalScheduled} scheduled (${parts.join(", ")})${open}.`;
}

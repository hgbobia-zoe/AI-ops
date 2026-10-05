// Feeder for the eligibility classifier (eligibility.ts). It assembles the two Connecteam feeds +
// the Zoe route assignments into the shape eligibilityFor() reads, and caches the day's unavailability
// pull so a single page render (or the apply route) does not fire one Connecteam call per worker every
// time it renders. Pure assembly + a TTL cache; no decision is made here (RULES CALCULATE elsewhere).
//
// Two sources, both already built in connecteam.ts:
//   • getUnavailabilityForDate — the real "worker marked themselves off" feed (time-off / unavailability).
//   • the day's CrewShift[] (work schedule) + the day's staff_shifts.assignees (route assignments) are
//     passed in by the caller; this module only turns the assignees into AssignmentWindow[].

import { getUnavailabilityForDate, type UnavailabilityBlock } from "@/lib/connecteam";
import type { AssignmentWindow } from "./eligibility";
import type { StaffShift } from "./types";

/** The day's Connecteam unavailability feed, resolved once. `ok` is the feed reachability (false → the
 *  availability is UNVERIFIED for the day, never "nobody off"). `byUser` holds only users WITH blocks. */
export interface DayAvailability {
  ok: boolean;
  byUser: Map<number, UnavailabilityBlock[]>;
}

/** One Zoe route assignment window per (worker × staff_shift), from the day's staff_shifts.assignees and
 *  each shift's own (possibly unknown) window. A shift with no known window yields null start/end — the
 *  classifier then can't overlap-check it, so it never fabricates an ASSIGNED clash from an unknown time. */
export function assignmentWindowsFromShifts(shifts: StaffShift[]): AssignmentWindow[] {
  const out: AssignmentWindow[] = [];
  for (const s of shifts) {
    const start = s.windowKnown && s.startTime ? Math.floor(Date.parse(s.startTime) / 1000) : null;
    const end = s.windowKnown && s.endTime ? Math.floor(Date.parse(s.endTime) / 1000) : null;
    const okStart = start != null && !Number.isNaN(start) ? start : null;
    const okEnd = end != null && !Number.isNaN(end) ? end : null;
    for (const userId of s.assignees) out.push({ userId, shiftId: s.id, start: okStart, end: okEnd });
  }
  return out;
}

// ── TTL cache around the per-day unavailability pull ────────────────────────────────────────────────
// Mirrors refreshConnecteamHealth's pattern (connecteam.ts): at most one real pull per day per TTL, and
// concurrent callers share one in-flight promise. Keyed by date; an entry records which userIds it covers
// so a later call for a subset reuses it, and a call for new userIds re-pulls the union.

const AVAIL_TTL_MS = 90_000;

interface Entry {
  at: number;
  ok: boolean;
  byUser: Map<number, UnavailabilityBlock[]>;
  covered: Set<number>;
}

const _cache = new Map<string, Entry>();
const _inflight = new Map<string, Promise<Entry>>();

/** The day's unavailability for a candidate pool, TTL-cached + single-flight per date. Never throws:
 *  a failed pull returns ok:false with no blocks, so the classifier flags "availability unverified"
 *  rather than fabricating a confident "free". */
export async function getDayAvailabilityCached(
  date: string,
  userIds: number[],
  now: number = Date.now(),
): Promise<DayAvailability> {
  const req = [...new Set(userIds)].filter((u) => Number.isFinite(u));
  if (req.length === 0) return { ok: false, byUser: new Map() };

  const hit = _cache.get(date);
  if (hit && now - hit.at < AVAIL_TTL_MS && req.every((u) => hit.covered.has(u))) {
    return { ok: hit.ok, byUser: hit.byUser };
  }

  const existing = _inflight.get(date);
  if (existing) {
    const e = await existing;
    if (req.every((u) => e.covered.has(u))) return { ok: e.ok, byUser: e.byUser };
  }

  const union = hit ? [...new Set([...hit.covered, ...req])] : req;
  const p: Promise<Entry> = (async () => {
    const r = await getUnavailabilityForDate(date, union);
    return { at: Date.now(), ok: r.ok, byUser: r.byUser, covered: new Set(union) };
  })()
    .then((e) => {
      _cache.set(date, e);
      _inflight.delete(date);
      return e;
    })
    .catch(() => {
      _inflight.delete(date);
      return { at: Date.now(), ok: false, byUser: new Map<number, UnavailabilityBlock[]>(), covered: new Set(union) };
    });
  _inflight.set(date, p);
  const e = await p;
  return { ok: e.ok, byUser: e.byUser };
}

// Cost-aware, internal-first staffing OPTIMIZER — a pure, deterministic recommendation module (sibling
// of coverage.ts / availability.ts). It does NOT apply anything: it SUGGESTS a whole-day staffing plan
// and shows the temp-hours/cost it would save, or says plainly that the current assignment is already
// optimal. The dispatcher's manual choices always win; this is preview / record-only.
//
// The business objective is NOT lowest total cost. It is: minimize unnecessary TEMP exposure while
// keeping full route coverage. Internal-first is a strong PREFERENCE, not a hard rule.
//
// CONFIRMED DECISIONS baked in here:
//   - NO max-hours constraint. Hours are informational only; a worker is never blocked for "too many
//     hours" and may stack shifts on a busy day.
//   - Qualification = Connecteam Title match (candidateRoles), exactly as today. No skills/cert/geo model.
//   - Rates: internal from Connecteam (rateForUserOn); temp from InstaworkShift.basePrice. No rate →
//     "rate unknown", excluded from cost, never fabricated.
//
// Determinism: tiny input (a day of route-shifts), a transparent heuristic (internal longest-routes-first
// + a bounded feasible-swap improvement pass), ties broken by id/name. RULES CALCULATE; no LLM here.

import type { CrewMember, CrewShift, PayRate, UnavailabilityBlock } from "@/lib/connecteam";
import type { InstaworkShift } from "@/lib/instawork/types";
import { candidateRoles } from "./availability";
import { eligibilityFor, type AssignmentWindow } from "./eligibility";
import { shiftWindowHours } from "./cost";
import type { DayCoverage } from "./coverage";
import type { ShiftRole, StaffShift } from "./types";

export interface StaffingWeights {
  qual: number; // qualification match — dominant (a mis-qualified pick never outranks a qualified one)
  intern: number; // internal-first preference (below qualification)
  tempHr: number; // temp-hours avoided — the lever that beats naive internal-first (internal → long routes)
  scheduledUnassigned: number; // prefer a worker already on the Connecteam schedule (sunk commitment) —
  // below the internal-vs-temp preference, above load/continuity, so a scheduled-unassigned worker beats
  // a fully-unscheduled AVAILABLE one (and far beats a temp, which is only ever a last resort).
  load: number; // least-loaded-first (workload balance), reusing bookedHours
  simple: number; // continuity: a small bonus to keep an existing feasible assignment
}

export interface StaffingCostConfig {
  /** Premium multiplier used ONLY when one side's rate is unknown (never hardcoded into the algorithm). */
  tempPremiumFallback: number;
  weights: StaffingWeights;
  // NOTE: there is deliberately NO maxWorkerHours — a confirmed decision. Hours never gate an assignment.
}

export const DEFAULT_STAFFING_CONFIG: StaffingCostConfig = {
  tempPremiumFallback: 2.0,
  weights: { qual: 100, intern: 40, tempHr: 35, scheduledUnassigned: 25, load: 15, simple: 5 },
};

export interface PlannedAssignment {
  shiftId: string;
  routeId: string | null;
  role: ShiftRole;
  kind: "internal" | "temp";
  userId: number | null; // internal only
  name: string; // internal: worker name; temp: "Temp (<role>)"
  hours: number | null; // seat hours (route window)
  whyThisRoute: string; // deterministic reason
  whyTemp: string | null; // temp only
  wasCommitted: boolean; // internal already assigned on this shift (a fixed point in the current plan)
  moved: boolean; // the optimizer recommends MOVING this internal here from another route
  fromRouteId: string | null;
}

export interface StaffingPlan {
  date: string;
  assignments: PlannedAssignment[];
  currentTempHours: number | null;
  planTempHours: number | null;
  currentTempCount: number;
  planTempCount: number;
  /** currentTempHours - planTempHours (>= 0); null when hours are unknown. The ONLY saving ever shown. */
  tempHoursSaved: number | null;
  tempCountSaved: number;
  betterThanCurrent: boolean;
  alreadyOptimal: boolean;
  /** Honest one-line summary (no manufactured saving). */
  note: string;
}

export interface OptimizeInput {
  date: string;
  shifts: StaffShift[];
  coverage: DayCoverage;
  roster: CrewMember[];
  dayShifts: CrewShift[];
  rates: Map<number, PayRate[]>;
  instawork: { ok: boolean; gigs: InstaworkShift[] };
  /** The day's Zoe route assignments (staff_shifts.assignees → windows) — so a worker already ASSIGNED to
   *  another route in the seat's window is not double-offered. In-plan overlaps are handled separately
   *  (the live plan), so this is only consulted for routes NOT on the optimization surface. */
  assignments?: AssignmentWindow[];
  /** The day's Connecteam time-off / unavailability feed. A worker on a block overlapping a seat is
   *  UNAVAILABLE (hard-excluded). ok:false → availability unverified, never read as "nobody off". */
  unavailability?: { ok: boolean; byUser: Map<number, UnavailabilityBlock[]> };
  cfg?: StaffingCostConfig;
  /** Reserved for future proximity-based reasoning; the pre-start placement does not depend on it. */
  now?: number;
}

// ── Internal seat model (an expanded headcount seat on a route-shift) ──────────────────────────────

interface Seat {
  seatId: string;
  shiftId: string;
  routeId: string | null;
  role: ShiftRole;
  hours: number; // known window hours (seats with unknown windows are not placed — see below)
  startMs: number;
  endMs: number;
  assignedUserId: number | null; // null = temp
  committedUserId: number | null; // the worker currently assigned here (fixed-point seed), if any
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd && bStart < aEnd;

function bookedHoursByUser(dayShifts: CrewShift[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of dayShifts) {
    const h = Math.max(0, (s.endUnix - s.startUnix) / 3600);
    for (const a of s.assignees) m.set(a.userId, (m.get(a.userId) ?? 0) + h);
  }
  return m;
}

/**
 * The Route Assignment Score (C.4) — extends recommendCrew's least-loaded ranking into an additive,
 * explainable sum. Returns -Infinity if the worker is not qualified for the seat's role (a near-hard
 * gate). Higher is better. Used to pick WHICH internal worker fills a seat.
 */
export function scoreAssignment(
  worker: CrewMember,
  seat: { role: ShiftRole; hours: number },
  ctx: { bookedHours: number; maxSeatHours: number; isContinuity: boolean; scheduledUnassigned?: boolean },
  cfg: StaffingCostConfig,
): number {
  if (!candidateRoles(seat.role).includes(worker.role)) return -Infinity;
  const w = cfg.weights;
  const tempHourSaving = ctx.maxSeatHours > 0 ? seat.hours / ctx.maxSeatHours : 0; // longer route → higher
  const loadBalance = 1 / (1 + Math.max(0, ctx.bookedHours)); // least-loaded → higher
  return (
    w.qual * 1 + // qualified (gate passed)
    w.intern * 1 + // internal preference
    w.tempHr * tempHourSaving +
    w.scheduledUnassigned * (ctx.scheduledUnassigned ? 1 : 0) + // sunk Connecteam commitment → turn into coverage
    w.load * loadBalance +
    w.simple * (ctx.isContinuity ? 1 : 0)
  );
}

function roleEligible(worker: CrewMember, role: ShiftRole): boolean {
  return candidateRoles(role).includes(worker.role);
}

export function optimizeStaffing(input: OptimizeInput): StaffingPlan {
  const cfg = input.cfg ?? DEFAULT_STAFFING_CONFIG;
  const { date, shifts, coverage, roster, dayShifts } = input;

  // The optimization surface: route-tied driver/field shifts with a KNOWN window (an unknown window
  // can't be hard-assigned — it's surfaced as a gap elsewhere, never force-fit). Prep is day-level and
  // excluded from cross-route placement.
  const planShifts = shifts.filter(
    (s) => s.routeId && (s.role === "driver" || s.role === "field") && s.windowKnown && s.startTime && s.endTime,
  );

  // Expand into seats. Seed each shift's seats with its current assignees (committed = fixed points).
  const seats: Seat[] = [];
  for (const s of planShifts) {
    const hours = shiftWindowHours(s) ?? 0;
    const startMs = Date.parse(s.startTime!);
    const endMs = Date.parse(s.endTime!);
    const committed = [...s.assignees];
    for (let i = 0; i < s.headcount; i++) {
      const committedUserId = committed[i] ?? null;
      seats.push({
        seatId: `${s.id}#${i}`,
        shiftId: s.id,
        routeId: s.routeId,
        role: s.role,
        hours,
        startMs,
        endMs,
        assignedUserId: committedUserId,
        committedUserId,
      });
    }
  }

  const booked = bookedHoursByUser(dayShifts);
  const maxSeatHours = seats.reduce((m, s) => Math.max(m, s.hours), 0);
  const nameOf = (uid: number): string => roster.find((r) => r.userId === uid)?.name ?? `#${uid}`;

  // External constraints for the classifier: Zoe assignments on routes NOT in this plan (an in-plan
  // overlap is handled by the live-plan check below, so excluding plan shifts here keeps the swap pass
  // able to free a seat and re-place a worker). A Connecteam WORK shift is NOT a constraint — it makes a
  // worker SCHEDULED_UNASSIGNED (eligible, preferred), which is exactly the bug this refinement kills.
  const planShiftIds = new Set(planShifts.map((s) => s.id));
  const externalAssignments = (input.assignments ?? []).filter((a) => !planShiftIds.has(a.shiftId));
  const availByUser = input.unavailability?.byUser ?? new Map<number, UnavailabilityBlock[]>();
  const availabilityKnown = input.unavailability?.ok ?? false;

  // Which seats is a worker currently occupying in the plan (to prevent overlap when we move them).
  function workerBusyInPlan(userId: number, exceptSeatId: string | null): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const s of seats) {
      if (s.assignedUserId === userId && s.seatId !== exceptSeatId) out.push([s.startMs, s.endMs]);
    }
    return out;
  }

  /** Classify (worker, seat) through the shared eligibility classifier + the live plan. Infeasible only
   *  when the classifier says NOT eligible (UNAVAILABLE, or ASSIGNED to an overlapping off-plan route) or
   *  the worker already holds an overlapping plan seat. Also reports whether the pick is SCHEDULED_UNASSIGNED
   *  (a sunk Connecteam commitment), which the score prefers. (No max-hours check — a confirmed decision.) */
  function seatFit(userId: number, seat: Seat): { feasible: boolean; scheduledUnassigned: boolean } {
    const worker = roster.find((r) => r.userId === userId);
    if (!worker || !roleEligible(worker, seat.role)) return { feasible: false, scheduledUnassigned: false };
    const elig = eligibilityFor({
      userId,
      routeWindow: { start: Math.floor(seat.startMs / 1000), end: Math.floor(seat.endMs / 1000) },
      dayShifts,
      assignments: externalAssignments,
      unavailability: availByUser.get(userId) ?? [],
      availabilityKnown,
      thisShiftId: seat.shiftId,
    });
    if (!elig.eligible) return { feasible: false, scheduledUnassigned: false };
    for (const [ws, we] of workerBusyInPlan(userId, seat.seatId)) {
      if (overlaps(seat.startMs, seat.endMs, ws, we)) return { feasible: false, scheduledUnassigned: false };
    }
    return { feasible: true, scheduledUnassigned: elig.preferred };
  }

  const feasible = (userId: number, seat: Seat): boolean => seatFit(userId, seat).feasible;

  const assignedSomewhere = (): Set<number> => new Set(seats.filter((s) => s.assignedUserId != null).map((s) => s.assignedUserId!));

  // Stage 1+3 fill: walk the still-empty seats LONGEST-first and assign the best eligible internal worker,
  // so internal crew land on the longest routes and temps fall to the shortest by construction. A
  // scheduled-unassigned worker is eligible and preferred, so an idle worker already on the clock is
  // picked over a temp.
  const emptySeats = (): Seat[] => seats.filter((s) => s.assignedUserId == null).sort((a, b) => b.hours - a.hours || a.seatId.localeCompare(b.seatId));

  for (const seat of emptySeats()) {
    if (seat.assignedUserId != null) continue;
    const taken = assignedSomewhere();
    let best: { userId: number; score: number } | null = null;
    for (const w of roster) {
      if (taken.has(w.userId)) continue;
      const fit = seatFit(w.userId, seat);
      if (!fit.feasible) continue;
      const sc = scoreAssignment(
        w,
        seat,
        { bookedHours: booked.get(w.userId) ?? 0, maxSeatHours, isContinuity: false, scheduledUnassigned: fit.scheduledUnassigned },
        cfg,
      );
      if (sc === -Infinity) continue;
      if (!best || sc > best.score || (sc === best.score && w.userId < best.userId)) best = { userId: w.userId, score: sc };
    }
    if (best) seat.assignedUserId = best.userId;
  }

  // Stage 3 improvement: a bounded feasible-swap pass that prevents the DANGEROUS optimization (a temp on
  // a LONG route while an internal sits on a SHORT route). For each (temp seat T, internal seat S) with
  // T.hours > S.hours, if S's worker can feasibly move to T, move them (T becomes internal, S becomes
  // temp) — this strictly reduces total temp hours. Repeat until no improving feasible swap remains.
  let improved = true;
  let guard = 0;
  while (improved && guard < 1000) {
    improved = false;
    guard += 1;
    const tempSeats = seats.filter((s) => s.assignedUserId == null).sort((a, b) => b.hours - a.hours);
    for (const t of tempSeats) {
      const internalSeats = seats.filter((s) => s.assignedUserId != null && s.hours < t.hours).sort((a, b) => a.hours - b.hours);
      let swapped = false;
      for (const s of internalSeats) {
        const uid = s.assignedUserId!;
        // Feasible to move this worker to T? Temporarily free S, check, then commit.
        s.assignedUserId = null;
        if (feasible(uid, t)) {
          t.assignedUserId = uid; // worker moves to the longer route; S becomes the temp seat
          swapped = true;
          improved = true;
          break;
        }
        s.assignedUserId = uid; // revert
      }
      if (swapped) break;
    }
  }

  // ── Build the assignment list + reasons ────────────────────────────────────────────────────────
  // Where was each worker ORIGINALLY committed (so we can say "moved from route X").
  const originByUser = new Map<number, string | null>();
  for (const s of seats) if (s.committedUserId != null) originByUser.set(s.committedUserId, s.routeId);

  const rolePoolEmpty = (role: ShiftRole): boolean => !roster.some((w) => roleEligible(w, role));
  const assignments: PlannedAssignment[] = seats.map((seat) => {
    if (seat.assignedUserId != null) {
      const uid = seat.assignedUserId;
      const committedHere = seat.committedUserId === uid;
      // Moved = this worker was committed on a DIFFERENT shift originally and the optimizer relocated them.
      const moved = !committedHere && originByUser.has(uid) && originByUser.get(uid) !== seat.routeId;
      const placedFresh = !committedHere && !originByUser.has(uid); // a free internal the optimizer added
      return {
        shiftId: seat.shiftId,
        routeId: seat.routeId,
        role: seat.role,
        kind: "internal",
        userId: uid,
        name: nameOf(uid),
        hours: seat.hours,
        whyThisRoute:
          moved || placedFresh
            ? "Internal placed on the longest feasible route (avoids the most temp hours)"
            : "Already assigned here",
        whyTemp: null,
        wasCommitted: committedHere,
        moved,
        fromRouteId: moved ? (originByUser.get(uid) ?? null) : null,
      };
    }
    // Temp seat.
    const whyTemp = rolePoolEmpty(seat.role)
      ? "No internal crew qualified for this role"
      : "Internal crew exhausted for this window";
    return {
      shiftId: seat.shiftId,
      routeId: seat.routeId,
      role: seat.role,
      kind: "temp",
      userId: null,
      name: `Temp (${seat.role})`,
      hours: seat.hours,
      whyThisRoute: "Shortest eligible route (internal steered to longer routes first)",
      whyTemp,
      wasCommitted: false,
      moved: false,
      fromRouteId: null,
    };
  });

  // ── Current vs plan temp exposure (hours-first, then count) ──────────────────────────────────────
  // Current temp hours = each plan-shift's coverage gap costed at its window hours (the seats that need a
  // temp today). Plan temp hours = the optimizer's temp seats. Both over the SAME surface, so the delta
  // is honest. Never a manufactured saving: equal plan == "already optimal".
  let currentTempHours = 0;
  let currentTempCount = 0;
  for (const s of planShifts) {
    const gap = coverage.byShift[s.id]?.gap ?? Math.max(0, s.headcount - s.assignees.length);
    const h = shiftWindowHours(s) ?? 0;
    currentTempCount += gap;
    currentTempHours += gap * h;
  }
  const planTempSeats = seats.filter((s) => s.assignedUserId == null);
  const planTempCount = planTempSeats.length;
  const planTempHours = planTempSeats.reduce((n, s) => n + s.hours, 0);

  const tempHoursSaved = Math.round((currentTempHours - planTempHours) * 100) / 100;
  const tempCountSaved = currentTempCount - planTempCount;
  const betterThanCurrent = tempHoursSaved > 0.001 || tempCountSaved > 0;
  const alreadyOptimal = !betterThanCurrent;

  let note: string;
  if (planShifts.length === 0) {
    note = "No route shifts with a known window to optimize yet.";
  } else if (betterThanCurrent) {
    const parts: string[] = [];
    if (tempCountSaved > 0) parts.push(`${tempCountSaved} fewer temp seat${tempCountSaved === 1 ? "" : "s"}`);
    if (tempHoursSaved > 0.001) parts.push(`${tempHoursSaved}h less temp time`);
    note = `Optimized plan: ${parts.join(", ")} by steering internal crew onto the longest routes.`;
  } else if (planTempCount > 0) {
    note = "Current staffing is already optimal. The remaining temp seats cannot be avoided without breaking coverage or a constraint.";
  } else {
    note = "Current staffing is already optimal. No temp labor is needed.";
  }

  return {
    date,
    assignments,
    currentTempHours: planShifts.length ? Math.round(currentTempHours * 100) / 100 : null,
    planTempHours: planShifts.length ? Math.round(planTempHours * 100) / 100 : null,
    currentTempCount,
    planTempCount,
    tempHoursSaved: planShifts.length ? tempHoursSaved : null,
    tempCountSaved,
    betterThanCurrent,
    alreadyOptimal,
    note,
  };
}

// Route handoff — the pure logic for the multi-route-per-truck handoff (no DB, no I/O, fully unit-tested).
//
// THE PROBLEM (root cause): a truck runs 2-3 routes a day with DIFFERENT drivers. The kiosk picks ONE route
// per truck via getActiveRouteForTruck, which returned the earliest route today whose status != "done". When
// driver A finishes route 1 but never taps "close", route 1 stays the earliest workable route and MASKS
// driver B's route 2 forever — so driver B opens the kiosk and sees A's stale route, not their own.
//
// THE FIX, two parts:
//   1. VISIBILITY (pickWorkableRoute): once we are within the handoff buffer before a LATER route's start,
//      that later route becomes the active one even if an earlier route is still open. The next driver can
//      always reach their assignment; a forgotten close never blocks them again.
//   2. RECONCILIATION (planTruckHandoff): a scheduler decides what to do with the stale earlier route —
//      auto-finalize it ONLY with verified completion evidence (Scenario A), else leave it open and flag it
//      for the office + alert dispatch to a genuine conflict (Scenario B). It never fabricates a completion.
//
// House law honored here: rules calculate (this file), verified beats assumed (we finalize only on real
// evidence), and we never fake a completion time or silently discard incomplete work.

import type { Route, Stop, StopState } from "@/lib/types";

/** Stop states that count as finished work (a real completion/return the driver recorded). */
const TERMINAL_STATES: readonly StopState[] = ["Completed", "Returned"] as const;
/** Stop states that mean the truck is physically OUT working this stop right now. */
const ACTIVE_STATES: readonly StopState[] = ["EnRoute", "Arrived", "HeadingBack"] as const;

/** Earliest scheduled stop time on a route as unix ms. Routes with no timed stop sort LAST
 *  (MAX_SAFE_INTEGER) and are never treated as "due" — we never invent a window. */
export function routeEarliestStopMs(r: Route): number {
  let min = Number.MAX_SAFE_INTEGER;
  for (const s of r.stops) {
    const raw = s.plannedWindow || s.eta;
    if (!raw) continue;
    const t = Date.parse(raw);
    if (!Number.isNaN(t) && t < min) min = t;
  }
  return min;
}

/** A route is VERIFIED-complete when it has at least one stop and EVERY stop is in a terminal state. This is
 *  the only evidence that lets automation finalize a route (Scenario A). An empty route is never "complete"
 *  (nothing proves it ran). */
export function isVerifiedComplete(r: Route): boolean {
  if (r.stops.length === 0) return false;
  return r.stops.every((s) => TERMINAL_STATES.includes(s.state));
}

/** True when any stop shows the truck is physically out working (en route / arrived / heading back). Used to
 *  decide whether a stale earlier route is a GENUINE conflict worth paging dispatch about. */
function hasActiveStop(r: Route): boolean {
  return r.stops.some((s) => ACTIVE_STATES.includes(s.state));
}

/** Count stops that are neither terminal nor merely waiting — plus any not-terminal — so Scenario B can
 *  report honestly what remains. */
export function incompleteStopCount(r: Route): number {
  return r.stops.filter((s) => !TERMINAL_STATES.includes(s.state)).length;
}

/**
 * Pick which WORKABLE (not-done) route the kiosk should show for a truck. `applyHandoff` is true only when
 * we are actually operating on this calendar day (so historical/overnight reads keep the plain
 * earliest-first behavior). Pure.
 *
 * - applyHandoff=false → the earliest-starting workable route (unchanged legacy behavior).
 * - applyHandoff=true  → among routes whose handoff window has OPENED (start - buffer <= now), the
 *   LATEST-starting one; i.e. the most imminent route we have reached the window for. This is what surfaces
 *   driver B's later route even while driver A's earlier route is still open. If no route's window has opened
 *   yet (it is before the day's first handoff window), fall back to the earliest.
 */
export function pickWorkableRoute(
  workable: Route[],
  nowMs: number,
  bufferMin: number,
  applyHandoff: boolean,
): Route | null {
  if (workable.length === 0) return null;
  const sorted = [...workable]
    .map((r) => ({ r, start: routeEarliestStopMs(r) }))
    .sort((a, b) => a.start - b.start || a.r.routeId.localeCompare(b.r.routeId));
  if (!applyHandoff) return sorted[0].r;

  const bufferMs = bufferMin * 60_000;
  const due = sorted.filter((x) => x.start !== Number.MAX_SAFE_INTEGER && nowMs >= x.start - bufferMs);
  if (due.length === 0) return sorted[0].r; // before any handoff window → earliest
  // The most imminent route whose window we have entered. Later-starting wins so the NEXT route surfaces.
  return due[due.length - 1].r;
}

// ── Reconciliation planner ───────────────────────────────────────────────────────────────────────

/** What the handoff tick should do to a single stale earlier route. */
export type HandoffAction =
  | { kind: "finalize"; routeId: string; truckId: string; reason: "verified_complete"; incomplete: 0 }
  | { kind: "flag"; routeId: string; truckId: string; reason: string; conflict: boolean; incomplete: number };

export interface TruckHandoffPlan {
  truckId: string;
  actions: HandoffAction[];
}

/**
 * Decide handoffs for ONE truck's routes on a day. For each route whose NEXT route's handoff window has
 * opened while it is still open:
 *  - verified complete  → FINALIZE (Scenario A): mark done + record it as an automation finalize.
 *  - not verified       → FLAG (Scenario B): leave it open, flag for office reconciliation, and mark a
 *                         conflict when the truck is physically still out (an active stop).
 * Pure: it only decides. The caller applies the writes idempotently. A route whose successor has no known
 * start time is left alone (we never invent a window).
 */
export function planTruckHandoff(routes: Route[], nowMs: number, bufferMin: number): TruckHandoffPlan {
  const truckId = routes[0]?.truckId ?? "";
  const bufferMs = bufferMin * 60_000;
  const sorted = [...routes]
    .map((r) => ({ r, start: routeEarliestStopMs(r) }))
    .sort((a, b) => a.start - b.start || a.r.routeId.localeCompare(b.r.routeId));

  const actions: HandoffAction[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const prior = sorted[i].r;
    const next = sorted[i + 1];
    if (prior.status === "done") continue; // already closed — nothing to hand off
    if (next.start === Number.MAX_SAFE_INTEGER) continue; // next has no known start → defer, never guess
    if (nowMs < next.start - bufferMs) continue; // next route's handoff window has not opened yet

    if (isVerifiedComplete(prior)) {
      actions.push({ kind: "finalize", routeId: prior.routeId, truckId, reason: "verified_complete", incomplete: 0 });
    } else {
      const incomplete = incompleteStopCount(prior);
      const conflict = hasActiveStop(prior);
      actions.push({
        kind: "flag",
        routeId: prior.routeId,
        truckId,
        reason: conflict ? "active_truck_unverified" : "window_passed_unverified",
        conflict,
        incomplete,
      });
    }
  }
  return { truckId, actions };
}

/** Clamp a buffer-minutes value to the supported 15-30 range, falling back to the default on garbage. */
export function clampBufferMinutes(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 15 && n <= 30 ? n : fallback;
}

export type { Stop };

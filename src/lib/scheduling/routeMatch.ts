// Route crew shifts match the route unless someone overrides it.
//
// Owner rule (2026-11-12), verbatim: "Shifts have to match the route unless someone overrides it." This is the
// ONE policy for every shift tied to a route:
//   - THE DEFAULT IS THE ROUTE. Start and end come from the route's crew window: first stop minus the load
//     buffer, rounded to the nearest quarter hour, through last stop plus the return buffer (see
//     routeRatchet.routeOwnWindow + quarterHour.crewWindow). When Goodshuffle changes the route, a shift that
//     is not overridden follows it, both ways (earlier, later, longer and shorter). This replaces the older
//     "never auto shrink" guardrail.
//   - OVERRIDES ARE EXPLICIT AND STICK. A person changing the time in Dispatch, or a time change made in
//     Connecteam, marks the shift overridden (who, when, the route time it replaced). The follow job never
//     moves it. "Reset to route" clears it.
//   - NOTHING PUBLISHED MOVES SILENTLY FOR AN OLD DIFFERENCE. A shift already in Connecteam whose time differs
//     from the route while the route itself has not changed is HELD for a person: Reset to route, or Keep this
//     time (which records an override). Only a real route change moves a published shift on its own, which is
//     the existing route follow behavior (announced in Slack).
//
// PURE + deterministic. The effectful pass lives in routeAutoSync.applyRouteWindowRatchet.

import type { RouteTimeOverride, StaffShift } from "./types";

export interface CrewWin {
  start: string | null;
  end: string | null;
  known: boolean;
}

type ShiftTimes = Pick<StaffShift, "role" | "routeId" | "startTime" | "endTime" | "windowKnown" | "connecteamShiftId" | "routeOverride" | "routeWindowStart" | "routeWindowEnd" | "status">;

export type RouteMatch =
  /** Not tied to a route, cancelled, or the route has no stop times: the policy does not apply. */
  | { kind: "not_route" }
  /** A person set this time on purpose. Keep it. */
  | { kind: "override"; override: RouteTimeOverride }
  /** Already on the route's time. `rebaseline` = remember this route window (bookkeeping only). */
  | { kind: "matches"; rebaseline: boolean }
  /** The route itself changed since the shift was last matched: move with it (push to Connecteam if linked). */
  | { kind: "follow"; start: string; end: string; reason: string }
  /** Differs from the route and is not in Connecteam yet: put it on the route's time. */
  | { kind: "correct"; start: string; end: string }
  /** Differs from the route but is already in Connecteam: held for a person to Reset to route or Keep. */
  | { kind: "differs_published"; start: string; end: string; rebaseline: boolean };

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);
const sameInstant = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = ms(a);
  const y = ms(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
};

/** Is this a shift the route policy governs? A live, non office shift tied to a route. */
export function isRouteShift(s: Pick<StaffShift, "routeId" | "role" | "status">): boolean {
  return Boolean(s.routeId) && s.role !== "office" && s.status !== "cancelled";
}

/** Does the shift sit exactly on the route crew window? */
export function matchesRoute(s: Pick<StaffShift, "startTime" | "endTime" | "windowKnown">, crew: CrewWin): boolean {
  return crew.known && s.windowKnown && sameInstant(s.startTime, crew.start) && sameInstant(s.endTime, crew.end);
}

function followReason(prev: { start: string | null; end: string | null }, crew: { start: string; end: string }): string {
  const parts: string[] = [];
  const dS = ms(crew.start) - ms(prev.start);
  const dE = ms(crew.end) - ms(prev.end);
  if (Number.isFinite(dS) && dS < 0) parts.push("the route now starts earlier");
  if (Number.isFinite(dS) && dS > 0) parts.push("the route now starts later");
  if (Number.isFinite(dE) && dE > 0) parts.push("the route now ends later");
  if (Number.isFinite(dE) && dE < 0) parts.push("the route now ends earlier");
  return parts.join(" and ") || "the route changed";
}

/** PURE. What the route policy says to do with one shift, given its route's current crew window. */
export function routeMatchDecision(shift: ShiftTimes, crew: CrewWin): RouteMatch {
  if (!isRouteShift(shift) || !crew.known || !crew.start || !crew.end || ms(crew.end) <= ms(crew.start)) return { kind: "not_route" };
  if (shift.routeOverride) return { kind: "override", override: shift.routeOverride };

  const baselineKnown = Boolean(shift.routeWindowStart && shift.routeWindowEnd);
  const baselineIsCrew = baselineKnown && sameInstant(shift.routeWindowStart, crew.start) && sameInstant(shift.routeWindowEnd, crew.end);
  if (matchesRoute(shift, crew)) return { kind: "matches", rebaseline: !baselineIsCrew };

  // The route moved since we last matched it: follow (this is the long standing route follow behavior).
  if (baselineKnown && !baselineIsCrew) {
    return { kind: "follow", start: crew.start, end: crew.end, reason: followReason({ start: shift.routeWindowStart, end: shift.routeWindowEnd }, { start: crew.start, end: crew.end }) };
  }
  // An old difference with the route unchanged.
  if (shift.connecteamShiftId) return { kind: "differs_published", start: crew.start, end: crew.end, rebaseline: !baselineIsCrew };
  return { kind: "correct", start: crew.start, end: crew.end };
}

/**
 * PURE. The override bookkeeping after a person edits a route shift's time in Dispatch. Returns the patch to
 * merge, or null when the edit did not touch the time (or the shift is not a route shift).
 *  - new time == route time → clears any override (the shift follows the route again).
 *  - anything else          → an override by `actor`, remembering the route time it replaced.
 */
export function overrideAfterEdit(
  prev: Pick<StaffShift, "role" | "routeId" | "status" | "startTime" | "endTime">,
  next: { startTime: string | null; endTime: string | null },
  crew: CrewWin,
  actor: string,
  now: string,
): Pick<StaffShift, "routeOverride" | "routeWindowStart" | "routeWindowEnd"> | null {
  if (!isRouteShift(prev) || !crew.known || !crew.start || !crew.end) return null;
  if (sameInstant(prev.startTime, next.startTime) && sameInstant(prev.endTime, next.endTime)) return null;
  const onRoute = sameInstant(next.startTime, crew.start) && sameInstant(next.endTime, crew.end);
  return {
    routeOverride: onRoute ? null : { by: actor, at: now, source: "dispatch", routeStart: crew.start, routeEnd: crew.end },
    routeWindowStart: crew.start,
    routeWindowEnd: crew.end,
  };
}

/** PURE. Override record for a time change that came FROM Connecteam (detected on import). Null when the
 *  imported time is the route's own time (then the shift simply matches). */
export function connecteamOverride(
  shift: Pick<StaffShift, "role" | "routeId" | "status">,
  imported: { startTime: string | null; endTime: string | null },
  crew: CrewWin,
  now: string,
): RouteTimeOverride | null {
  if (!isRouteShift(shift) || !crew.known || !crew.start || !crew.end) return null;
  if (sameInstant(imported.startTime, crew.start) && sameInstant(imported.endTime, crew.end)) return null;
  return { by: "Connecteam", at: now, source: "connecteam", routeStart: crew.start, routeEnd: crew.end };
}

/** One line of the route time audit. */
export interface RouteAuditRow {
  shiftId: string;
  date: string;
  role: StaffShift["role"];
  routeId: string;
  inConnecteam: boolean;
  shiftStart: string | null;
  shiftEnd: string | null;
  routeStart: string;
  routeEnd: string;
  /** override = keep. held = in Connecteam, waits for a person. will_correct = not published, the job fixes it.
   *  will_follow = the route changed, the job moves it. */
  verdict: "override" | "held" | "will_correct" | "will_follow";
  overrideBy: string | null;
}

/** PURE. Every route shift whose time does not match its route, with what will happen to it. */
export function routeTimeAudit(shifts: StaffShift[], crewOf: (routeId: string) => CrewWin): RouteAuditRow[] {
  const rows: RouteAuditRow[] = [];
  for (const s of shifts) {
    if (!s.routeId) continue;
    const crew = crewOf(s.routeId);
    const d = routeMatchDecision(s, crew);
    if (d.kind === "not_route" || d.kind === "matches" || !crew.start || !crew.end) continue;
    const verdict = d.kind === "override" ? "override" : d.kind === "differs_published" ? "held" : d.kind === "correct" ? "will_correct" : "will_follow";
    rows.push({
      shiftId: s.id,
      date: s.date,
      role: s.role,
      routeId: s.routeId,
      inConnecteam: Boolean(s.connecteamShiftId),
      shiftStart: s.startTime,
      shiftEnd: s.endTime,
      routeStart: crew.start,
      routeEnd: crew.end,
      verdict,
      overrideBy: d.kind === "override" ? d.override.by : null,
    });
  }
  return rows;
}

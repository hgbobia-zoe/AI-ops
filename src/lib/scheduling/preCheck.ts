// Route Staffing Pre-Check — the gate in front of a route's shift debrief/pre-brief. Before a route's
// packet is sent, this verifies the route actually has its required crew ASSIGNED IN THE APP. If a present
// route has a staffing gap (no driver, short helpers, nobody at all), its debrief is HELD and someone is
// notified to assign crew or "mark it done".
//
// THE DESIGN LAW (docs/work-schedule-vs-route-assignment.md §2.2): a Connecteam WORK SHIFT is NOT a route
// assignment. "Staffed" here counts ONLY explicit app assignments — a driver set on the route (Dispatch) or
// an app staff_shift assignee. A route crewed only the OLD way (scheduled in Connecteam off the Goodshuffle
// route, never assigned in the app) reads as a GAP, and the Connecteam-scheduled people surface as the
// CANDIDATES to assign (recommendCrew / eligibilityFor) — never credited as coverage. The user either
// assigns them or marks the route done (handled the old way / intentionally solo).
//
// RULES CALCULATE: computeRouteGap is a PURE function of (required, assigned, ack). The data gathering
// (routePreChecksForDate) composes the SAME readers the board already uses — crewForRoute (crew rules),
// the route's app shifts + Dispatch driver (explicit assignment), and recommendCrew (candidates). No LLM.

import { crewForRoute } from "@/lib/crewRules";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate } from "@/lib/db/repo";
import { getShiftsForDate } from "./store";
import { recommendCrew, type RecommendContext } from "./availability";
import { assignmentWindowsFromShifts, getDayAvailabilityCached } from "./eligibilityInputs";
import { getPreCheckAck, assignedSig } from "./preCheckStore";
import { routeWindow } from "@/lib/risk/engine";
import { DEFAULT_RISK_CONFIG, type EngineRoute } from "@/lib/risk/types";
import {
  getCrewForDateSafe,
  getUsersList,
  connecteamConfigured,
  type CrewMember,
  type CrewShift,
  type UnavailabilityBlock,
} from "@/lib/connecteam";
import type { ShiftRole, StaffShift } from "./types";
import type { Route } from "@/lib/types";

/** The route-crew roles the pre-check gates. PREP is day-level warehouse work (not route-tied, no routeId),
 *  so it is deliberately out of a per-ROUTE check — a route needs a driver and its tent/field helpers. */
export type RouteCrewRole = Extract<ShiftRole, "driver" | "field">;

export interface RoleCount {
  driver: number;
  field: number;
}

export type PreCheckStatus = "ok" | "gap" | "resolved";

/** The PURE pre-check verdict for one route. `status`:
 *   • "ok"       — required crew is fully assigned in the app (debrief sends normally).
 *   • "gap"      — under-assigned and not acked → HOLD the debrief + notify.
 *   • "resolved" — still a gap, but explicitly "marked done" (old-way / solo) → hold cleared, no alert. */
export interface RouteGap {
  requiredByRole: RoleCount;
  assignedByRole: RoleCount;
  gapByRole: RoleCount;
  /** driver + field seats still unassigned — the severity used for dedupe/worsening. */
  totalGap: number;
  /** No one at all is assigned to a route that needs crew. */
  nobody: boolean;
  status: PreCheckStatus;
  /** Deterministic, human-free summary of what's missing ("no driver", "needs 2 more helpers", …). */
  reason: string;
}

export interface RouteGapInput {
  requiredByRole: RoleCount;
  assignedByRole: RoleCount;
  /** An explicit "mark done" ack is in force for the CURRENT assignment state (see preCheckStore). */
  acked: boolean;
}

/** Cap assigned at required per role, then the gap is the honest remainder. */
function gapFor(required: number, assigned: number): number {
  return Math.max(0, required - Math.min(assigned, required));
}

/** Pure, deterministic gap math + status. No DB, no network, no AI. */
export function computeRouteGap(input: RouteGapInput): RouteGap {
  const requiredByRole = input.requiredByRole;
  const assignedByRole = input.assignedByRole;
  const gapByRole: RoleCount = {
    driver: gapFor(requiredByRole.driver, assignedByRole.driver),
    field: gapFor(requiredByRole.field, assignedByRole.field),
  };
  const totalGap = gapByRole.driver + gapByRole.field;
  const totalRequired = requiredByRole.driver + requiredByRole.field;
  const totalAssigned = Math.min(assignedByRole.driver, requiredByRole.driver) + Math.min(assignedByRole.field, requiredByRole.field);
  const nobody = totalRequired > 0 && totalAssigned === 0;
  const hasGap = totalGap > 0;

  const status: PreCheckStatus = !hasGap ? "ok" : input.acked ? "resolved" : "gap";
  return { requiredByRole, assignedByRole, gapByRole, totalGap, nobody, status, reason: reasonFor(gapByRole, nobody, status) };
}

/** A short, deterministic phrase for what's missing. */
function reasonFor(gap: RoleCount, nobody: boolean, status: PreCheckStatus): string {
  if (status === "ok") return "Fully staffed";
  if (nobody) return status === "resolved" ? "Nobody assigned (marked done)" : "Nobody assigned";
  const parts: string[] = [];
  if (gap.driver > 0) parts.push("no driver");
  if (gap.field > 0) parts.push(`needs ${gap.field} more helper${gap.field === 1 ? "" : "s"}`);
  const base = parts.join(", ") || "Under-assigned";
  return status === "resolved" ? `${base} (marked done)` : base;
}

// ── Data gathering (composes the existing readers; no gap logic lives here) ───────────────────────────

export interface CandidatePerson {
  userId: number;
  name: string;
  role: RouteCrewRole;
  /** The eligibility state behind the suggestion (SCHEDULED_UNASSIGNED = on the Connecteam schedule today). */
  state: string;
}

/** One route's full pre-check, for the UI + the alert. Serializable (crosses the server→client boundary). */
export interface RoutePreCheck extends RouteGap {
  routeId: string;
  date: string;
  truckId: string;
  truckName: string;
  stopCount: number;
  customerCount: number;
  /** Connecteam-scheduled people who could be ASSIGNED to close the gap (NEVER counted as coverage). */
  connecteamCandidates: CandidatePerson[];
  /** False → Connecteam was unreachable, so the candidate list is UNKNOWN (never "nobody could help"). */
  connecteamReachable: boolean;
}

/** Required route crew from the SAME rule the demand generator uses: 1 driver + (crewForRoute − 1) helpers.
 *  A route always needs a driver; tent/size rules decide the helper count. */
export function requiredCrewForRoute(route: Route): RoleCount {
  const need = crewForRoute(route.stops.map((s) => s.items ?? []));
  return { driver: 1, field: Math.max(0, need.crew - 1) };
}

/** Explicit APP assignment count per role for a route: the Dispatch-assigned driver OR a driver app-shift
 *  assignee covers the driver seat; field assignees come from the route's field app-shifts. Connecteam work
 *  shifts are NOT counted (doc §2.2). */
export function assignedCrewForRoute(route: Route, routeShifts: StaffShift[]): RoleCount {
  const driverShiftAssignees = routeShifts.filter((s) => s.role === "driver").reduce((n, s) => n + s.assignees.length, 0);
  const driver = route.driverId ? Math.max(1, driverShiftAssignees) : driverShiftAssignees;
  const field = routeShifts.filter((s) => s.role === "field").reduce((n, s) => n + s.assignees.length, 0);
  return { driver, field };
}

/** SYNC gate for the send path: the pure RouteGap for a shift's route, from LOCAL data only (app shifts +
 *  Dispatch driver + ack). No Connecteam — the HOLD decision never needs the candidate list, so the send
 *  path stays fast and offline-safe. Returns null when the shift isn't tied to a known present route. */
export function preCheckGateForShift(shift: Pick<StaffShift, "routeId" | "truckId" | "date">): RouteGap | null {
  if (!shift.routeId || !shift.truckId) return null;
  const route = getRoutesForDate(shift.truckId, shift.date).find((r) => r.routeId === shift.routeId);
  if (!route || route.status === "done") return null;
  const routeShifts = getShiftsForDate(shift.date).filter((s) => s.routeId === route.routeId);
  const required = requiredCrewForRoute(route);
  const assigned = assignedCrewForRoute(route, routeShifts);
  const ack = getPreCheckAck(shift.date, route.routeId);
  const acked = ack != null && ack.assignedSig === assignedSig(assigned);
  return computeRouteGap({ requiredByRole: required, assignedByRole: assigned, acked });
}

/** Enumerate present routes for a day and build the full pre-check per route (gap + Connecteam candidates).
 *  Composes existing readers only. Connecteam candidates are honest: when the schedule is unreachable the
 *  candidate list is empty and `connecteamReachable` is false (never a fabricated "nobody could help"). */
export async function routePreChecksForDate(date: string): Promise<RoutePreCheck[]> {
  const trucks = getActiveVehicles();
  const routes = trucks.flatMap((t) => getRoutesForDate(t.truckId, date)).filter((r) => r.status !== "done" && r.stops.length > 0);
  if (routes.length === 0) return [];

  const shifts = getShiftsForDate(date);
  const truckName = (id: string): string => trucks.find((t) => t.truckId === id)?.name ?? id;

  // Connecteam feeds for the candidate lookup (shared across routes). Honest reachability throughout.
  const configured = connecteamConfigured();
  let crew: { ok: boolean; shifts: CrewShift[] } = { ok: false, shifts: [] };
  let roster: CrewMember[] = [];
  let availability: { ok: boolean; byUser: Map<number, UnavailabilityBlock[]> } = { ok: false, byUser: new Map() };
  if (configured) {
    [crew, roster] = await Promise.all([getCrewForDateSafe(date), getUsersList()]);
    availability = crew.ok ? await getDayAvailabilityCached(date, roster.map((m) => m.userId)) : { ok: false, byUser: new Map() };
  }
  const ctx: RecommendContext = {
    assignments: assignmentWindowsFromShifts(shifts),
    unavailabilityByUser: availability.byUser,
    availabilityKnown: availability.ok,
  };
  const connecteamReachable = configured && crew.ok;

  const out: RoutePreCheck[] = [];
  for (const route of routes) {
    const routeShifts = shifts.filter((s) => s.routeId === route.routeId);
    const required = requiredCrewForRoute(route);
    const assigned = assignedCrewForRoute(route, routeShifts);
    const ack = getPreCheckAck(date, route.routeId);
    const acked = ack != null && ack.assignedSig === assignedSig(assigned);
    const gap = computeRouteGap({ requiredByRole: required, assignedByRole: assigned, acked });

    // Candidates: who on the Connecteam schedule could be ASSIGNED to the open seats (never coverage). Only
    // when the gap is real and Connecteam answered — otherwise honestly empty.
    const candidates: CandidatePerson[] = [];
    if (connecteamReachable && gap.status === "gap") {
      const win = routeAssignWindow(route, routeShifts);
      const roles: RouteCrewRole[] = [];
      if (gap.gapByRole.driver > 0) roles.push("driver");
      if (gap.gapByRole.field > 0) roles.push("field");
      const seen = new Set<number>();
      for (const role of roles) {
        const assignees = routeShifts.filter((s) => s.role === role).flatMap((s) => s.assignees);
        const recs = recommendCrew(syntheticShift(date, role, win, assignees), crew.shifts, roster, ctx, 5);
        for (const r of recs) {
          if (seen.has(r.userId)) continue;
          seen.add(r.userId);
          candidates.push({ userId: r.userId, name: r.name, role, state: r.state });
        }
      }
    }

    out.push({
      ...gap,
      routeId: route.routeId,
      date,
      truckId: route.truckId,
      truckName: truckName(route.truckId),
      stopCount: route.stops.length,
      customerCount: new Set(route.stops.map((s) => s.custName).filter(Boolean)).size,
      connecteamCandidates: candidates,
      connecteamReachable,
    });
  }
  return out;
}

/** The route's assign window — a built shift's hand-tuned window wins, else the route's own stop-derived
 *  window (so recommendCrew can overlap-check even before any shift exists). */
function routeAssignWindow(route: Route, routeShifts: StaffShift[]): { start: string | null; end: string | null; known: boolean } {
  const withWin = routeShifts.filter((s) => s.windowKnown && s.startTime);
  if (withWin.length > 0) {
    let start = withWin[0].startTime!;
    let end: string | null = null;
    for (const s of withWin) {
      if (s.startTime! < start) start = s.startTime!;
      if (s.endTime && (end === null || s.endTime > end)) end = s.endTime;
    }
    return { start, end, known: true };
  }
  const er: EngineRoute = {
    routeId: route.routeId,
    truckId: route.truckId,
    date: route.date,
    status: route.status,
    gsRouteId: route.gsRouteId,
    driverId: route.driverId,
    driverName: route.driverName,
    stops: route.stops.map((s) => ({ sequence: s.sequence, custName: s.custName, kind: s.kind, plannedWindow: s.plannedWindow, eta: s.eta, items: s.items })),
  };
  const w = routeWindow(er, DEFAULT_RISK_CONFIG);
  if (!w) return { start: null, end: null, known: false };
  return { start: new Date(w.startUnix * 1000).toISOString(), end: new Date(w.endUnix * 1000).toISOString(), known: true };
}

/** A synthetic StaffShift for recommendCrew (only the fields it reads matter). Mirrors scheduling/page.tsx. */
function syntheticShift(date: string, role: ShiftRole, win: { start: string | null; end: string | null; known: boolean }, assignees: number[]): StaffShift {
  return {
    id: "", date, role, headcount: 1,
    startTime: win.start, endTime: win.end, windowKnown: win.known,
    location: null, routeId: null, truckId: null, eventLabel: null, reasons: [], notes: null,
    source: "derived", status: "draft", assignees, instaworkHeadcount: 0, payRate: null,
    connecteamShiftId: null, connecteamSchedulerId: null, connecteamPublishedAt: null,
    instaworkGigId: null, instaworkPostedAt: null,
    lifecycleState: null, supervisorUserId: null, reportLocation: null, reportTime: null, equipment: [], instructions: null,
    createdAt: "", updatedAt: "",
  } satisfies StaffShift;
}

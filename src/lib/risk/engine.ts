// Event Risk Engine (MVP2) — deterministic rule engine (pure, testable, no DB/network/AI).
//
// Given a day's routes, the Connecteam driver + warehouse shifts, and "now", it returns a
// flat list of RiskFindings. RULES CALCULATE — this layer never guesses: when a fact can't
// be verified (e.g. a route has no stop times) it emits an explicit "unverified" finding
// rather than a false positive/negative.
//
// Route staffing model (see MVP2 spec): ROUTES ARE ATOMIC — 1 route = 1 driver. Two routes
// to the SAME venue with DIFFERENT drivers is valid (no conflict). The same driver on two
// overlapping routes is CRITICAL. Event/setup crew (tents) and warehouse crew are separate
// from the route driver.

import { crewForRoute } from "@/lib/crewRules";
import {
  type EngineRoute,
  type EngineShift,
  type RiskFinding,
  type RiskSeverity,
  type RiskConfig,
  DEFAULT_RISK_CONFIG,
} from "./types";

const MIN = 60; // seconds

// ── time helpers ─────────────────────────────────────────────────────────────
function stopUnix(s: { plannedWindow?: string; eta?: string }): number | null {
  const raw = s.plannedWindow || s.eta;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

export interface RouteWindow {
  /** Full operational window incl. load buffer before / return buffer after the stops. */
  startUnix: number;
  endUnix: number;
  /** Raw span of the stops themselves (no buffers) — used to tell "tight" from "not covered". */
  rawStart: number;
  rawEnd: number;
  /** True when we had real stop times to compute the window. */
  known: boolean;
}

/** The driver's operational window: load buffer before the first stop → return buffer after the last. */
export function routeWindow(route: EngineRoute, cfg: RiskConfig): RouteWindow | null {
  const times = route.stops.map(stopUnix).filter((t): t is number => t != null);
  if (times.length === 0) return null;
  const first = Math.min(...times);
  const last = Math.max(...times);
  return {
    startUnix: first - cfg.loadBufferMin * MIN,
    endUnix: last + cfg.returnBufferMin * MIN,
    rawStart: first,
    rawEnd: last,
    known: true,
  };
}

function overlaps(a: RouteWindow, b: RouteWindow): boolean {
  return a.startUnix < b.endUnix && b.startUnix < a.endUnix;
}

/** Whole-day-of-week proximity: days from `now` to the route date (0 = today, 1 = tomorrow). */
export function daysUntil(date: string, now: Date): number {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return 999;
  const target = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / 86_400_000);
}

/** Escalate a base severity as the event approaches (spec §11/§16). */
function escalate(base: RiskSeverity, days: number): RiskSeverity {
  if (days <= 1 && base === "HIGH") return "CRITICAL";
  if (days <= 3 && base === "MEDIUM") return "HIGH";
  if (days <= 7 && base === "LOW") return "MEDIUM";
  return base;
}

// ── driver / route staffing ──────────────────────────────────────────────────
function assessDrivers(
  date: string,
  routes: EngineRoute[],
  driverShifts: EngineShift[],
  now: Date,
  cfg: RiskConfig,
  staffingVerified: boolean,
): RiskFinding[] {
  const out: RiskFinding[] = [];
  const days = daysUntil(date, now);
  const active = routes.filter((r) => r.status !== "done");
  if (active.length === 0) return out;

  const assignmentInUse = cfg.driverAssignmentEnabled || active.some((r) => r.driverId);
  const shiftsFor = (uid: string) => driverShifts.filter((s) => String(s.userId) === String(uid));

  if (assignmentInUse) {
    for (const r of active) {
      // "No driver assigned" is a DISPATCH fact — valid to flag even without Connecteam.
      if (!r.driverId) {
        out.push({
          signature: `route_no_driver|${r.routeId}`,
          riskType: "route_no_driver",
          category: "DRIVER",
          severity: "CRITICAL",
          title: `No driver assigned — ${r.truckId}`,
          description: `Route ${r.truckId} on ${date} has no driver assigned. A route cannot roll without a driver.`,
          date,
          routeId: r.routeId,
          truckId: r.truckId,
          recommendedAction: "Assign a driver to this route.",
          actionTarget: "dispatch",
        });
        continue;
      }
      // Everything below needs Connecteam. If staffing is unverified, DON'T guess — the
      // day-level UNVERIFIED finding (added by assessDay) already flags the gap.
      if (!staffingVerified) continue;
      const shifts = shiftsFor(r.driverId);
      if (shifts.length === 0) {
        out.push({
          signature: `driver_not_scheduled|${r.routeId}|${r.driverId}`,
          riskType: "driver_not_scheduled",
          category: "DRIVER",
          severity: escalate("HIGH", days),
          title: `Driver not scheduled — ${r.driverName || r.driverId}`,
          description: `${r.driverName || "The assigned driver"} is on ${r.truckId} (${date}) but has no Connecteam shift that day.`,
          date,
          routeId: r.routeId,
          truckId: r.truckId,
          affectedEntity: r.driverName,
          recommendedAction: "Schedule the driver in Connecteam, or reassign the route.",
          actionTarget: "connecteam",
        });
        continue;
      }
      const win = routeWindow(r, cfg);
      if (!win) {
        out.push(unverifiedSchedule(r, date));
        continue;
      }
      // Full window (with load/return buffers) covered → PASS. Covers the stops but not the
      // buffers → tight (MEDIUM). Doesn't cover the stops → gap (HIGH). Boundary-inclusive.
      const coversFull = shifts.some((s) => s.startUnix <= win.startUnix && s.endUnix >= win.endUnix);
      if (coversFull) continue;
      const coversStops = shifts.some((s) => s.startUnix <= win.rawStart && s.endUnix >= win.rawEnd);
      if (coversStops) {
        out.push({
          signature: `driver_tight_buffer|${r.routeId}|${r.driverId}`,
          riskType: "driver_tight_buffer",
          category: "DRIVER",
          severity: escalate("MEDIUM", days),
          title: `Tight driver buffer — ${r.driverName || r.driverId}`,
          description: `${r.driverName || "The driver"}'s shift covers ${r.truckId}'s stops on ${date} but leaves no load/return buffer.`,
          date,
          routeId: r.routeId,
          truckId: r.truckId,
          affectedEntity: r.driverName,
          recommendedAction: "Confirm the driver can load early / return late, or widen the shift.",
          actionTarget: "connecteam",
        });
        continue;
      }
      out.push({
        signature: `driver_shift_gap|${r.routeId}|${r.driverId}`,
        riskType: "driver_shift_gap",
        category: "DRIVER",
        severity: escalate("HIGH", days),
        title: `Driver shift doesn't cover the route — ${r.driverName || r.driverId}`,
        description: `${r.driverName || "The driver"}'s Connecteam shift doesn't span ${r.truckId}'s stops on ${date}.`,
        date,
        routeId: r.routeId,
        truckId: r.truckId,
        affectedEntity: r.driverName,
        recommendedAction: "Extend the shift in Connecteam or reassign the route.",
        actionTarget: "connecteam",
      });
    }

    // Double-booking: same driver on two overlapping routes. Uses Dispatch assignments +
    // route windows only (no Connecteam) — valid regardless of staffingVerified.
    const byDriver = new Map<string, EngineRoute[]>();
    for (const r of active) if (r.driverId) byDriver.set(r.driverId, [...(byDriver.get(r.driverId) ?? []), r]);
    for (const [uid, rs] of byDriver) {
      if (rs.length < 2) continue;
      const wins = rs.map((r) => routeWindow(r, cfg));
      let conflict = false;
      for (let i = 0; i < wins.length; i++)
        for (let j = i + 1; j < wins.length; j++) {
          const a = wins[i],
            b = wins[j];
          // Unknown windows can't be proven disjoint → treat as a conflict (same driver, 2 routes).
          if (!a || !b || overlaps(a, b)) conflict = true;
        }
      if (conflict) {
        const name = rs[0].driverName || uid;
        out.push({
          signature: `driver_double_booked|${date}|${uid}`,
          riskType: "driver_double_booked",
          category: "DRIVER",
          severity: "CRITICAL",
          title: `Driver assigned to multiple routes — ${name}`,
          description: `${name} is assigned to ${rs.length} overlapping routes on ${date} (${rs.map((r) => r.truckId).join(", ")}). One driver can't run two routes at once.`,
          date,
          affectedEntity: name,
          recommendedAction: "Assign a different driver to one of the routes.",
          actionTarget: "dispatch",
          metadata: { routeIds: rs.map((r) => r.routeId) },
        });
      }
    }
  }

  // Day-level headcount coverage — only when staffing is verified (else we can't count).
  if (staffingVerified) {
    const scheduled = new Set(driverShifts.map((s) => String(s.userId)));
    const need = active.length;
    if (scheduled.size < need) {
      const gap = need - scheduled.size;
      const base: RiskSeverity = scheduled.size === 0 ? "CRITICAL" : "HIGH";
      out.push({
        signature: `driver_shortage|${date}`,
        riskType: "driver_shortage",
        category: "STAFFING",
        severity: escalate(base, days),
        title: `Not enough drivers scheduled (${date})`,
        description: `${need} route${need === 1 ? "" : "s"} need drivers but only ${scheduled.size} driver${scheduled.size === 1 ? "" : "s"} ${scheduled.size === 1 ? "is" : "are"} scheduled in Connecteam — short by ${gap}.`,
        date,
        recommendedAction: "Schedule more drivers, or consolidate routes.",
        actionTarget: "connecteam",
        metadata: { need, scheduled: scheduled.size },
      });
    }
  }

  return out;
}

function unverifiedSchedule(r: EngineRoute, date: string): RiskFinding {
  return {
    signature: `route_schedule_unverified|${r.routeId}`,
    riskType: "route_schedule_unverified",
    category: "SCHEDULE",
    severity: "MEDIUM",
    title: `Schedule couldn't be verified — ${r.truckId}`,
    description: `Route ${r.truckId} on ${date} has no stop times, so driver-shift coverage can't be checked.`,
    date,
    routeId: r.routeId,
    truckId: r.truckId,
    recommendedAction: "Add delivery/pickup windows in Goodshuffle.",
    actionTarget: "goodshuffle",
  };
}

// ── warehouse capacity (configurable, not hard-coded) ────────────────────────
function assessWarehouse(
  date: string,
  routes: EngineRoute[],
  warehouseShifts: EngineShift[],
  now: Date,
  cfg: RiskConfig,
): RiskFinding[] {
  const active = routes.filter((r) => r.status !== "done");
  if (active.length === 0) return [];
  const need = Math.ceil(active.length / Math.max(1, cfg.warehousePerRoutes));
  const scheduled = new Set(warehouseShifts.map((s) => String(s.userId))).size;
  if (scheduled >= need) return [];
  const days = daysUntil(date, now);
  return [
    {
      signature: `warehouse_shortage|${date}`,
      riskType: "warehouse_shortage",
      category: "WAREHOUSE",
      severity: escalate(scheduled === 0 ? "HIGH" : "MEDIUM", days),
      title: `Warehouse coverage short (${date})`,
      description: `${active.length} route${active.length === 1 ? "" : "s"} need ~${need} warehouse associate${need === 1 ? "" : "s"} to prep & load, but only ${scheduled} scheduled.`,
      date,
      recommendedAction: "Schedule warehouse/asset crew for the load day.",
      actionTarget: "connecteam",
      metadata: { need, scheduled },
    },
  ];
}

// ── tent / setup crew (preserve existing deterministic crew rules) ───────────
function assessSetupCrew(
  date: string,
  routes: EngineRoute[],
  fieldCrewScheduled: number,
  now: Date,
): RiskFinding[] {
  const active = routes.filter((r) => r.status !== "done");
  const need = active.reduce((sum, r) => sum + crewForRoute(r.stops.map((s) => s.items ?? [])).crew, 0);
  if (need <= fieldCrewScheduled) return [];
  const days = daysUntil(date, now);
  const tentRoutes = active
    .map((r) => ({ r, need: crewForRoute(r.stops.map((s) => s.items ?? [])) }))
    .filter((x) => x.need.hasTent);
  return [
    {
      signature: `setup_crew_shortage|${date}`,
      riskType: "setup_crew_shortage",
      category: "SETUP",
      severity: escalate(tentRoutes.length ? "HIGH" : "MEDIUM", days),
      title: `Setup/install crew short (${date})`,
      description: `The day's items need ~${need} crew on the trucks (tent rules)${tentRoutes.length ? ` — incl. ${tentRoutes.map((x) => `${x.r.truckId} (${x.need.reasons.join(", ")})`).join("; ")}` : ""}, but only ${fieldCrewScheduled} field crew scheduled.`,
      date,
      recommendedAction: "Schedule additional install/field crew.",
      actionTarget: "connecteam",
      metadata: { need, scheduled: fieldCrewScheduled },
    },
  ];
}

// ── unload & clean (after a pickup day) ──────────────────────────────────────
// The scan decides coverage (it has the crew + route-end times): covered = a prep shift
// still on the clock when the trucks return, OR any next-day prep shift. Engine only flags
// when coverage was computed AND is false — never guesses.
function assessUnload(date: string, routes: EngineRoute[], unloadCovered: boolean | undefined, now: Date): RiskFinding[] {
  const active = routes.filter((r) => r.status !== "done");
  const hasPickups = active.some((r) => r.stops.some((s) => s.kind === "pickup"));
  if (!hasPickups || unloadCovered !== false) return [];
  return [
    {
      signature: `unload_shortage|${date}`,
      riskType: "unload_shortage",
      category: "WAREHOUSE",
      severity: escalate("MEDIUM", daysUntil(date, now)),
      title: `No unload crew after pickup (${date})`,
      description: `Pickup route(s) return full, but no warehouse/asset crew is scheduled to unload & clean the trucks (same-day evening or the next day).`,
      date,
      recommendedAction: "Schedule an evening or next-day unload shift.",
      actionTarget: "connecteam",
    },
  ];
}

/** Input snapshot for one day's assessment. */
export interface AssessDayInput {
  date: string;
  routes: EngineRoute[];
  /** Connecteam driver-role shifts for `date`. */
  driverShifts: EngineShift[];
  /** Connecteam warehouse/asset (prep) shifts for the LOAD day (day-before or day-of per workflow). */
  warehouseShifts?: EngineShift[];
  /** Distinct field/install crew available on the event day (drivers + prep), for tent rules. */
  fieldCrewScheduled?: number;
  /** Whether unload/clean crew is covered after a pickup (computed by the scan). Undefined = not checked. */
  unloadCovered?: boolean;
  /** Whether Connecteam staffing data was actually retrieved. When false, staffing rules are
   *  SKIPPED (not guessed) and a single UNVERIFIED finding is emitted for the day. Default true. */
  staffingVerified?: boolean;
  now: Date;
  config?: Partial<RiskConfig>;
}

/** Assess one day and return all deterministic findings (unsorted). */
export function assessDay(input: AssessDayInput): RiskFinding[] {
  const cfg = { ...DEFAULT_RISK_CONFIG, ...(input.config ?? {}) };
  const verified = input.staffingVerified !== false;
  const active = input.routes.filter((r) => r.status !== "done");
  const out: RiskFinding[] = [
    ...assessDrivers(input.date, input.routes, input.driverShifts, input.now, cfg, verified),
  ];
  if (verified) {
    out.push(
      ...assessWarehouse(input.date, input.routes, input.warehouseShifts ?? [], input.now, cfg),
      ...assessSetupCrew(input.date, input.routes, input.fieldCrewScheduled ?? input.driverShifts.length, input.now),
      ...assessUnload(input.date, input.routes, input.unloadCovered, input.now),
    );
  } else if (active.length > 0) {
    // Can't verify staffing → say so explicitly. Never a false "failure".
    out.push({
      signature: `staffing_unverified|${input.date}`,
      riskType: "staffing_unverified",
      category: "STAFFING",
      severity: "MEDIUM",
      title: `Staffing couldn't be verified (${input.date})`,
      description: `Connecteam staffing data is unavailable, so driver/warehouse/setup coverage for this day couldn't be checked. This is NOT a confirmed shortage.`,
      date: input.date,
      recommendedAction: "Check the Connecteam connection, then re-scan.",
      actionTarget: "connecteam",
    });
  }
  return out;
}

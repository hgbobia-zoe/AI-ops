// AI Control Plane: Dispatch blade playbook ("Route Health Check"). Same pattern as the Sales OS runner:
// open a real session, read today's routes, routes still open past their date, and unresolved driver
// exceptions, then record a plain summary and where to look first. It changes nothing: routes are closed
// or rescheduled by a person in Dispatch. The session stays open so the operator can ask Viktor follow-ups.
// RULES CALCULATE, AI INTERPRETS.

import { getRoutesForDate, getOpenExceptions, type ExceptionRow } from "@/lib/db/repo";
import { findRouteHealthIssues, type RouteHealthIssue } from "@/lib/dispatch/routeHealth";
import { getActiveVehicles } from "@/lib/vehicles";
import { todayInOpsTz } from "@/lib/dates";
import { getEmployee } from "@/lib/aiorg/registry";
import { createSession, recordToolRun, appendEvent, setSessionResult, type AiSession } from "@/lib/ai/sessions";
import type { Route } from "@/lib/types";

const DONE = new Set(["Completed", "Returned"]);
const MOVING = new Set(["EnRoute", "Arrived", "HeadingBack"]);

export interface DispatchHealth {
  today: { routes: number; stops: number; done: number; moving: number; waiting: number; noDriver: number };
  overdue: { truck: string; date: string; daysOverdue: number; openStops: number }[];
  exceptions: { type: string | null; reason: string | null; at: string }[];
}

/** Summarize today's routes, overdue open routes and open exceptions. PURE. */
export function summarizeDispatch(todayRoutes: Route[], overdue: RouteHealthIssue[], exceptions: ExceptionRow[]): DispatchHealth {
  const stops = todayRoutes.flatMap((r) => r.stops ?? []);
  return {
    today: {
      routes: todayRoutes.length,
      stops: stops.length,
      done: stops.filter((s) => DONE.has(s.state)).length,
      moving: stops.filter((s) => MOVING.has(s.state)).length,
      waiting: stops.filter((s) => s.state === "Waiting").length,
      noDriver: todayRoutes.filter((r) => !r.driverId && !r.driverName).length,
    },
    overdue: [...overdue]
      .sort((a, b) => b.daysOverdue - a.daysOverdue)
      .map((o) => ({ truck: o.truckLabel, date: o.date, daysOverdue: o.daysOverdue, openStops: o.incompleteStops.length })),
    exceptions: exceptions.map((e) => ({ type: e.type, reason: e.reason, at: e.ts })),
  };
}

/** One plain recommendation. Most urgent first: routes with no driver today, then overdue routes, then
 *  exceptions. PURE. */
export function dispatchRecommendation(h: DispatchHealth): string {
  const parts: string[] = [];
  const t = h.today;
  parts.push(t.routes === 0 ? "No routes today." : `Today: ${t.routes} route${t.routes === 1 ? "" : "s"}, ${t.done} of ${t.stops} stops done, ${t.moving} in progress, ${t.waiting} waiting.`);
  const todo: string[] = [];
  if (t.noDriver > 0) todo.push(`assign a driver to ${t.noDriver} route${t.noDriver === 1 ? "" : "s"} today`);
  if (h.overdue.length > 0) {
    const o = h.overdue[0];
    todo.push(`close or reschedule ${h.overdue.length} route${h.overdue.length === 1 ? "" : "s"} still open past their date (oldest: ${o.truck} on ${o.date})`);
  }
  if (h.exceptions.length > 0) todo.push(`review ${h.exceptions.length} open driver exception${h.exceptions.length === 1 ? "" : "s"}`);
  parts.push(todo.length ? `Next: ${todo.join("; ")}.` : "Nothing needs attention right now.");
  return parts.join(" ");
}

export function runRouteHealthPlaybook(opts: { actor?: string } = {}): AiSession {
  const today = todayInOpsTz();
  const session = createSession({
    agentId: "dispatch-route",
    blade: "dispatch",
    owner: getEmployee("dispatch-route")?.owner,
    startedBy: opts.actor,
    title: "Route Health Check",
    objective: "Check today's routes, routes left open past their date, and open driver exceptions.",
    provider: "viktor-agent",
  });
  const sid = session.id;

  const read = <T>(toolId: string, fn: () => T, fallback: T): T => {
    try {
      const v = fn();
      recordToolRun(sid, { toolId, category: "DATA", perm: "READ", status: "ok", result: { count: Array.isArray(v) ? v.length : 1 } });
      return v;
    } catch (e) {
      recordToolRun(sid, { toolId, category: "DATA", perm: "READ", status: "error", error: String(e).slice(0, 200) });
      return fallback;
    }
  };

  const todayRoutes = read("read_routes_today", () => getActiveVehicles().flatMap((t) => getRoutesForDate(t.truckId, today)), [] as Route[]);
  const overdue = read("read_overdue_routes", () => findRouteHealthIssues(today), [] as RouteHealthIssue[]);
  const exceptions = read("read_open_exceptions", () => getOpenExceptions(), [] as ExceptionRow[]);
  appendEvent(sid, { kind: "step", label: `Read ${todayRoutes.length} routes for today, ${overdue.length} open past their date, ${exceptions.length} open exceptions.` });

  const health = summarizeDispatch(todayRoutes, overdue, exceptions);
  appendEvent(sid, { kind: "recommendation", label: dispatchRecommendation(health), payload: { overdue: health.overdue.slice(0, 10) } });
  setSessionResult(sid, { ...health, exceptions: health.exceptions.slice(0, 25) });
  if (health.overdue.length || health.exceptions.length || health.today.noDriver) {
    appendEvent(sid, { kind: "action_available", label: "Fix these in Dispatch. Ask Viktor here for details on any route or stop." });
  }
  return session;
}

import { describe, it, expect } from "vitest";
import {
  stopStateTone,
  routeStatusView,
  staffingTone,
  messageStatusTone,
  exceptionSeverity,
  scopeDispatchMessages,
  summarizeExceptionsByRoute,
  routePullFreshness,
  type RouteRef,
} from "@/lib/dispatch/boardView";
import type { MessageRow, ExceptionRow } from "@/lib/db/repo";

describe("stopStateTone", () => {
  it("maps terminal states to positive and exceptions to critical", () => {
    expect(stopStateTone("Completed")).toBe("positive");
    expect(stopStateTone("Returned")).toBe("positive");
    expect(stopStateTone("Exception")).toBe("critical");
  });
  it("maps in-flight states to info and waiting to neutral", () => {
    expect(stopStateTone("EnRoute")).toBe("info");
    expect(stopStateTone("Arrived")).toBe("info");
    expect(stopStateTone("HeadingBack")).toBe("info");
    expect(stopStateTone("Waiting")).toBe("neutral");
  });
});

describe("routeStatusView", () => {
  it("reports closed / loading / failed by status", () => {
    expect(routeStatusView("done", 2, 3)).toEqual({ tone: "positive", label: "Closed" });
    expect(routeStatusView("scraping", 0, 0).tone).toBe("info");
    expect(routeStatusView("failed", 0, 3).tone).toBe("critical");
  });
  it("distinguishes ready / complete / in-progress for an open route", () => {
    expect(routeStatusView("active", 0, 0)).toEqual({ tone: "neutral", label: "Ready to start" });
    expect(routeStatusView("active", 3, 3)).toEqual({ tone: "positive", label: "Route complete" });
    expect(routeStatusView("active", 1, 3)).toEqual({ tone: "info", label: "In progress" });
  });
});

describe("staffingTone", () => {
  it("is neutral when no crew is required", () => {
    expect(staffingTone({ requiresCrew: false, status: "ok", nobody: false })).toBe("neutral");
  });
  it("is positive when staffed, critical when nobody, attention on a partial gap", () => {
    expect(staffingTone({ requiresCrew: true, status: "ok", nobody: false })).toBe("positive");
    expect(staffingTone({ requiresCrew: true, status: "gap", nobody: true })).toBe("critical");
    expect(staffingTone({ requiresCrew: true, status: "gap", nobody: false })).toBe("attention");
  });
});

describe("messageStatusTone", () => {
  it("classifies delivery outcomes, keeping undelivered critical", () => {
    expect(messageStatusTone("delivered")).toBe("positive");
    expect(messageStatusTone("sent")).toBe("positive");
    expect(messageStatusTone("undelivered")).toBe("critical");
    expect(messageStatusTone("failed")).toBe("critical");
    expect(messageStatusTone("queued")).toBe("info");
    expect(messageStatusTone(null)).toBe("neutral");
  });
});

describe("exceptionSeverity", () => {
  it("treats operational blockers as critical and soft exceptions as attention", () => {
    expect(exceptionSeverity("Vehicle issue").severity).toBe("critical");
    expect(exceptionSeverity("Wrong address").severity).toBe("critical");
    expect(exceptionSeverity("Customer unavailable").severity).toBe("attention");
    expect(exceptionSeverity("Other").severity).toBe("attention");
    expect(exceptionSeverity(null).severity).toBe("attention");
  });
});

const msg = (over: Partial<MessageRow>): MessageRow => ({
  toPhone: "+13015550000",
  body: "hi",
  status: "delivered",
  sentAt: "2026-10-29T12:00:00Z",
  stopId: null,
  recipientName: "Someone",
  ...over,
});

describe("scopeDispatchMessages", () => {
  it("keeps only messages tied to a board stop and counts the rest as general", () => {
    const messages = [
      msg({ stopId: "S1", body: "on the way" }),
      msg({ stopId: "S2", body: "arrived" }),
      msg({ stopId: "S9", body: "stop not on board" }),
      msg({ stopId: null, body: "sales quote follow-up" }),
    ];
    const { scoped, generalCount } = scopeDispatchMessages(messages, new Set(["S1", "S2"]));
    expect(scoped.map((m) => m.body)).toEqual(["on the way", "arrived"]);
    expect(generalCount).toBe(2); // the off-board stop + the stop-less sales message are kept out
  });
  it("counts everything as general when no routes are on the board", () => {
    const messages = [msg({ stopId: "S1" }), msg({ stopId: null })];
    expect(scopeDispatchMessages(messages, new Set()).generalCount).toBe(2);
  });
});

const exc = (over: Partial<ExceptionRow>): ExceptionRow => ({
  exceptionId: `X-${Math.random()}`,
  stopId: null,
  type: "Other",
  reason: "r",
  truckId: null,
  ts: "2026-10-29T12:00:00Z",
  resolved: false,
  ...over,
});

const routeRef = (over: Partial<RouteRef>): RouteRef => ({
  routeId: "R1",
  truckId: "T1",
  truckName: "Truck 1",
  stopIds: ["S1", "S2"],
  ...over,
});

describe("summarizeExceptionsByRoute", () => {
  it("attributes by stop, then by truck, and groups unattributable ones separately", () => {
    const routes = [routeRef({}), routeRef({ routeId: "R2", truckId: "T2", truckName: "Truck 2", stopIds: ["S3"] })];
    const exceptions = [
      exc({ exceptionId: "a", stopId: "S1", type: "Vehicle issue" }), // → R1 via stop (critical)
      exc({ exceptionId: "b", truckId: "T2", type: "Customer unavailable" }), // → R2 via truck (attention)
      exc({ exceptionId: "c", stopId: "S99", truckId: "T9", type: "Other" }), // → unassigned
    ];
    const groups = summarizeExceptionsByRoute(exceptions, routes);
    expect(groups.map((g) => g.routeId)).toEqual(["R1", "R2", null]);
    expect(groups[0]).toMatchObject({ truckName: "Truck 1", critical: 1, attention: 0 });
    expect(groups[0].items).toHaveLength(1);
    expect(groups[1]).toMatchObject({ truckName: "Truck 2", critical: 0, attention: 1 });
    expect(groups[2]).toMatchObject({ routeId: null, truckName: "Unassigned" });
  });
  it("preserves individual evidence rows", () => {
    const routes = [routeRef({})];
    const exceptions = [exc({ stopId: "S1", reason: "flat tire" }), exc({ stopId: "S2", reason: "locked gate" })];
    const groups = summarizeExceptionsByRoute(exceptions, routes);
    expect(groups[0].items.map((i) => i.reason)).toEqual(["flat tire", "locked gate"]);
  });
});

describe("routePullFreshness", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  it("reports never-pulled honestly when no route source exists", () => {
    const f = routePullFreshness({ bookings: { at: "2026-10-29T11:00:00Z", count: 5 } }, ["T1"], now);
    expect(f).toMatchObject({ everPulled: false, lastPullAt: null, ageHours: null, stale: false });
  });
  it("takes the most recent route pull across the given trucks", () => {
    const f = routePullFreshness(
      {
        "route:T1": { at: "2026-10-29T06:00:00Z", count: 3 },
        "route:T2": { at: "2026-10-29T11:00:00Z", count: 4 },
      },
      ["T1", "T2"],
      now,
    );
    expect(f.everPulled).toBe(true);
    expect(f.lastPullAt).toBe("2026-10-29T11:00:00.000Z");
    expect(f.ageHours).toBeCloseTo(1, 5);
    expect(f.stale).toBe(false);
  });
  it("flags stale when the latest pull is older than the threshold", () => {
    const f = routePullFreshness({ "route:T1": { at: "2026-10-27T06:00:00Z", count: 3 } }, ["T1"], now, 20);
    expect(f.stale).toBe(true);
  });
  it("ignores trucks outside the requested set", () => {
    const f = routePullFreshness({ "route:T9": { at: "2026-10-29T11:00:00Z", count: 4 } }, ["T1"], now);
    expect(f.everPulled).toBe(false);
  });
});

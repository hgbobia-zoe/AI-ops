import { describe, expect, it } from "vitest";
import { reviewRisks, riskRecommendation, runEventRiskReview } from "./eventRisk";
import { summarizeDispatch, dispatchRecommendation, runRouteHealthPlaybook } from "./dispatch";
import { listSessionEvents, getSession } from "@/lib/ai/sessions";
import type { StoredRisk } from "@/lib/risk/store";
import type { RouteHealthIssue } from "@/lib/dispatch/routeHealth";
import type { Route } from "@/lib/types";

function risk(p: Partial<StoredRisk>): StoredRisk {
  return {
    id: "r", signature: "s", riskType: "t", category: "STAFFING", severity: "LOW", status: "OPEN", title: "Risk",
    description: "", firstDetectedAt: "", lastSeenAt: "", ...p,
  } as StoredRisk;
}

describe("Event Risk Review", () => {
  const today = "2026-11-03";

  it("keeps active risks in the horizon, ranks by severity then date", () => {
    const rv = reviewRisks(
      [
        risk({ id: "low-soon", severity: "LOW", date: "2026-11-04" }),
        risk({ id: "crit-later", severity: "CRITICAL", date: "2026-11-08" }),
        risk({ id: "high-soon", severity: "HIGH", date: "2026-11-04", status: "ACKNOWLEDGED" }),
        risk({ id: "resolved", severity: "CRITICAL", date: "2026-11-04", status: "RESOLVED" }),
        risk({ id: "past", severity: "CRITICAL", date: "2026-11-01" }),
        risk({ id: "far", severity: "CRITICAL", date: "2026-12-30" }),
        risk({ id: "undated", severity: "MEDIUM" }),
      ],
      today,
      7,
    );
    expect(rv.top.map((r) => r.id)).toEqual(["crit-later", "high-soon", "undated", "low-soon"]);
    expect(rv.bySeverity).toEqual({ CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1 });
    expect(rv.unowned).toBe(3);
    expect(riskRecommendation(rv)).toMatch(/^4 active risks in the next 7 days \(1 critical, 1 high\)/);
  });

  it("says plainly when nothing is at risk, and never uses a dash as punctuation", () => {
    const rv = reviewRisks([], today);
    expect(riskRecommendation(rv)).toBe("No active risks for the next 7 days.");
    expect(riskRecommendation(reviewRisks([risk({ severity: "HIGH", recommendedAction: "Call the venue" })], today))).not.toMatch(/ [-–—] /);
  });

  it("runs as a real session with steps and a recommendation", () => {
    const s = runEventRiskReview({ actor: "test" });
    const kinds = listSessionEvents(s.id).map((e) => e.kind);
    expect(kinds).toContain("recommendation");
    expect(getSession(s.id)?.blade).toBe("event-risk");
  });
});

describe("Route Health Check", () => {
  const route = (p: Partial<Route>): Route => ({ routeId: "R", date: "2026-11-03", truckId: "T1", status: "active", stops: [], ...p }) as Route;
  const stop = (state: string) => ({ state }) as Route["stops"][number];

  it("summarizes today, overdue and exceptions, most urgent first", () => {
    const overdue: RouteHealthIssue[] = [
      { routeId: "a", truckId: "T1", truckLabel: "Box 1", date: "2026-11-01", driverName: null, daysOverdue: 2, totalStops: 3, incompleteStops: [{ sequence: 1, custName: "A", state: "Waiting", kind: "delivery" }] },
      { routeId: "b", truckId: "T2", truckLabel: "Box 2", date: "2026-10-30", driverName: null, daysOverdue: 4, totalStops: 2, incompleteStops: [] },
    ];
    const h = summarizeDispatch(
      [route({ driverName: "Sam", stops: [stop("Completed"), stop("EnRoute"), stop("Waiting")] }), route({ routeId: "R2", stops: [stop("Waiting")] })],
      overdue,
      [{ exceptionId: "e", stopId: null, type: "damage", reason: "torn linen", truckId: "T1", ts: "2026-11-03T12:00:00Z", resolved: false }],
    );
    expect(h.today).toEqual({ routes: 2, stops: 4, done: 1, moving: 1, waiting: 2, noDriver: 1 });
    expect(h.overdue[0].truck).toBe("Box 2");
    const rec = dispatchRecommendation(h);
    expect(rec).toContain("assign a driver to 1 route today");
    expect(rec).toContain("oldest: Box 2 on 2026-10-30");
    expect(rec).toContain("1 open driver exception");
  });

  it("is calm when nothing needs attention", () => {
    expect(dispatchRecommendation(summarizeDispatch([], [], []))).toBe("No routes today. Nothing needs attention right now.");
  });

  it("runs as a real session", () => {
    const s = runRouteHealthPlaybook({ actor: "test" });
    expect(listSessionEvents(s.id).some((e) => e.kind === "recommendation")).toBe(true);
    expect(getSession(s.id)?.agentId).toBe("dispatch-route");
  });
});

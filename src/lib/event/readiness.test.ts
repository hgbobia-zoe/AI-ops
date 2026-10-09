// computeEventReadiness tests — PURE. The independent readiness AXIS, rolled up from requirements +
// the EXISTING risk engine's findings (reused via computeReadiness). Verifies the condition precedence
// and that unverified risk findings never worsen the condition.

import { describe, it, expect } from "vitest";
import { computeEventReadiness } from "./readiness";
import type { Requirement } from "./types";
import type { RiskFinding, RiskSeverity, RiskCategory } from "@/lib/risk/types";

const EV = { eventId: "62232", date: "2026-07-04", label: "Test", routeId: "R-1" };

function req(over: Partial<Requirement> & Pick<Requirement, "id" | "blocking" | "status">): Requirement {
  return { label: over.id, source: "s", owner: "o", deadline: null, resolution: "", ...over };
}

function finding(severity: RiskSeverity, over: Partial<RiskFinding> = {}): RiskFinding {
  return {
    signature: `sig-${severity}-${over.riskType ?? "x"}`,
    riskType: over.riskType ?? "driver_shortage",
    category: (over.category ?? "STAFFING") as RiskCategory,
    severity,
    title: `${severity} finding`,
    description: "",
    date: EV.date,
    eventId: EV.eventId,
    routeId: EV.routeId,
    ...over,
  };
}

const okReqs = [req({ id: "route_exists", blocking: true, status: "OK" })];

describe("computeEventReadiness — condition", () => {
  it("clean: no findings, all OK -> NORMAL", () => {
    const r = computeEventReadiness(okReqs, [], { event: EV, daysUntilEvent: 20 });
    expect(r.condition).toBe("NORMAL");
    expect(r.blockers).toHaveLength(0);
    expect(r.riskLevel).toBe("READY");
  });

  it("CRITICAL finding + imminent -> ESCALATED", () => {
    const r = computeEventReadiness(okReqs, [finding("CRITICAL")], { event: EV, daysUntilEvent: 2 });
    expect(r.condition).toBe("ESCALATED");
  });

  it("CRITICAL finding but far out -> AT_RISK (not escalated)", () => {
    const r = computeEventReadiness(okReqs, [finding("CRITICAL")], { event: EV, daysUntilEvent: 30 });
    expect(r.condition).toBe("AT_RISK");
  });

  it("blocking requirement BLOCKED -> BLOCKED (and listed as a blocker)", () => {
    const reqs = [req({ id: "crew_sufficient", label: "Crew staffed", blocking: true, status: "BLOCKED" })];
    const r = computeEventReadiness(reqs, [], { event: EV, daysUntilEvent: 5 });
    expect(r.condition).toBe("BLOCKED");
    expect(r.blockers).toContain("Crew staffed");
  });

  it("ESCALATED outranks BLOCKED when both apply", () => {
    const reqs = [req({ id: "crew_sufficient", blocking: true, status: "BLOCKED" })];
    const r = computeEventReadiness(reqs, [finding("CRITICAL")], { event: EV, daysUntilEvent: 1 });
    expect(r.condition).toBe("ESCALATED");
  });

  it("HIGH finding -> AT_RISK", () => {
    expect(computeEventReadiness(okReqs, [finding("HIGH")], { event: EV, daysUntilEvent: 10 }).condition).toBe("AT_RISK");
  });

  it("blocking WARNING -> AT_RISK", () => {
    const reqs = [req({ id: "delivery_window", blocking: true, status: "WARNING" })];
    expect(computeEventReadiness(reqs, [], { event: EV, daysUntilEvent: 10 }).condition).toBe("AT_RISK");
  });

  it("MEDIUM finding -> WATCH; non-blocking WARNING -> WATCH", () => {
    expect(computeEventReadiness(okReqs, [finding("MEDIUM")], { event: EV, daysUntilEvent: 10 }).condition).toBe("WATCH");
    const reqs = [...okReqs, req({ id: "payment_deposit", blocking: false, status: "WARNING" })];
    expect(computeEventReadiness(reqs, [], { event: EV, daysUntilEvent: 10 }).condition).toBe("WATCH");
  });

  it("an UNVERIFIED risk finding never worsens the condition (reuses risk engine's unverified rule)", () => {
    const unv = finding("CRITICAL", { riskType: "staffing_unverified", unverified: true });
    const r = computeEventReadiness(okReqs, [unv], { event: EV, daysUntilEvent: 1 });
    expect(r.condition).toBe("NORMAL");
  });

  it("surfaces the reused risk score + level", () => {
    const r = computeEventReadiness(okReqs, [finding("HIGH")], { event: EV, daysUntilEvent: 10 });
    expect(typeof r.score).toBe("number");
    expect(r.riskLevel).toBe("HIGH");
  });

  it("a blocking UNVERIFIED requirement is NOT a blocker (unknown != deficiency)", () => {
    const reqs = [req({ id: "crew_sufficient", blocking: true, status: "UNVERIFIED" })];
    const r = computeEventReadiness(reqs, [], { event: EV, daysUntilEvent: 10 });
    expect(r.blockers).toHaveLength(0);
    expect(r.condition).toBe("NORMAL");
  });
});

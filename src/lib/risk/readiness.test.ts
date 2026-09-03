import { describe, it, expect } from "vitest";
import { computeReadiness } from "./readiness";
import type { RiskFinding } from "./types";

const ev = { eventId: "TX1", date: "2026-09-10", label: "Acme", routeId: "R1" };
const f = (over: Partial<RiskFinding>): RiskFinding => ({
  signature: "s",
  riskType: "x",
  category: "STAFFING",
  severity: "MEDIUM",
  title: "t",
  description: "d",
  date: "2026-09-10",
  routeId: "R1",
  ...over,
});

describe("readiness — unverified findings are unknowns, not deficiencies", () => {
  it("a clean event scores 100 and reads READY", () => {
    const [r] = computeReadiness([ev], []);
    expect(r.score).toBe(100);
    expect(r.riskLevel).toBe("READY");
  });

  it("an UNVERIFIED staffing finding does NOT dock the score or set a risk level", () => {
    const [r] = computeReadiness([ev], [f({ riskType: "staffing_unverified", unverified: true })]);
    expect(r.score).toBe(100); // no deduction for an unknown
    expect(r.riskLevel).toBe("READY"); // not surfaced as a risk level
    expect(r.components.staffing).toBe(25); // full weight retained
  });

  it("a REAL (verified) staffing MEDIUM finding still docks the score", () => {
    const [r] = computeReadiness([ev], [f({ riskType: "driver_shortage" })]);
    expect(r.score).toBeLessThan(100);
    expect(r.riskLevel).toBe("MEDIUM");
    expect(r.components.staffing).toBeLessThan(25);
  });
});

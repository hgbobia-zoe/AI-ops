import { describe, it, expect } from "vitest";
import { reconcileRisks, getRiskQueue, setRiskStatus } from "./store";
import type { RiskFinding, RiskSeverity } from "./types";

// DATABASE_PATH is ":memory:" in tests — a throwaway DB for this file.
const DATE = "2026-09-10";
const finding = (sig: string, severity: RiskSeverity, title = "Risk"): RiskFinding => ({
  signature: sig,
  riskType: "route_no_driver",
  category: "DRIVER",
  severity,
  title,
  description: "…",
  date: DATE,
  routeId: "R1",
});

describe("risk store — lifecycle (spec S10–S12)", () => {
  it("S10: re-running with the same problem does NOT duplicate", () => {
    const first = reconcileRisks([finding("sig1", "HIGH")], [DATE]);
    expect(first.created).toHaveLength(1);
    const again = reconcileRisks([finding("sig1", "HIGH")], [DATE]);
    expect(again.created).toHaveLength(0);
    expect(again.escalated).toHaveLength(0);
    expect(getRiskQueue().filter((r) => r.signature === "sig1")).toHaveLength(1);
  });

  it("S12: severity increase is reported as an escalation", () => {
    reconcileRisks([finding("sig2", "MEDIUM")], [DATE]);
    const up = reconcileRisks([finding("sig2", "CRITICAL")], [DATE]);
    expect(up.escalated).toHaveLength(1);
    expect(up.escalated[0].from).toBe("MEDIUM");
    expect(up.escalated[0].to).toBe("CRITICAL");
  });

  it("S11: a fixed risk resolves; if it returns it regresses", () => {
    reconcileRisks([finding("sig3", "HIGH")], [DATE]);
    const gone = reconcileRisks([], [DATE]);
    expect(gone.resolved.some((r) => r.signature === "sig3")).toBe(true);
    expect(getRiskQueue().some((r) => r.signature === "sig3")).toBe(false);
    const back = reconcileRisks([finding("sig3", "HIGH")], [DATE]);
    expect(back.regressed.some((r) => r.signature === "sig3")).toBe(true);
    expect(getRiskQueue().some((r) => r.signature === "sig3")).toBe(true);
  });

  it("a DISMISSED risk stays dismissed even if it's still detected", () => {
    reconcileRisks([finding("sig4", "HIGH")], [DATE]);
    const id = getRiskQueue().find((r) => r.signature === "sig4")!.id;
    setRiskStatus(id, "DISMISSED");
    const rescan = reconcileRisks([finding("sig4", "HIGH")], [DATE]);
    expect(rescan.created).toHaveLength(0);
    expect(rescan.regressed).toHaveLength(0);
    expect(getRiskQueue().some((r) => r.signature === "sig4")).toBe(false); // not resurfaced
  });

  it("a dismissed risk resurfaces if it genuinely worsens (severity escalates)", () => {
    reconcileRisks([finding("sig5", "MEDIUM")], [DATE]);
    const id = getRiskQueue().find((r) => r.signature === "sig5")!.id;
    setRiskStatus(id, "DISMISSED");
    const worse = reconcileRisks([finding("sig5", "CRITICAL")], [DATE]);
    expect(worse.regressed.some((r) => r.signature === "sig5")).toBe(true);
    expect(getRiskQueue().find((r) => r.signature === "sig5")?.severity).toBe("CRITICAL");
  });

  it("only resolves risks on the SCANNED dates (horizon-safe)", () => {
    reconcileRisks([{ ...finding("sigOther", "HIGH"), date: "2026-12-25" }], ["2026-12-25"]);
    // A scan of a different date must not resolve the Dec risk.
    const other = reconcileRisks([], [DATE]);
    expect(other.resolved.some((r) => r.signature === "sigOther")).toBe(false);
    expect(getRiskQueue().some((r) => r.signature === "sigOther")).toBe(true);
  });
});

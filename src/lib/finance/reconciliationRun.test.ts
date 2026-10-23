import { describe, it, expect } from "vitest";
import { projectSnapshot, type ProjectSnapshotInput, type CostFamilyInput } from "./projectSnapshot";
import { computeReconciliationRun, runSig, derivePhase, type RunPhase } from "./reconciliationRun";

// Build a ProjectSnapshot through the real pure builder so the run logic is tested against genuine snapshots.
function snap(over: Partial<ProjectSnapshotInput> = {}) {
  return projectSnapshot({
    projectId: "P1",
    label: "Test project",
    eventDate: "2026-06-01",
    revenue: { grandTotal: 5000, contractTotal: 5200, amountPaid: 1000, amountDue: 4000, signed: true },
    costFamilies: [],
    stale: false,
    ...over,
  });
}
const labor = (amount: number, status: CostFamilyInput["status"], method = "PLANNED"): CostFamilyInput => ({ type: "labor", amount, status, method, confidence: "MEDIUM", leafCount: 2, source: "connecteam" });
const fam = (type: CostFamilyInput["type"], amount: number, status: CostFamilyInput["status"], source: string): CostFamilyInput => ({ type, amount, status, source, leafCount: 1, method: source === "manual" ? "ACTUAL_STOP" : "ESTIMATED" });

function prior(s: ReturnType<typeof snap>, seq = 1, phase: RunPhase = "snapshot", capturedAt = "2026-06-01T00:00:00Z") {
  return { snapshot: s, seq, phase, capturedAt };
}

describe("computeReconciliationRun — lifecycle phase", () => {
  it("first-ever run of an unsettled project is a snapshot", () => {
    const r = computeReconciliationRun({ snapshot: snap({ costFamilies: [labor(1500, "ESTIMATED")] }), prior: null });
    expect(r.phase).toBe("snapshot");
    expect(r.changed).toBe(true);
    expect(r.variance.priorSeq).toBeNull();
    expect(r.variance.lines).toHaveLength(0);
  });

  it("a later run with deltas is a revision", () => {
    const p = snap({ costFamilies: [labor(1500, "ESTIMATED")] });
    const r = computeReconciliationRun({ snapshot: snap({ costFamilies: [labor(1800, "ESTIMATED")] }), prior: prior(p) });
    expect(r.phase).toBe("revision");
  });

  it("final ONLY when settled (all cost actual + fully collected + fresh); never final while estimated", () => {
    // Estimated labor + fully collected → still ESTIMATED, so NOT final.
    const estimated = snap({ revenue: { grandTotal: 5000, contractTotal: 5000, amountPaid: 5000, amountDue: 0, signed: true }, costFamilies: [labor(1500, "ESTIMATED")] });
    expect(estimated.status).toBe("ESTIMATED");
    expect(derivePhase(estimated, true)).toBe("revision");
    expect(derivePhase(estimated, false)).toBe("snapshot");

    // All-actual labor + fully collected + fresh → RECONCILED → final.
    const settled = snap({ revenue: { grandTotal: 5000, contractTotal: 5000, amountPaid: 5000, amountDue: 0, signed: true }, costFamilies: [labor(1500, "ACTUAL", "ACTUAL_STOP")] });
    expect(settled.status).toBe("RECONCILED");
    expect(derivePhase(settled, true)).toBe("final");
    expect(derivePhase(settled, false)).toBe("final"); // a first run of an already-settled project is final
  });
});

describe("computeReconciliationRun — variance-vs-prior reason tags", () => {
  it("a late timesheet (labor rises, still estimated) → late_timesheet", () => {
    const p = snap({ costFamilies: [labor(1000, "ESTIMATED")] });
    const r = computeReconciliationRun({ snapshot: snap({ costFamilies: [labor(1400, "ESTIMATED")] }), prior: prior(p) });
    const line = r.variance.lines.find((l) => l.line === "cost.labor")!;
    expect(line.reason).toBe("late_timesheet");
    expect(line.delta).toBe(400);
    expect(line.prior).toBe(1000);
    expect(line.current).toBe(1400);
  });

  it("labor going from estimate to actual → labor_actualized", () => {
    const p = snap({ costFamilies: [labor(1000, "ESTIMATED")] });
    const r = computeReconciliationRun({ snapshot: snap({ costFamilies: [labor(1000.5, "ACTUAL", "ACTUAL_STOP")] }), prior: prior(p) });
    const line = r.variance.lines.find((l) => l.line === "cost.labor")!;
    expect(line.reason).toBe("labor_actualized");
  });

  it("a refund (collected drops) → refund", () => {
    const p = snap({ revenue: { grandTotal: 5000, contractTotal: 5000, amountPaid: 2000, amountDue: 3000, signed: true }, costFamilies: [labor(1000, "ESTIMATED")] });
    const r = computeReconciliationRun({ snapshot: snap({ revenue: { grandTotal: 5000, contractTotal: 5000, amountPaid: 1500, amountDue: 3500, signed: true }, costFamilies: [labor(1000, "ESTIMATED")] }), prior: prior(p) });
    const line = r.variance.lines.find((l) => l.line === "revenue.collected")!;
    expect(line.reason).toBe("refund");
    expect(line.delta).toBe(-500);
  });

  it("a payment (collected rises) → payment_received; a bigger contract → revenue_adjustment", () => {
    const p = snap({ revenue: { grandTotal: 5000, contractTotal: 5000, amountPaid: 1000, amountDue: 4000, signed: true }, costFamilies: [labor(1000, "ESTIMATED")] });
    const r = computeReconciliationRun({ snapshot: snap({ revenue: { grandTotal: 6000, contractTotal: 6000, amountPaid: 2000, amountDue: 4000, signed: true }, costFamilies: [labor(1000, "ESTIMATED")] }), prior: prior(p) });
    expect(r.variance.lines.find((l) => l.line === "revenue.collected")!.reason).toBe("payment_received");
    expect(r.variance.lines.find((l) => l.line === "revenue.contracted")!.reason).toBe("revenue_adjustment");
  });

  it("a manual cost family appearing → manual_adjustment; a derived estimate → new_estimate", () => {
    const p = snap({ costFamilies: [labor(1000, "ESTIMATED")] });
    const r = computeReconciliationRun({
      snapshot: snap({ costFamilies: [labor(1000, "ESTIMATED"), fam("sub_rental", 300, "ACTUAL", "manual"), fam("fuel", 80, "ESTIMATED", "derived")] }),
      prior: prior(p),
    });
    expect(r.variance.lines.find((l) => l.line === "cost.sub_rental")!.reason).toBe("manual_adjustment");
    expect(r.variance.lines.find((l) => l.line === "cost.sub_rental")!.delta).toBe(300);
    expect(r.variance.lines.find((l) => l.line === "cost.fuel")!.reason).toBe("new_estimate");
  });

  it("a cost family that disappears → cost_removed (−prior)", () => {
    const p = snap({ costFamilies: [labor(1000, "ESTIMATED"), fam("sub_rental", 300, "ACTUAL", "manual")] });
    const r = computeReconciliationRun({ snapshot: snap({ costFamilies: [labor(1000, "ESTIMATED")] }), prior: prior(p) });
    const line = r.variance.lines.find((l) => l.line === "cost.sub_rental")!;
    expect(line.reason).toBe("cost_removed");
    expect(line.delta).toBe(-300);
    expect(line.current).toBeNull();
  });

  it("omits lines that did not move (no zero-delta noise)", () => {
    const p = snap({ costFamilies: [labor(1000, "ESTIMATED")] });
    const r = computeReconciliationRun({ snapshot: snap({ costFamilies: [labor(1000, "ESTIMATED")] }), prior: prior(p) });
    expect(r.variance.lines).toHaveLength(0);
  });
});

describe("computeReconciliationRun — idempotency + the reconciliation tie", () => {
  it("an identical snapshot yields the same sig and changed=false (no new run)", () => {
    const base = snap({ costFamilies: [labor(1000, "ESTIMATED")] });
    const again = snap({ costFamilies: [labor(1000, "ESTIMATED")] });
    expect(runSig(base)).toBe(runSig(again));
    const r = computeReconciliationRun({ snapshot: again, prior: prior(base) });
    expect(r.changed).toBe(false);
  });

  it("a family moving (even at an unchanged direct-cost total) is still a revision via the sig", () => {
    // Direct cost total identical (1000) but composition changed → sig differs → changed.
    const p = snap({ costFamilies: [labor(600, "ESTIMATED"), fam("fuel", 400, "ESTIMATED", "derived")] });
    const c = snap({ costFamilies: [labor(400, "ESTIMATED"), fam("fuel", 600, "ESTIMATED", "derived")] });
    expect(runSig(p)).not.toBe(runSig(c));
    expect(computeReconciliationRun({ snapshot: c, prior: prior(p) }).changed).toBe(true);
  });

  it("the run's recorded figures tie: direct cost equals the sum of the cost families (balanced)", () => {
    const s = snap({ costFamilies: [labor(1000, "ESTIMATED"), fam("sub_rental", 300, "ACTUAL", "manual"), fam("fuel", 80, "ESTIMATED", "derived")] });
    const r = computeReconciliationRun({ snapshot: s, prior: null });
    expect(r.figures.directCost).toBe(1380);
    expect(r.figures.balanced).toBe(true);
    expect(r.figures.residual).toBe(0);
  });
});

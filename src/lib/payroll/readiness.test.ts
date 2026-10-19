import { describe, it, expect } from "vitest";
import { classifyReadiness, classifyReadinessWorker, type ReadinessFacts, type ReadinessContext } from "./readiness";
import type { PayPeriod } from "./types";

const period: PayPeriod = { start: "2026-10-05", end: "2026-10-11", label: "Oct 5 – Oct 11" };

function facts(p: Partial<ReadinessFacts>): ReadinessFacts {
  return {
    key: p.key ?? "ct:1",
    name: p.name ?? "Worker",
    connecteamUserId: p.connecteamUserId ?? 1,
    active: p.active ?? true,
    gustoId: p.gustoId ?? (p.gustoMapped ? "g1" : null),
    gustoMapped: p.gustoMapped ?? false,
    payRate: p.payRate ?? null,
    actualHours: p.actualHours ?? null,
    approvedHours: p.approvedHours ?? null,
    unapprovedHours: p.unapprovedHours ?? null,
    approvalKnownForWorker: p.approvalKnownForWorker ?? false,
    openPunch: p.openPunch ?? false,
    plannedHours: p.plannedHours ?? null,
  };
}

function ctx(p: Partial<ReadinessContext>): ReadinessContext {
  return {
    period,
    connecteamOk: p.connecteamOk ?? true,
    approvalFieldSeen: p.approvalFieldSeen ?? true,
    plannedOk: p.plannedOk ?? true,
    gusto: p.gusto ?? { configured: false, fresh: false },
    opts: p.opts ?? { overtimeThreshold: 40, scheduleDiscrepancyPct: 25 },
  };
}

// A fully-clean worker: mapped, rated, all hours approved, no anomalies.
const clean = () => facts({ gustoMapped: true, payRate: 20, actualHours: 30, approvedHours: 30, unapprovedHours: 0, approvalKnownForWorker: true, plannedHours: 30 });

describe("classifyReadiness — overall status", () => {
  it("UNAVAILABLE when the time source is down (never READY on missing data, §4)", () => {
    const r = classifyReadiness([clean()], ctx({ connecteamOk: false }));
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.hours).toBeNull();
    expect(r.workers).toHaveLength(0);
    expect(r.exceptions.some((e) => e.type === "SOURCE_UNAVAILABLE")).toBe(true);
  });

  it("READY only when every paid worker is clean and approvals are confirmed", () => {
    const r = classifyReadiness([clean()], ctx({}));
    expect(r.status).toBe("READY");
    expect(r.counts).toMatchObject({ workers: 1, ready: 1, blocked: 0, actionRequired: 0 });
    expect(r.exceptions).toHaveLength(0);
    expect(r.approvedHours).toBe(30);
  });

  it("BLOCKED on unapproved timesheet hours", () => {
    const r = classifyReadiness(
      [facts({ gustoMapped: true, payRate: 20, actualHours: 30, approvedHours: 20, unapprovedHours: 10, approvalKnownForWorker: true })],
      ctx({}),
    );
    expect(r.status).toBe("BLOCKED");
    expect(r.exceptions.some((e) => e.type === "UNAPPROVED_TIMESHEET" && e.kind === "BLOCKING")).toBe(true);
  });

  it("ACTION_REQUIRED (never READY) when approval is UNVERIFIED for the endpoint", () => {
    const r = classifyReadiness(
      [facts({ gustoMapped: true, payRate: 20, actualHours: 30, approvalKnownForWorker: false })],
      ctx({ approvalFieldSeen: false }),
    );
    expect(r.status).toBe("ACTION_REQUIRED");
    expect(r.approvalKnown).toBe(false);
    expect(r.exceptions.some((e) => e.type === "APPROVAL_UNVERIFIED" && e.kind === "UNVERIFIED")).toBe(true);
  });

  it("BLOCKED on missing Gusto mapping", () => {
    const r = classifyReadiness([facts({ gustoMapped: false, payRate: 20, actualHours: 10, approvedHours: 10, unapprovedHours: 0, approvalKnownForWorker: true })], ctx({}));
    expect(r.status).toBe("BLOCKED");
    expect(r.exceptions.some((e) => e.type === "MISSING_GUSTO_MAPPING")).toBe(true);
  });

  it("BLOCKED when hours exist but no pay rate", () => {
    const r = classifyReadiness([facts({ gustoMapped: true, payRate: null, actualHours: 10, approvedHours: 10, unapprovedHours: 0, approvalKnownForWorker: true })], ctx({}));
    expect(r.status).toBe("BLOCKED");
    expect(r.exceptions.some((e) => e.type === "NO_PAY_RATE")).toBe(true);
  });
});

describe("classifyReadiness — anomalies", () => {
  it("ACTION_REQUIRED on an open punch", () => {
    const w = facts({ gustoMapped: true, payRate: 20, actualHours: 10, approvedHours: 10, unapprovedHours: 0, approvalKnownForWorker: true, openPunch: true });
    const r = classifyReadiness([w], ctx({}));
    expect(r.status).toBe("ACTION_REQUIRED");
    expect(r.exceptions.some((e) => e.type === "MISSING_PUNCH")).toBe(true);
  });

  it("flags a material schedule discrepancy (actual vs planned)", () => {
    const w = facts({ gustoMapped: true, payRate: 20, actualHours: 40, approvedHours: 40, unapprovedHours: 0, approvalKnownForWorker: true, plannedHours: 20 });
    const r = classifyReadiness([w], ctx({}));
    expect(r.exceptions.some((e) => e.type === "SCHEDULE_DISCREPANCY")).toBe(true);
  });

  it("does NOT flag a discrepancy within the threshold", () => {
    const w = facts({ gustoMapped: true, payRate: 20, actualHours: 22, approvedHours: 22, unapprovedHours: 0, approvalKnownForWorker: true, plannedHours: 20 });
    const r = classifyReadiness([w], ctx({}));
    expect(r.exceptions.some((e) => e.type === "SCHEDULE_DISCREPANCY")).toBe(false);
    expect(r.status).toBe("READY");
  });

  it("flags overtime above the threshold", () => {
    const w = facts({ gustoMapped: true, payRate: 20, actualHours: 52, approvedHours: 52, unapprovedHours: 0, approvalKnownForWorker: true, plannedHours: 50 });
    const r = classifyReadiness([w], ctx({}));
    expect(r.exceptions.some((e) => e.type === "OVERTIME")).toBe(true);
  });
});

describe("classifyReadiness — period level", () => {
  it("BLOCKED on a duplicate Gusto mapping (two workers → one member)", () => {
    const a = facts({ key: "ct:1", name: "A", connecteamUserId: 1, gustoId: "gX", gustoMapped: true, payRate: 20, actualHours: 10, approvedHours: 10, unapprovedHours: 0, approvalKnownForWorker: true });
    const b = facts({ key: "ct:2", name: "B", connecteamUserId: 2, gustoId: "gX", gustoMapped: true, payRate: 20, actualHours: 10, approvedHours: 10, unapprovedHours: 0, approvalKnownForWorker: true });
    const r = classifyReadiness([a, b], ctx({}));
    expect(r.status).toBe("BLOCKED");
    expect(r.exceptions.some((e) => e.type === "DUPLICATE_GUSTO_MAPPING")).toBe(true);
  });

  it("ACTION_REQUIRED (unverified) when Gusto is configured but the snapshot is stale", () => {
    const r = classifyReadiness([clean()], ctx({ gusto: { configured: true, fresh: false } }));
    expect(r.status).toBe("ACTION_REQUIRED");
    expect(r.exceptions.some((e) => e.type === "GUSTO_STALE" && e.kind === "UNVERIFIED")).toBe(true);
  });

  it("stays READY when Gusto is configured AND fresh", () => {
    const r = classifyReadiness([clean()], ctx({ gusto: { configured: true, fresh: true } }));
    expect(r.status).toBe("READY");
  });

  it("excludes zero-hour workers from the payroll run", () => {
    const zero = facts({ gustoMapped: true, payRate: 20, actualHours: 0, approvalKnownForWorker: true });
    const r = classifyReadiness([zero], ctx({}));
    expect(r.counts.workers).toBe(0);
    expect(r.status).toBe("READY");
  });
});

describe("exception detect keys are stable + idempotent", () => {
  it("uses the RDY:<start>:<end>:<workerKey>:<TYPE> scheme", () => {
    const w = classifyReadinessWorker(facts({ key: "ct:5", gustoMapped: false, actualHours: 10 }), ctx({}));
    const exc = w.issues.find((i) => i.type === "MISSING_GUSTO_MAPPING")!;
    expect(exc.detectKey).toBe("RDY:2026-10-05:2026-10-11:ct:5:MISSING_GUSTO_MAPPING");
    // Re-running the same facts yields the identical key (idempotent upsert target).
    const again = classifyReadinessWorker(facts({ key: "ct:5", gustoMapped: false, actualHours: 10 }), ctx({}));
    expect(again.issues.find((i) => i.type === "MISSING_GUSTO_MAPPING")!.detectKey).toBe(exc.detectKey);
  });
});

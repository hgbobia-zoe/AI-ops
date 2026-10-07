import { describe, it, expect } from "vitest";
import { classifyWorker, classifyReview, DEFAULT_REVIEW_OPTIONS } from "./review";
import type { UnifiedWorker, WorkerType } from "./types";

function w(p: Partial<UnifiedWorker>): UnifiedWorker {
  return {
    key: p.key ?? Math.random().toString(), recordId: null, name: p.name ?? "X", email: null,
    workerType: (p.workerType ?? "EMPLOYEE") as WorkerType, typeInferred: p.typeInferred ?? false,
    country: p.country ?? null, connecteamUserId: 1, instaworkWorker: null, inConnecteam: true,
    gustoId: p.gustoMapped ? "g1" : null, gustoMapped: p.gustoMapped ?? false, payType: "hourly",
    payRate: p.payRate ?? null, currency: p.currency ?? "USD", active: p.active ?? true, persisted: true,
    periodHours: p.periodHours ?? null, mappingStatus: p.gustoMapped ? "MATCHED" : "UNMATCHED",
  };
}
const period = { start: "2026-10-05", end: "2026-10-11", label: "Oct 5 – Oct 11" };

describe("classifyWorker", () => {
  it("READY when mapped, rated, and no anomalies", () => {
    const r = classifyWorker(w({ gustoMapped: true, payRate: 8, periodHours: 25.33 }), DEFAULT_REVIEW_OPTIONS);
    expect(r.status).toBe("READY");
    expect(r.estPay).toBe(202.64); // 25.33 × 8
    expect(r.issues).toHaveLength(0);
  });
  it("BLOCKED when not mapped to Gusto", () => {
    const r = classifyWorker(w({ gustoMapped: false, payRate: 20, periodHours: 20.41 }), DEFAULT_REVIEW_OPTIONS);
    expect(r.status).toBe("BLOCKED");
    expect(r.issues.some((i) => i.kind === "BLOCKING" && i.code === "NO_GUSTO_MAPPING")).toBe(true);
  });
  it("BLOCKED when rate is missing and hours worked", () => {
    const r = classifyWorker(w({ gustoMapped: true, payRate: null, periodHours: 21 }), DEFAULT_REVIEW_OPTIONS);
    expect(r.status).toBe("BLOCKED");
    expect(r.estPay).toBeNull();
    expect(r.issues.some((i) => i.code === "NO_PAY_RATE")).toBe(true);
  });
  it("REQUIRES_REVIEW on overtime (exception), not blocked", () => {
    const r = classifyWorker(w({ gustoMapped: true, payRate: 20, periodHours: 52 }), DEFAULT_REVIEW_OPTIONS);
    expect(r.status).toBe("REQUIRES_REVIEW");
    expect(r.issues.some((i) => i.kind === "EXCEPTION" && i.code === "OVERTIME")).toBe(true);
  });
  it("REQUIRES_REVIEW on missing config (inferred type)", () => {
    const r = classifyWorker(w({ gustoMapped: true, payRate: 20, periodHours: 10, typeInferred: true }), DEFAULT_REVIEW_OPTIONS);
    expect(r.status).toBe("REQUIRES_REVIEW");
    expect(r.issues.some((i) => i.kind === "MISSING_CONFIG" && i.code === "TYPE_UNCONFIRMED")).toBe(true);
  });
  it("blocking beats review (a blocked worker is never merely review)", () => {
    const r = classifyWorker(w({ gustoMapped: false, payRate: 20, periodHours: 52 }), DEFAULT_REVIEW_OPTIONS);
    expect(r.status).toBe("BLOCKED");
  });
});

describe("classifyReview", () => {
  it("rolls up counts, distinguishes blockers/exceptions/config, and sums only ready pay", () => {
    const workers = [
      w({ key: "a", gustoMapped: true, payRate: 8, periodHours: 25 }), // READY 200
      w({ key: "b", gustoMapped: true, payRate: 10, periodHours: 10 }), // READY 100
      w({ key: "c", gustoMapped: false, payRate: 20, periodHours: 20 }), // BLOCKED (no mapping) est 400
      w({ key: "d", gustoMapped: true, payRate: 20, periodHours: 52 }), // REVIEW (overtime)
      w({ key: "e", gustoMapped: true, payRate: 15, periodHours: 0 }), // 0 hours → excluded
    ];
    const r = classifyReview(period, workers, true);
    expect(r.counts).toEqual({ workers: 4, ready: 2, review: 1, blocked: 1 });
    expect(r.estReadyPayroll).toBe(300);
    expect(r.estBlockedPayroll).toBe(400);
    expect(r.blockingIssues).toBe(1);
    expect(r.exceptions).toBe(1);
    expect(r.status).toBe("BLOCKED"); // any blocked → BLOCKED overall
    expect(r.hours).toBe(107); // 25+10+20+52
  });
  it("NO_DATA + null hours when the time source is unavailable", () => {
    const r = classifyReview(period, [w({ gustoMapped: true, payRate: 8, periodHours: null })], false);
    expect(r.status).toBe("NO_DATA");
    expect(r.hours).toBeNull();
  });
  it("READY overall only when every paid worker is ready", () => {
    const r = classifyReview(period, [w({ gustoMapped: true, payRate: 8, periodHours: 25 })], true);
    expect(r.status).toBe("READY");
  });
});

import { describe, it, expect } from "vitest";
import { resolveRate } from "./workers";
import type { GustoSnapshotMember } from "./gustoSnapshot";
import type { WorkerRecord } from "./types";

function rec(p: Partial<WorkerRecord>): WorkerRecord {
  return {
    id: "HW-1", name: "X", email: null, workerType: "EMPLOYEE", employmentStatus: "ACTIVE",
    connecteamUserId: 1, instaworkWorker: null, gustoId: "g1", gustoEntityType: "employee",
    payType: "hourly", payRate: null, currency: null, country: null, active: true,
    excluded: false, excludeReason: null, notes: null, createdAt: "", updatedAt: "", ...p,
  };
}
function gm(p: Partial<GustoSnapshotMember>): GustoSnapshotMember {
  return {
    id: "g1", firstName: "X", lastName: "Y", preferredName: null, businessName: null,
    personType: "employee", department: null, jobTitle: null, country: null, employmentEntityUuid: null,
    payRate: null, payCurrency: null, payUnit: null, ...p,
  };
}

describe("resolveRate — Gusto is authoritative", () => {
  it("prefers the Gusto HOURLY rate over an override and over Connecteam", () => {
    const r = resolveRate(rec({ payRate: 18 }), gm({ payRate: 22, payUnit: "Hour", payCurrency: "USD" }), 15, false);
    expect(r.payRate).toBe(22);
    expect(r.rateSource).toBe("gusto");
    expect(r.connecteamRate).toBe(15); // still surfaced for the diagnostic
    expect(r.gustoRate).toBe(22);
  });

  it("falls back to the manual override when Gusto has no hourly rate", () => {
    const r = resolveRate(rec({ payRate: 18 }), null, 15, false);
    expect(r.payRate).toBe(18);
    expect(r.rateSource).toBe("override");
  });

  it("falls back to the Connecteam rate when no Gusto rate and no override", () => {
    const r = resolveRate(rec({ payRate: null }), null, 15, false);
    expect(r.payRate).toBe(15);
    expect(r.rateSource).toBe("connecteam");
  });

  it("is unknown (null) when no source has a rate", () => {
    const r = resolveRate(rec({ payRate: null }), gm({ payRate: null }), null, false);
    expect(r.payRate).toBeNull();
    expect(r.rateSource).toBeNull();
  });

  it("does NOT fabricate an hourly rate from a Gusto SALARY by default", () => {
    const r = resolveRate(rec({ payRate: null }), gm({ payRate: 60000, payUnit: "Year", payCurrency: "USD" }), null, false);
    expect(r.payRate).toBeNull(); // salary is not an hourly rate
    expect(r.rateSource).toBeNull();
    expect(r.gustoRate).toBe(60000); // surfaced for the UI ("salaried in Gusto")
    expect(r.gustoRateUnit).toBe("Year");
  });

  it("converts a Gusto annual salary to hourly ONLY when salaryToHourly is enabled", () => {
    const r = resolveRate(rec({ payRate: null }), gm({ payRate: 62400, payUnit: "Year" }), null, true);
    expect(r.payRate).toBe(30); // 62400 / 2080
    expect(r.rateSource).toBe("gusto");
  });

  it("takes currency from Gusto when the rate is Gusto-sourced and the record has none", () => {
    const r = resolveRate(rec({ currency: null }), gm({ payRate: 20, payUnit: "Hour", payCurrency: "EUR" }), null, false);
    expect(r.currency).toBe("EUR");
  });
});

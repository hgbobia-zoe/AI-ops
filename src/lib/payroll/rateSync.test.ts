import { describe, it, expect } from "vitest";
import { computeRateSyncProposals } from "./rateSync";
import type { GustoSnapshotMember } from "./gustoSnapshot";
import type { WorkerRecord } from "./types";

function rec(p: Partial<WorkerRecord>): WorkerRecord {
  return {
    id: `HW-${p.connecteamUserId ?? 1}`, name: p.name ?? "X", email: null, workerType: "EMPLOYEE",
    employmentStatus: "ACTIVE", connecteamUserId: p.connecteamUserId ?? 1, instaworkWorker: null,
    gustoId: p.gustoId ?? "g1", gustoEntityType: "employee", payType: "hourly", payRate: null,
    currency: null, country: null, active: p.active ?? true, excluded: p.excluded ?? false,
    excludeReason: null, notes: null, createdAt: "", updatedAt: "", ...p,
  };
}
function gm(id: string, payRate: number | null, payUnit: string | null): GustoSnapshotMember {
  return {
    id, firstName: "X", lastName: "Y", preferredName: null, businessName: null, personType: "employee",
    department: null, jobTitle: null, country: null, employmentEntityUuid: null,
    payRate, payCurrency: "USD", payUnit,
  };
}
function ctRates(entries: { userId: number; rate: number }[]): Map<number, { hourlyRate: number; effectiveDate: string; userId: number }[]> {
  const m = new Map<number, { hourlyRate: number; effectiveDate: string; userId: number }[]>();
  for (const e of entries) m.set(e.userId, [{ userId: e.userId, hourlyRate: e.rate, effectiveDate: "2026-01-01" }]);
  return m;
}
const EFF = "2026-10-31";

describe("computeRateSyncProposals", () => {
  it("proposes an UPDATE when the Gusto hourly rate differs from Connecteam", () => {
    const plan = computeRateSyncProposals(
      [rec({ connecteamUserId: 1, gustoId: "g1" })],
      new Map([["g1", gm("g1", 25, "Hour")]]),
      ctRates([{ userId: 1, rate: 20 }]),
      EFF,
    );
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]).toMatchObject({ connecteamUserId: 1, gustoRate: 25, connecteamRate: 20, kind: "update", effectiveDate: EFF });
  });

  it("proposes a NEW write when Connecteam has no rate", () => {
    const plan = computeRateSyncProposals(
      [rec({ connecteamUserId: 2, gustoId: "g2" })],
      new Map([["g2", gm("g2", 18, "Hour")]]),
      ctRates([]),
      EFF,
    );
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]).toMatchObject({ connecteamRate: null, kind: "new" });
  });

  it("SKIPS when the rates already match (idempotent — within half a cent)", () => {
    const plan = computeRateSyncProposals(
      [rec({ connecteamUserId: 3, gustoId: "g3" })],
      new Map([["g3", gm("g3", 20, "Hour")]]),
      ctRates([{ userId: 3, rate: 20.004 }]),
      EFF,
    );
    expect(plan.proposals).toHaveLength(0);
  });

  it("does NOT propose for a salaried (non-hourly) Gusto comp, and counts it", () => {
    const plan = computeRateSyncProposals(
      [rec({ connecteamUserId: 4, gustoId: "g4" })],
      new Map([["g4", gm("g4", 60000, "Year")]]),
      ctRates([]),
      EFF,
    );
    expect(plan.proposals).toHaveLength(0);
    expect(plan.salaried).toBe(1);
  });

  it("counts mapped workers with no Gusto rate in the snapshot", () => {
    const plan = computeRateSyncProposals(
      [rec({ connecteamUserId: 5, gustoId: "g5" })],
      new Map([["g5", gm("g5", null, null)]]),
      ctRates([]),
      EFF,
    );
    expect(plan.proposals).toHaveLength(0);
    expect(plan.noGustoRate).toBe(1);
  });

  it("ignores unmapped, inactive, and excluded workers", () => {
    const plan = computeRateSyncProposals(
      [
        rec({ connecteamUserId: 6, gustoId: null }), // no Gusto mapping
        rec({ connecteamUserId: 7, gustoId: "g7", active: false }), // inactive
        rec({ connecteamUserId: 8, gustoId: "g8", excluded: true }), // excluded from payroll
      ],
      new Map([["g7", gm("g7", 30, "Hour")], ["g8", gm("g8", 30, "Hour")]]),
      ctRates([]),
      EFF,
    );
    expect(plan.proposals).toHaveLength(0);
  });
});

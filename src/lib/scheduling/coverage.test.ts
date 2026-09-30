import { describe, it, expect } from "vitest";
import { computeCoverage } from "./coverage";
import type { StaffShift } from "./types";
import type { CrewMember } from "@/lib/connecteam";

function shift(p: Partial<StaffShift> & { id: string; role: StaffShift["role"] }): StaffShift {
  return {
    date: "2026-09-30",
    headcount: 1,
    startTime: null,
    endTime: null,
    windowKnown: false,
    location: null,
    routeId: null,
    truckId: null,
    eventLabel: null,
    reasons: [],
    notes: null,
    source: "derived",
    status: "draft",
    assignees: [],
    instaworkHeadcount: 0,
    payRate: null,
    connecteamShiftId: null,
    connecteamSchedulerId: null,
    connecteamPublishedAt: null,
    instaworkGigId: null,
    instaworkPostedAt: null,
    createdAt: "",
    updatedAt: "",
    ...p,
  };
}
const crew = (userId: number, name: string, role: CrewMember["role"]): CrewMember => ({ userId, name, role });

describe("computeCoverage", () => {
  it("credits a scheduled driver against a driver shift → no gap", () => {
    const cov = computeCoverage([shift({ id: "d1", role: "driver" })], [crew(1, "Michael", "driver")]);
    expect(cov.byShift.d1.covered).toBe(1);
    expect(cov.byShift.d1.gap).toBe(0);
    expect(cov.byShift.d1.scheduledNames).toEqual(["Michael"]);
    expect(cov.gapTotal).toBe(0);
    expect(cov.internalTotal).toBe(1);
  });

  it("one scheduled driver across two driver shifts covers one, leaves the other a gap", () => {
    const cov = computeCoverage(
      [shift({ id: "d1", role: "driver" }), shift({ id: "d2", role: "driver" })],
      [crew(1, "Michael", "driver")],
    );
    expect(cov.byShift.d1.gap).toBe(0);
    expect(cov.byShift.d2.gap).toBe(1);
    expect(cov.gapTotal).toBe(1); // 2 needed − 1 scheduled
  });

  it("does not double-count a scheduled person already explicitly assigned", () => {
    const cov = computeCoverage(
      [shift({ id: "d1", role: "driver", assignees: [1] }), shift({ id: "d2", role: "driver" })],
      [crew(1, "Michael", "driver")], // Michael is BOTH explicitly assigned to d1 AND scheduled
    );
    expect(cov.byShift.d1.covered).toBe(1); // his explicit assignment
    expect(cov.byShift.d1.scheduledCredit).toBe(0); // not credited again
    expect(cov.byShift.d2.gap).toBe(1); // he can't cover d2 too
    expect(cov.gapTotal).toBe(1);
  });

  it("maps field demand to Connecteam 'other' crew", () => {
    const cov = computeCoverage([shift({ id: "f1", role: "field" })], [crew(9, "Temp Lead", "other")]);
    expect(cov.byShift.f1.gap).toBe(0);
    expect(cov.byShift.f1.scheduledNames).toEqual(["Temp Lead"]);
  });

  it("credits multiple scheduled prep against a multi-headcount prep shift", () => {
    const cov = computeCoverage(
      [shift({ id: "p1", role: "prep", headcount: 3 })],
      [crew(2, "A", "prep"), crew(3, "B", "prep")],
    );
    expect(cov.byShift.p1.covered).toBe(2);
    expect(cov.byShift.p1.gap).toBe(1); // 3 needed − 2 scheduled
  });

  it("a scheduled driver does not cover a prep shift (role-scoped)", () => {
    const cov = computeCoverage([shift({ id: "p1", role: "prep" })], [crew(1, "Michael", "driver")]);
    expect(cov.byShift.p1.gap).toBe(1);
    expect(cov.byShift.p1.scheduledCredit).toBe(0);
  });
});

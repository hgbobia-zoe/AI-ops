import { describe, it, expect } from "vitest";
import { scanShiftExceptions } from "./exceptions";
import type { DayCoverage, ShiftCoverage } from "./coverage";
import type { StaffShift, ShiftRole, ShiftAssignment } from "./types";
import type { UnavailabilityBlock } from "@/lib/connecteam";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const FAR = "2026-10-20T14:00:00Z"; // > 1 day out
const SOON = "2026-10-01T12:00:00Z"; // same day (< 1 day out)

function shift(p: Partial<StaffShift> & { id: string; role: ShiftRole }): StaffShift {
  return {
    date: "2026-10-20",
    headcount: 1,
    startTime: null,
    endTime: null,
    windowKnown: true,
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
    lifecycleState: null,
    supervisorUserId: null,
    reportLocation: null,
    reportTime: null,
    equipment: [],
    instructions: null,
    createdAt: "",
    updatedAt: "",
    ...p,
  };
}

function cov(byShift: Record<string, number>): DayCoverage {
  const full: Record<string, ShiftCoverage> = {};
  let gapTotal = 0;
  for (const [id, gap] of Object.entries(byShift)) {
    full[id] = { headcount: 1, assigned: 0, scheduledCredit: 0, scheduledNames: [], scheduledUserIds: [], covered: 0, gap };
    gapTotal += gap;
  }
  return { byShift: full, internalTotal: 0, gapTotal };
}

describe("scanShiftExceptions", () => {
  it("flags an understaffed shift YELLOW far out, RED within T-1d", () => {
    const far = scanShiftExceptions({ shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: "T1", startTime: FAR, endTime: FAR })], coverage: cov({ a: 1 }), now: NOW });
    expect(far.find((e) => e.code === "understaffed")!.severity).toBe("YELLOW");

    const near = scanShiftExceptions({ shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: "T1", startTime: SOON, endTime: SOON })], coverage: cov({ a: 1 }), now: NOW });
    expect(near.find((e) => e.code === "understaffed")!.severity).toBe("RED");
  });

  it("does NOT flag understaffed when staffing is unverified (UNKNOWN, not fabricated)", () => {
    const out = scanShiftExceptions({ shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: "T1", startTime: FAR, endTime: FAR })], coverage: cov({ a: 1 }), now: NOW, staffingVerified: false });
    expect(out.find((e) => e.code === "understaffed")).toBeUndefined();
  });

  it("flags a route shift with no truck RED", () => {
    const out = scanShiftExceptions({ shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: null, startTime: FAR, endTime: FAR })], coverage: cov({ a: 0 }), now: NOW });
    const e = out.find((x) => x.code === "no_truck")!;
    expect(e.severity).toBe("RED");
  });

  it("flags an unknown window YELLOW", () => {
    const out = scanShiftExceptions({ shifts: [shift({ id: "a", role: "prep", windowKnown: false })], coverage: cov({ a: 0 }), now: NOW });
    expect(out.find((e) => e.code === "no_window")!.severity).toBe("YELLOW");
  });

  it("flags staffed-but-not-published and a missing supervisor", () => {
    const out = scanShiftExceptions({
      shifts: [shift({ id: "a", role: "field", routeId: "a", truckId: "T1", headcount: 2, assignees: [1, 2], startTime: FAR, endTime: FAR })],
      coverage: cov({ a: 0 }),
      now: NOW,
    });
    expect(out.find((e) => e.code === "not_published")).toBeTruthy();
    expect(out.find((e) => e.code === "supervisor_missing")).toBeTruthy();
  });

  it("sorts RED before YELLOW", () => {
    const out = scanShiftExceptions({
      shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: null, windowKnown: false })],
      coverage: cov({ a: 0 }),
      now: NOW,
    });
    expect(out[0].severity).toBe("RED"); // no_truck
    expect(out.map((e) => e.severity)).toEqual([...out.map((e) => e.severity)].sort());
  });

  it("skips cancelled shifts", () => {
    const out = scanShiftExceptions({ shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: null, status: "cancelled" })], coverage: cov({ a: 1 }), now: NOW });
    expect(out).toHaveLength(0);
  });

  // ── Case-C reconciliation: an assigned worker who has since marked themselves off ──────────────────
  const toUnix = (iso: string): number => Date.parse(iso) / 1000;
  const block = (userId: number, sIso: string, eIso: string, kind: UnavailabilityBlock["kind"] = "unavailability", reason?: string): UnavailabilityBlock => ({
    userId,
    kind,
    startUnix: toUnix(sIso),
    endUnix: toUnix(eIso),
    reason,
  });
  function asg(p: Partial<ShiftAssignment> & { connecteamUserId: number }): ShiftAssignment {
    return {
      id: `as-${p.connecteamUserId}`,
      shiftId: "a",
      workerKind: "internal",
      connecteamUserId: p.connecteamUserId,
      instaworkWorker: null,
      instaworkGigId: null,
      displayName: `W${p.connecteamUserId}`,
      role: "driver",
      state: "ASSIGNED",
      packetVersion: null,
      packetSentAt: null,
      confirmedAt: null,
      confirmMethod: null,
      clockInAt: null,
      clockOutAt: null,
      clockSource: null,
      noShow: false,
      tempReason: null,
      routeReason: null,
      estHours: null,
      estRate: null,
      estCost: null,
      overridden: false,
      overrideReason: null,
      createdAt: "",
      updatedAt: "",
      ...p,
    };
  }
  // A route shift 10:00–14:00 on 2026-10-20 with worker #1 assigned.
  const assignedShift = () => shift({ id: "a", role: "driver", routeId: "a", truckId: "T1", startTime: "2026-10-20T10:00:00Z", endTime: "2026-10-20T14:00:00Z" });
  const withWorker1 = new Map([["a", [asg({ connecteamUserId: 1 })]]]);

  it("flags assignee_unavailable when a live internal assignee is marked off over the window", () => {
    const out = scanShiftExceptions({
      shifts: [assignedShift()],
      coverage: cov({ a: 0 }),
      now: NOW,
      assignmentsByShift: withWorker1,
      unavailabilityByUser: new Map([[1, [block(1, "2026-10-20T09:00:00Z", "2026-10-20T15:00:00Z", "timeOff", "PTO")]]]),
      availabilityVerified: true,
    });
    const e = out.find((x) => x.code === "assignee_unavailable")!;
    expect(e).toBeTruthy();
    expect(e.detail).toContain("time off");
    expect(e.detail).toContain("PTO");
    expect(e.severity).toBe("YELLOW"); // > 1 day out
  });

  it("escalates assignee_unavailable to RED within T-1d", () => {
    const out = scanShiftExceptions({
      shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: "T1", startTime: "2026-10-01T12:00:00Z", endTime: "2026-10-01T16:00:00Z" })],
      coverage: cov({ a: 0 }),
      now: NOW,
      assignmentsByShift: withWorker1,
      unavailabilityByUser: new Map([[1, [block(1, "2026-10-01T09:00:00Z", "2026-10-01T15:00:00Z")]]]),
      availabilityVerified: true,
    });
    expect(out.find((x) => x.code === "assignee_unavailable")!.severity).toBe("RED");
  });

  it("does NOT flag assignee_unavailable when the feed is unverified (UNKNOWN, never fabricated)", () => {
    const out = scanShiftExceptions({
      shifts: [assignedShift()],
      coverage: cov({ a: 0 }),
      now: NOW,
      assignmentsByShift: withWorker1,
      unavailabilityByUser: new Map([[1, [block(1, "2026-10-20T09:00:00Z", "2026-10-20T15:00:00Z")]]]),
      availabilityVerified: false,
    });
    expect(out.find((x) => x.code === "assignee_unavailable")).toBeUndefined();
  });

  it("does NOT flag assignee_unavailable when the block does not overlap the window", () => {
    const out = scanShiftExceptions({
      shifts: [assignedShift()],
      coverage: cov({ a: 0 }),
      now: NOW,
      assignmentsByShift: withWorker1,
      unavailabilityByUser: new Map([[1, [block(1, "2026-10-20T15:00:00Z", "2026-10-20T18:00:00Z")]]]), // after the shift
      availabilityVerified: true,
    });
    expect(out.find((x) => x.code === "assignee_unavailable")).toBeUndefined();
  });

  it("does NOT flag a non-live or instawork assignment", () => {
    const out = scanShiftExceptions({
      shifts: [assignedShift()],
      coverage: cov({ a: 0 }),
      now: NOW,
      assignmentsByShift: new Map([["a", [asg({ connecteamUserId: 1, state: "REPLACED" }), { ...asg({ connecteamUserId: 2 }), workerKind: "instawork", connecteamUserId: null }]]]),
      unavailabilityByUser: new Map([[1, [block(1, "2026-10-20T09:00:00Z", "2026-10-20T15:00:00Z")]]]),
      availabilityVerified: true,
    });
    expect(out.find((x) => x.code === "assignee_unavailable")).toBeUndefined();
  });
});

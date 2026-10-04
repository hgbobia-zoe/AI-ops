import { describe, it, expect } from "vitest";
import { buildReadinessInput, buildLifecycleFacts } from "./tick";
import { deriveShiftLifecycle } from "./lifecycle";
import { computeShiftReadiness } from "./readiness";
import { scanShiftExceptions } from "./exceptions";
import type { ShiftAssignment, StaffShift } from "./types";
import type { DayCoverage } from "./coverage";

const NOW = Date.parse("2026-10-04T06:00:00Z");
const START = "2026-10-04T14:00:00Z";
const END = "2026-10-04T18:00:00Z";

function shift(p: Partial<StaffShift>): StaffShift {
  return {
    id: "SH-1",
    date: "2026-10-04",
    role: "driver",
    headcount: 1,
    startTime: START,
    endTime: END,
    windowKnown: true,
    location: "Warehouse",
    routeId: "R1",
    truckId: "T1",
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

function assignment(p: Partial<ShiftAssignment>): ShiftAssignment {
  return {
    id: "SA-1",
    shiftId: "SH-1",
    workerKind: "internal",
    connecteamUserId: 1,
    instaworkWorker: null,
    instaworkGigId: null,
    displayName: "A",
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

describe("tick state advance (buildLifecycleFacts + deriveShiftLifecycle)", () => {
  it("DRAFT while a gap remains", () => {
    const s = shift({ connecteamShiftId: null });
    const facts = buildLifecycleFacts(s, 1, [], { readinessReady: false, blockingException: false, now: NOW });
    expect(deriveShiftLifecycle(facts)).toBe("DRAFT");
  });

  it("STAFFED once gap 0 + window known but not yet published", () => {
    const s = shift({ assignees: [1] });
    const live = [assignment({})];
    const facts = buildLifecycleFacts(s, 0, live, { readinessReady: false, blockingException: false, now: NOW });
    expect(deriveShiftLifecycle(facts)).toBe("STAFFED");
  });

  it("PROVISIONED once published (gig/CT) but packets not sent", () => {
    const s = shift({ assignees: [1], connecteamShiftId: "ct-1" });
    const live = [assignment({})];
    const facts = buildLifecycleFacts(s, 0, live, { readinessReady: false, blockingException: false, now: NOW });
    expect(deriveShiftLifecycle(facts)).toBe("PROVISIONED");
  });

  it("IN_PROGRESS once a clock-in is mirrored", () => {
    const s = shift({ assignees: [1], connecteamShiftId: "ct-1" });
    const live = [assignment({ clockInAt: START, clockSource: "connecteam" })];
    const facts = buildLifecycleFacts(s, 0, live, { readinessReady: true, blockingException: false, now: NOW });
    expect(deriveShiftLifecycle(facts)).toBe("IN_PROGRESS");
  });

  it("EXCEPTION overlays an active shift with a blocking exception", () => {
    const s = shift({ assignees: [1], connecteamShiftId: "ct-1" });
    const live = [assignment({})];
    const facts = buildLifecycleFacts(s, 0, live, { readinessReady: false, blockingException: true, now: NOW });
    expect(deriveShiftLifecycle(facts)).toBe("EXCEPTION");
  });
});

describe("buildReadinessInput", () => {
  it("TIMEKEEPING is linked only once an internal assignment is on a published shift", () => {
    const unpublished = computeShiftReadiness(buildReadinessInput(shift({ assignees: [1] }), 0, [assignment({})], { coverageOk: true, commsWired: false }));
    expect(unpublished.components.find((c) => c.key === "timekeeping")?.status).toBe("red");

    const published = computeShiftReadiness(buildReadinessInput(shift({ assignees: [1], connecteamShiftId: "ct-1" }), 0, [assignment({})], { coverageOk: true, commsWired: false }));
    expect(published.components.find((c) => c.key === "timekeeping")?.status).toBe("green");
  });

  it("COMMUNICATION + CONFIRMATION stay UNVERIFIED until the comms loop is live", () => {
    const r = computeShiftReadiness(buildReadinessInput(shift({ assignees: [1], connecteamShiftId: "ct-1" }), 0, [assignment({})], { coverageOk: true, commsWired: false }));
    expect(r.components.find((c) => c.key === "communication")?.status).toBe("unknown");
    expect(r.components.find((c) => c.key === "confirmation")?.status).toBe("unknown");
  });
});

describe("replacement_needed exception (no-show reopens a seat)", () => {
  const coverage: DayCoverage = { byShift: { "SH-1": { headcount: 2, assigned: 1, scheduledCredit: 0, scheduledNames: [], scheduledUserIds: [], covered: 1, gap: 1 } }, internalTotal: 1, gapTotal: 1 };
  it("fires when an assignment is a no-show", () => {
    const s = shift({ headcount: 2, assignees: [1] });
    const byShift = new Map<string, ShiftAssignment[]>([["SH-1", [assignment({ state: "NO_SHOW", noShow: true })]]]);
    const out = scanShiftExceptions({ shifts: [s], coverage, now: NOW, assignmentsByShift: byShift, staffingVerified: true });
    expect(out.some((e) => e.code === "replacement_needed")).toBe(true);
  });
  it("does not fire for a healthy live assignment", () => {
    const s = shift({ headcount: 1, assignees: [1] });
    const byShift = new Map<string, ShiftAssignment[]>([["SH-1", [assignment({ state: "ASSIGNED" })]]]);
    const out = scanShiftExceptions({ shifts: [s], coverage: { byShift: { "SH-1": { headcount: 1, assigned: 1, scheduledCredit: 0, scheduledNames: [], scheduledUserIds: [], covered: 1, gap: 0 } }, internalTotal: 1, gapTotal: 0 }, now: NOW, assignmentsByShift: byShift, staffingVerified: true });
    expect(out.some((e) => e.code === "replacement_needed")).toBe(false);
  });
});

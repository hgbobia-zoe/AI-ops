import { describe, it, expect } from "vitest";
import { buildShiftPacket, ZOE_DISPATCH_PHONE, type PacketContext } from "./packet";
import { renderPacketTouch, renderAllTouches } from "./commsTemplates";
import type { ShiftAssignment, StaffShift } from "./types";

function shift(p: Partial<StaffShift> = {}): StaffShift {
  return {
    id: "SH-1",
    date: "2026-10-04",
    role: "driver",
    headcount: 1,
    startTime: "2026-10-04T14:00:00Z",
    endTime: "2026-10-04T18:00:00Z",
    windowKnown: true,
    location: "Warehouse",
    routeId: "R1",
    truckId: "T1",
    eventLabel: "Smith Wedding",
    reasons: [],
    notes: null,
    source: "derived",
    status: "draft",
    assignees: [1],
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
    equipment: ["dolly", "straps"],
    instructions: "Park in the back lot.",
    createdAt: "",
    updatedAt: "",
    ...p,
  };
}

function assignment(p: Partial<ShiftAssignment> = {}): ShiftAssignment {
  return {
    id: "SA-1",
    shiftId: "SH-1",
    workerKind: "internal",
    connecteamUserId: 1,
    instaworkWorker: null,
    instaworkGigId: null,
    displayName: "Michael B",
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

const ctx: PacketContext = {
  truck: { id: "T1", name: "NPR 1" },
  supervisor: { name: "Dana L", phone: "301-555-0100" },
  coworkers: ["Sam R"],
  route: { stops: 3, firstStop: "Grand Ballroom" },
  mapUrl: null,
  equipment: [],
};

describe("buildShiftPacket", () => {
  it("assembles facts from structured data and carries the Zoe dispatch line", () => {
    const p = buildShiftPacket(shift(), assignment(), ctx);
    expect(p.identity.eventLabel).toBe("Smith Wedding");
    expect(p.assignment.truck?.name).toBe("NPR 1");
    expect(p.assignment.supervisor?.name).toBe("Dana L");
    expect(p.operations.equipment).toEqual(["dolly", "straps"]); // falls back to the shift's equipment
    expect(p.timekeeping).toEqual({ kind: "internal", system: "connecteam", howTo: expect.any(String) });
    expect(p.dispatch.phone).toBe(ZOE_DISPATCH_PHONE);
    expect(p.version).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic and content-addressed: same inputs -> same version, a change -> a new version", () => {
    const v1 = buildShiftPacket(shift(), assignment(), ctx).version;
    const v2 = buildShiftPacket(shift(), assignment(), ctx).version;
    expect(v1).toBe(v2);
    const v3 = buildShiftPacket(shift({ truckId: "T2" }), assignment(), { ...ctx, truck: { id: "T2", name: "E450" } }).version;
    expect(v3).not.toBe(v1);
  });

  it("uses the Instawork timekeeping copy for a temp worker (Zoe cannot clock them)", () => {
    const p = buildShiftPacket(shift(), assignment({ workerKind: "instawork", connecteamUserId: null, instaworkWorker: "Alex P", displayName: "Alex P" }), ctx);
    expect(p.timekeeping.system).toBe("instawork");
    expect(p.timekeeping.howTo).toMatch(/Instawork/);
  });

  it("shows TBD for a null fact in a rendered touch, never a guess, and no dashes/emoji", () => {
    const p = buildShiftPacket(shift({ reportLocation: null, location: null }), assignment(), { ...ctx, supervisor: null });
    const body = renderPacketTouch(p, "on_assign");
    expect(body).toContain("TBD");
    expect(body).not.toMatch(/[—–]/); // no em/en dashes (house comms style)
    expect(body).toContain(ZOE_DISPATCH_PHONE);
  });

  it("renders all three touches", () => {
    const all = renderAllTouches(buildShiftPacket(shift(), assignment(), ctx));
    expect(Object.keys(all)).toEqual(["on_assign", "day_before", "refresher"]);
    expect(all.refresher.length).toBeGreaterThan(0);
  });
});

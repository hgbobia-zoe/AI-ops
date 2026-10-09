import { describe, it, expect } from "vitest";
import { buildShiftPacket, ZOE_DISPATCH_PHONE, type PacketContext, type PacketCoworker } from "./packet";
import { renderPacketTouch, renderAllTouches, ROLE_WORD } from "./commsTemplates";
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
    reportTime: "9:00 AM",
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

const CREW: PacketCoworker[] = [
  { name: "Tyrone Banks", role: "driver" },
  { name: "Jade Okoro", role: "field" },
];

const ctx: PacketContext = {
  truck: { id: "T1", name: "NPR 1" },
  supervisor: { name: "Dana L", phone: "301-555-0100" },
  coworkers: CREW,
  route: { stops: 3, firstStop: "Grand Ballroom" },
  mapUrl: null,
  equipment: [],
};

describe("buildShiftPacket", () => {
  it("assembles facts from structured data and carries the Zoe dispatch line", () => {
    const p = buildShiftPacket(shift(), assignment(), ctx);
    expect(p.identity.eventLabel).toBe("Smith Wedding");
    expect(p.assignment.truck?.name).toBe("NPR 1");
    expect(p.assignment.supervisor?.name).toBe("Dana L"); // kept in data, never rendered
    expect(p.operations.equipment).toEqual(["dolly", "straps"]); // falls back to the shift's equipment
    expect(p.timekeeping).toEqual({ kind: "internal", system: "connecteam" });
    expect(p.dispatch.phone).toBe(ZOE_DISPATCH_PHONE);
    expect(p.version).toMatch(/^[0-9a-f]{12}$/);
  });

  it("takes the role from the ASSIGNMENT, not the shift (a helper on a driver shift is a helper)", () => {
    const p = buildShiftPacket(shift({ role: "driver" }), assignment({ role: "field" }), ctx);
    expect(p.identity.role).toBe("field");
    expect(renderPacketTouch(p, "on_assign")).toContain("you're booked as delivery helper");
  });

  it("is deterministic and content-addressed: same inputs -> same version, a change -> a new version", () => {
    const v1 = buildShiftPacket(shift(), assignment(), ctx).version;
    const v2 = buildShiftPacket(shift(), assignment(), ctx).version;
    expect(v1).toBe(v2);
    const v3 = buildShiftPacket(shift({ truckId: "T2" }), assignment(), { ...ctx, truck: { id: "T2", name: "E450" } }).version;
    expect(v3).not.toBe(v1);
  });

  it("carries the Instawork per-gig clock codes into the packet when provided", () => {
    const p = buildShiftPacket(
      shift(),
      assignment({ workerKind: "instawork", connecteamUserId: null, instaworkWorker: "Alex P", displayName: "Alex P" }),
      { ...ctx, clockInCode: "3243", clockOutCode: "2450" },
    );
    expect(p.timekeeping).toEqual({ kind: "instawork", system: "instawork", clockInCode: "3243", clockOutCode: "2450" });
  });
});

describe("ROLE_WORD (locked duty words)", () => {
  it("maps each role to its locked word", () => {
    expect(ROLE_WORD).toEqual({ driver: "driver", field: "delivery helper", prep: "warehouse prep" });
  });
});

describe("renderPacketTouch — locked copy", () => {
  it("renders the crew as 'Name (RoleWord)', each coworker's OWN duty, for an internal helper", () => {
    const p = buildShiftPacket(shift(), assignment({ role: "field", displayName: "Marcus Bell" }), ctx);
    const body = renderPacketTouch(p, "on_assign");
    expect(body).toContain("Working with: Tyrone Banks (driver), Jade Okoro (delivery helper).");
    expect(body).toContain("Hi Marcus Bell, you're booked as delivery helper on 2026-10-04.");
    expect(body).toContain("12712 Rock Creek Mill Rd, Unit 4A");
    expect(body).toContain("end of the cul-de-sac");
    expect(body).toContain("Truck: NPR 1.");
    expect(body).toContain("Clock in/out on Connecteam with your personal code.");
    expect(body).toContain(`Questions: ${ZOE_DISPATCH_PHONE}`);
    expect(body).not.toMatch(/[—–]/); // no em/en dashes (house comms style)
    expect(body).not.toContain("Smith Wedding"); // event label removed
    expect(body).not.toContain("Lead "); // supervisor line removed
    expect(body).not.toContain("Bring/load"); // equipment line removed
  });

  it("says 'just you' when there are no coworkers", () => {
    const p = buildShiftPacket(shift(), assignment(), { ...ctx, coworkers: [] });
    expect(renderPacketTouch(p, "day_before")).toContain("Working with: just you.");
  });

  it("renders the Instawork clock codes when present, and the app fallback when not", () => {
    const withCodes = buildShiftPacket(
      shift(),
      assignment({ workerKind: "instawork", connecteamUserId: null, instaworkWorker: "Alex P", displayName: "Alex P" }),
      { ...ctx, clockInCode: "3243", clockOutCode: "2450" },
    );
    expect(renderPacketTouch(withCodes, "on_assign")).toContain("Clock in: 3243. Clock out: 2450.");

    const noCodes = buildShiftPacket(
      shift(),
      assignment({ workerKind: "instawork", connecteamUserId: null, instaworkWorker: "Alex P", displayName: "Alex P" }),
      { ...ctx, clockInCode: null, clockOutCode: null },
    );
    expect(renderPacketTouch(noCodes, "on_assign")).toContain("Clock in/out through the Instawork app.");
  });

  it("renders the delivery-route link ONLY in the refresher, and drops the line when null", () => {
    const p = buildShiftPacket(shift(), assignment(), ctx);
    const link = "https://ops.example.com/pass/abc123";
    const all = renderAllTouches(p, link);
    expect(all.refresher).toContain(`Delivery route details: ${link}`);
    expect(all.on_assign).not.toContain(link);
    expect(all.on_assign).not.toContain("Delivery route details");
    expect(all.day_before).not.toContain("Delivery route details");
    // No link → the refresher's link line is dropped entirely (no empty "Delivery route details:" left).
    expect(renderPacketTouch(p, "refresher", null)).not.toContain("Delivery route details");
  });

  it("shows TBD for a null report time or truck, never a guess", () => {
    const p = buildShiftPacket(shift({ reportTime: null, windowKnown: false, startTime: null }), assignment(), { ...ctx, truck: null });
    const body = renderPacketTouch(p, "on_assign");
    expect(body).toContain("Report TBD at the warehouse");
    expect(body).toContain("Truck: TBD.");
  });

  it("renders all three touches", () => {
    const all = renderAllTouches(buildShiftPacket(shift(), assignment(), ctx));
    expect(Object.keys(all)).toEqual(["on_assign", "day_before", "refresher"]);
    expect(all.refresher.length).toBeGreaterThan(0);
  });
});

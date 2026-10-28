import { describe, expect, it } from "vitest";
import {
  buildShiftDebriefBody,
  buildShiftDebriefNote,
  mergeManagedNote,
  manualPortion,
  debriefHash,
  DEBRIEF_MARK_BEGIN,
  DEBRIEF_MARK_END,
  type ShiftDebriefContext,
} from "./shiftDebrief";

const ctx: ShiftDebriefContext = {
  roleLabel: "driver",
  date: "2026-10-23",
  startTime: "2026-10-23T13:30:00.000Z",
  endTime: "2026-10-23T21:00:00.000Z",
  truck: "ISU",
  crew: ["Marquis (driver)", "Dana (delivery helper)"],
  stops: [
    { kind: "delivery", customer: "Smith Wedding", address: "10 Oak Rd", window: "2026-10-23T14:00:00.000Z", items: ["20x40 Tent", "Chairs x50"] },
    { kind: "pickup", customer: "Jones Gala", address: "5 Elm St", window: null, items: [] },
  ],
  equipment: ["Tent stakes", "Dolly"],
  premiumCustomers: ["Smith Wedding"],
  eventReadinessCustomers: ["Jones Gala"],
  instructions: "Gate code 1234 at the Smith site.",
};

describe("buildShiftDebriefBody", () => {
  it("includes the route essentials and both stops", () => {
    const body = buildShiftDebriefBody(ctx);
    expect(body).toContain("Role: driver");
    expect(body).toContain("Truck: ISU");
    expect(body).toContain("Stops (2):");
    expect(body).toContain("1. Delivery: Smith Wedding, 10 Oak Rd");
    expect(body).toContain("2. Pickup: Jones Gala, 5 Elm St");
    expect(body).toContain("Items: 20x40 Tent, Chairs x50");
    expect(body).toContain("Equipment and install: Tent stakes, Dolly");
    expect(body).toContain("Time sensitive stops");
    expect(body).toContain("Event Readiness Service booked for: Jones Gala");
    expect(body).toContain("Gate code 1234");
  });

  it("follows house style: no em-dashes, no emoji", () => {
    const body = buildShiftDebriefBody(ctx);
    expect(body).not.toMatch(/[—–]/); // em/en dash
    expect(body).not.toMatch(/[\u{1F300}-\u{1FAFF}☀-➿]/u); // emoji ranges
  });

  it("omits empty sections", () => {
    const bare: ShiftDebriefContext = { roleLabel: "prep", date: "2026-10-23", startTime: null, endTime: null, truck: null, crew: [], stops: [], equipment: [], premiumCustomers: [], eventReadinessCustomers: [] };
    const body = buildShiftDebriefBody(bare);
    expect(body).not.toContain("Stops (");
    expect(body).not.toContain("Equipment");
    expect(body).toContain("Role: prep");
  });
});

describe("mergeManagedNote — preserve manual content", () => {
  const block = buildShiftDebriefNote(ctx);

  it("returns the block alone for an empty existing note", () => {
    expect(mergeManagedNote("", block)).toBe(block);
    expect(mergeManagedNote(null, block)).toBe(block);
  });

  it("appends below manually-typed text, keeping the manual text intact", () => {
    const merged = mergeManagedNote("Bring extra water for the crew.", block);
    expect(merged).toContain("Bring extra water for the crew.");
    expect(merged).toContain(DEBRIEF_MARK_BEGIN);
    expect(manualPortion(merged)).toBe("Bring extra water for the crew.");
  });

  it("replaces ONLY the managed block on re-sync, preserving manual text above and below", () => {
    const first = mergeManagedNote("Manual header note.", block);
    const withTail = `${first}\n\nManual footer added later.`;
    const newBlock = buildShiftDebriefNote({ ...ctx, truck: "BOX" });
    const merged = mergeManagedNote(withTail, newBlock);
    expect(merged).toContain("Manual header note.");
    expect(merged).toContain("Manual footer added later.");
    expect(merged).toContain("Truck: BOX");
    expect(merged).not.toContain("Truck: ISU"); // old managed content gone
    // Exactly one managed block remains (no duplication).
    expect(merged.split(DEBRIEF_MARK_BEGIN).length - 1).toBe(1);
    expect(merged.split(DEBRIEF_MARK_END).length - 1).toBe(1);
  });
});

describe("debriefHash", () => {
  it("is stable for identical bodies and differs on a material change", () => {
    expect(debriefHash(buildShiftDebriefBody(ctx))).toBe(debriefHash(buildShiftDebriefBody(ctx)));
    expect(debriefHash(buildShiftDebriefBody(ctx))).not.toBe(debriefHash(buildShiftDebriefBody({ ...ctx, truck: "BOX" })));
  });
});

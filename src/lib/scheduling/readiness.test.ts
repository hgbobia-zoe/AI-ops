import { describe, it, expect } from "vitest";
import { computeShiftReadiness, type ShiftReadinessInput } from "./readiness";

const ready: ShiftReadinessInput = {
  gap: 0,
  hasRoute: true,
  truckSet: true,
  windowKnown: true,
  reportTimeSet: true,
  reportLocationSet: true,
  assignmentCount: 1,
  allPacketsSent: true,
  timekeepingLinked: true,
  allConfirmed: true,
};

describe("computeShiftReadiness", () => {
  it("all components green → READY, score 100", () => {
    const r = computeShiftReadiness(ready);
    expect(r.level).toBe("READY");
    expect(r.score).toBe(100);
    expect(r.blockers).toEqual([]);
  });

  it("an open staffing gap blocks and docks the staffing weight", () => {
    const r = computeShiftReadiness({ ...ready, gap: 2 });
    expect(r.level).toBe("BLOCKED");
    expect(r.score).toBe(70); // 100 - 30 staffing
    expect(r.components.find((c) => c.key === "staffing")!.status).toBe("red");
    expect(r.blockers).toContain("2 seats unstaffed");
  });

  it("surfaces the single missing logistics fact (truck first)", () => {
    expect(computeShiftReadiness({ ...ready, truckSet: false }).blockers).toContain("No truck assigned");
    expect(computeShiftReadiness({ ...ready, truckSet: true, windowKnown: false }).blockers).toContain("Window not set");
    expect(computeShiftReadiness({ ...ready, reportTimeSet: false }).blockers).toContain("Report time not set");
  });

  it("an UNVERIFIED integration leaves the component UNKNOWN, never red (no fabricated deficiency)", () => {
    const r = computeShiftReadiness({ ...ready, gap: 3, staffingUnverified: true });
    expect(r.components.find((c) => c.key === "staffing")!.status).toBe("unknown");
    expect(r.level).toBe("UNVERIFIED"); // unknown, not blocked
    expect(r.blockers).not.toContain("3 seats unstaffed");
  });

  it("not-yet-wired comms/confirmation read as unknown (UNVERIFIED), not red", () => {
    const r = computeShiftReadiness({ ...ready, allPacketsSent: false, allConfirmed: false, commsUnverified: true, confirmationUnverified: true });
    expect(r.level).toBe("UNVERIFIED");
    expect(r.components.find((c) => c.key === "communication")!.status).toBe("unknown");
    expect(r.components.find((c) => c.key === "confirmation")!.status).toBe("unknown");
  });

  it("unsent packets + unconfirmed (wired) read as red blockers", () => {
    const r = computeShiftReadiness({ ...ready, allPacketsSent: false, allConfirmed: false });
    expect(r.level).toBe("BLOCKED");
    expect(r.blockers).toContain("Packet not sent to everyone");
    expect(r.blockers).toContain("Not everyone confirmed");
  });

  it("a red component always wins the level over an unknown one", () => {
    const r = computeShiftReadiness({ ...ready, truckSet: false, commsUnverified: true, allPacketsSent: false });
    expect(r.level).toBe("BLOCKED");
  });
});

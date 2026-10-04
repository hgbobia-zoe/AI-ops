import { describe, it, expect } from "vitest";
import { optimizeStaffing, scoreAssignment, DEFAULT_STAFFING_CONFIG, type OptimizeInput } from "./optimize";
import type { DayCoverage, ShiftCoverage } from "./coverage";
import type { StaffShift, ShiftRole } from "./types";
import type { CrewMember, CrewShift } from "@/lib/connecteam";

const L_START = "2026-10-04T08:00:00Z";
const L_END = "2026-10-04T16:00:00Z"; // 8h
const S_START = "2026-10-04T09:00:00Z";
const S_END = "2026-10-04T11:00:00Z"; // 2h

function shift(p: Partial<StaffShift> & { id: string; role: ShiftRole }): StaffShift {
  return {
    date: "2026-10-04",
    headcount: 1,
    startTime: null,
    endTime: null,
    windowKnown: true,
    location: null,
    routeId: p.id,
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

function cov(byShift: Record<string, Partial<ShiftCoverage>>): DayCoverage {
  const full: Record<string, ShiftCoverage> = {};
  let internalTotal = 0;
  let gapTotal = 0;
  for (const [id, c] of Object.entries(byShift)) {
    const sc: ShiftCoverage = {
      headcount: c.headcount ?? 1,
      assigned: c.assigned ?? 0,
      scheduledCredit: 0,
      scheduledNames: [],
      scheduledUserIds: [],
      covered: c.covered ?? 0,
      gap: c.gap ?? 0,
    };
    full[id] = sc;
    internalTotal += sc.covered;
    gapTotal += sc.gap;
  }
  return { byShift: full, internalTotal, gapTotal };
}

function input(p: Partial<OptimizeInput> & { shifts: StaffShift[]; coverage: DayCoverage }): OptimizeInput {
  return {
    date: "2026-10-04",
    roster: [],
    dayShifts: [],
    rates: new Map(),
    instawork: { ok: false, gigs: [] },
    now: Date.parse("2026-10-01T00:00:00Z"),
    ...p,
  };
}

describe("scoreAssignment", () => {
  it("gates on qualification (role/title match)", () => {
    const driver = crew(1, "D", "driver");
    const ctx = { bookedHours: 0, maxSeatHours: 8, isContinuity: false };
    expect(scoreAssignment(driver, { role: "driver", hours: 8 }, ctx, DEFAULT_STAFFING_CONFIG)).toBeGreaterThan(0);
    expect(scoreAssignment(driver, { role: "field", hours: 8 }, ctx, DEFAULT_STAFFING_CONFIG)).toBe(-Infinity); // field needs prep
  });
  it("prefers a longer route and a less-loaded worker", () => {
    const d = crew(1, "D", "driver");
    const long = scoreAssignment(d, { role: "driver", hours: 8 }, { bookedHours: 0, maxSeatHours: 8, isContinuity: false }, DEFAULT_STAFFING_CONFIG);
    const short = scoreAssignment(d, { role: "driver", hours: 2 }, { bookedHours: 0, maxSeatHours: 8, isContinuity: false }, DEFAULT_STAFFING_CONFIG);
    expect(long).toBeGreaterThan(short);
    const busy = scoreAssignment(d, { role: "driver", hours: 8 }, { bookedHours: 10, maxSeatHours: 8, isContinuity: false }, DEFAULT_STAFFING_CONFIG);
    expect(long).toBeGreaterThan(busy);
  });
});

describe("optimizeStaffing", () => {
  it("fills a gap with a free internal worker (internal-first)", () => {
    const s = shift({ id: "L", role: "driver", startTime: L_START, endTime: L_END });
    const plan = optimizeStaffing(input({ shifts: [s], coverage: cov({ L: { gap: 1 } }), roster: [crew(1, "Driver A", "driver")] }));
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].kind).toBe("internal");
    expect(plan.assignments[0].userId).toBe(1);
    expect(plan.planTempCount).toBe(0);
    expect(plan.betterThanCurrent).toBe(true);
    expect(plan.tempHoursSaved).toBe(8);
  });

  it("steers the single internal onto the LONGEST route, temp falls to the short one", () => {
    const long = shift({ id: "L", role: "driver", startTime: L_START, endTime: L_END });
    const short = shift({ id: "S", role: "driver", startTime: S_START, endTime: S_END });
    const plan = optimizeStaffing(
      input({ shifts: [long, short], coverage: cov({ L: { gap: 1 }, S: { gap: 1 } }), roster: [crew(1, "Driver A", "driver")] }),
    );
    const onLong = plan.assignments.find((a) => a.routeId === "L")!;
    const onShort = plan.assignments.find((a) => a.routeId === "S")!;
    expect(onLong.kind).toBe("internal");
    expect(onShort.kind).toBe("temp");
    expect(plan.planTempHours).toBe(2); // the 2h route, not the 8h one
    expect(plan.currentTempHours).toBe(10);
    expect(plan.betterThanCurrent).toBe(true);
  });

  it("prevents the DANGEROUS optimization: swaps a committed internal from a SHORT route to a LONG one", () => {
    // Current (human) plan: the only internal is committed to the SHORT route; the LONG route has a gap.
    const long = shift({ id: "L", role: "driver", startTime: L_START, endTime: L_END, assignees: [] });
    const short = shift({ id: "S", role: "driver", startTime: S_START, endTime: S_END, assignees: [7] });
    const plan = optimizeStaffing(
      input({
        shifts: [long, short],
        coverage: cov({ L: { gap: 1 }, S: { gap: 0, assigned: 1, covered: 1 } }),
        roster: [crew(7, "Driver G", "driver")],
      }),
    );
    const onLong = plan.assignments.find((a) => a.routeId === "L")!;
    const onShort = plan.assignments.find((a) => a.routeId === "S")!;
    expect(onLong.kind).toBe("internal");
    expect(onLong.userId).toBe(7);
    expect(onLong.moved).toBe(true);
    expect(onShort.kind).toBe("temp");
    expect(plan.planTempHours).toBe(2); // temp now on the 2h route instead of the 8h one
    expect(plan.currentTempHours).toBe(8);
    expect(plan.tempHoursSaved).toBe(6);
    expect(plan.betterThanCurrent).toBe(true);
  });

  it("says 'already optimal' and never manufactures a saving", () => {
    const s = shift({ id: "L", role: "driver", startTime: L_START, endTime: L_END, assignees: [7] });
    const plan = optimizeStaffing(
      input({ shifts: [s], coverage: cov({ L: { gap: 0, assigned: 1, covered: 1 } }), roster: [crew(7, "Driver G", "driver")] }),
    );
    expect(plan.betterThanCurrent).toBe(false);
    expect(plan.alreadyOptimal).toBe(true);
    expect(plan.tempHoursSaved).toBe(0);
    expect(plan.note).toMatch(/already optimal/i);
  });

  it("marks a temp 'no internal qualified' when the role has no eligible crew", () => {
    const s = shift({ id: "L", role: "driver", startTime: L_START, endTime: L_END });
    const plan = optimizeStaffing(input({ shifts: [s], coverage: cov({ L: { gap: 1 } }), roster: [crew(9, "Office", "other")] }));
    expect(plan.assignments[0].kind).toBe("temp");
    expect(plan.assignments[0].whyTemp).toMatch(/no internal crew qualified/i);
  });

  it("does not place a worker who is on an overlapping Connecteam shift", () => {
    const s = shift({ id: "L", role: "driver", startTime: L_START, endTime: L_END });
    const busyShift: CrewShift = {
      id: "cs1",
      schedulerId: 1,
      schedulerName: "Job",
      startUnix: Date.parse(L_START) / 1000,
      endUnix: Date.parse(L_END) / 1000,
      timezone: "America/New_York",
      isOpen: false,
      title: "Driver",
      assignees: [crew(1, "Driver A", "driver")],
    };
    const plan = optimizeStaffing(
      input({ shifts: [s], coverage: cov({ L: { gap: 1 } }), roster: [crew(1, "Driver A", "driver")], dayShifts: [busyShift] }),
    );
    expect(plan.assignments[0].kind).toBe("temp"); // the only driver is busy → cannot be placed
  });

  it("ignores shifts with an unknown window (never force-fit)", () => {
    const s = shift({ id: "P", role: "driver", windowKnown: false, startTime: null, endTime: null });
    const plan = optimizeStaffing(input({ shifts: [s], coverage: cov({ P: { gap: 1 } }), roster: [crew(1, "D", "driver")] }));
    expect(plan.assignments).toHaveLength(0);
    expect(plan.planTempHours).toBeNull();
    expect(plan.note).toMatch(/no route shifts/i);
  });
});

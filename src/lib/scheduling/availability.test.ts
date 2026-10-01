import { describe, it, expect } from "vitest";
import { recommendCrew, candidateRoles } from "./availability";
import type { StaffShift } from "./types";
import type { CrewMember, CrewShift, CrewRole } from "@/lib/connecteam";

const member = (userId: number, name: string, role: CrewRole): CrewMember => ({ userId, name, role });

function ctShift(id: string, startUnix: number, endUnix: number, assignees: CrewMember[]): CrewShift {
  return { id, schedulerId: 1, schedulerName: "Job", startUnix, endUnix, timezone: "America/New_York", isOpen: assignees.length === 0, title: "", assignees };
}

function shift(role: StaffShift["role"], startIso: string | null, endIso: string | null, assignees: number[] = []): StaffShift {
  return {
    id: "s1", date: "2026-10-01", role, headcount: 1, startTime: startIso, endTime: endIso, windowKnown: startIso != null,
    location: null, routeId: null, truckId: null, eventLabel: null, reasons: [], notes: null, source: "derived", status: "draft",
    assignees, instaworkHeadcount: 0, payRate: null, connecteamShiftId: null, connecteamSchedulerId: null,
    connecteamPublishedAt: null, instaworkGigId: null, instaworkPostedAt: null, createdAt: "", updatedAt: "",
  };
}

// 2026-10-01 12:00–20:00 ET in unix seconds.
const NOON = Math.floor(Date.parse("2026-10-01T12:00:00-04:00") / 1000);
const EIGHT_PM = Math.floor(Date.parse("2026-10-01T20:00:00-04:00") / 1000);

const roster: CrewMember[] = [
  member(1, "Joel (driver)", "driver"),
  member(2, "James (driver)", "driver"),
  member(3, "Adrane (warehouse)", "prep"),
  member(9, "Lisa (office)", "other"), // Operations Coordinator → never recommended
];

describe("candidateRoles", () => {
  it("maps roles and never includes office/other", () => {
    expect(candidateRoles("driver")).toEqual(["driver"]);
    expect(candidateRoles("prep")).toEqual(["prep"]);
    expect(candidateRoles("field")).toEqual(["prep"]); // no internal field title
  });
});

describe("recommendCrew", () => {
  it("recommends free drivers for a driver shift, excludes office", () => {
    const recs = recommendCrew(shift("driver", "2026-10-01T12:00:00-04:00", "2026-10-01T20:00:00-04:00"), [], roster);
    expect([...recs.map((r) => r.userId)].sort()).toEqual([1, 2]); // both free drivers (order = name tiebreak)
    expect(recs.some((r) => r.userId === 9)).toBe(false); // Lisa (office/other) never recommended
  });

  it("excludes a driver already on an overlapping Connecteam shift", () => {
    const day = [ctShift("c1", NOON, EIGHT_PM, [member(1, "Joel", "driver")])]; // Joel busy this window
    const recs = recommendCrew(shift("driver", "2026-10-01T12:00:00-04:00", "2026-10-01T20:00:00-04:00"), day, roster);
    expect(recs.map((r) => r.userId)).toEqual([2]); // only James is free
  });

  it("ranks least-loaded first", () => {
    // James already booked 4h earlier (non-overlapping); Joel booked nothing → Joel first.
    const earlier = [ctShift("c2", NOON - 6 * 3600, NOON - 2 * 3600, [member(2, "James", "driver")])];
    const recs = recommendCrew(shift("driver", "2026-10-01T12:00:00-04:00", "2026-10-01T20:00:00-04:00"), earlier, roster);
    expect(recs.map((r) => r.userId)).toEqual([1, 2]);
    expect(recs[0].bookedHours).toBe(0);
  });

  it("a field shift recommends free warehouse/prep (no internal field title)", () => {
    const recs = recommendCrew(shift("field", "2026-10-01T12:00:00-04:00", "2026-10-01T20:00:00-04:00"), [], roster);
    expect(recs.map((r) => r.userId)).toEqual([3]); // Adrane (prep); drivers + office excluded
  });

  it("does not recommend someone already assigned to the shift", () => {
    const recs = recommendCrew(shift("driver", "2026-10-01T12:00:00-04:00", "2026-10-01T20:00:00-04:00", [1]), [], roster);
    expect(recs.map((r) => r.userId)).toEqual([2]);
  });
});

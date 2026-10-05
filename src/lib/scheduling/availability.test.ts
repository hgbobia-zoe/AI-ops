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
    connecteamPublishedAt: null, instaworkGigId: null, instaworkPostedAt: null,
    lifecycleState: null, supervisorUserId: null, reportLocation: null, reportTime: null, equipment: [], instructions: null,
    createdAt: "", updatedAt: "",
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

  it("PREFERS a driver already on an overlapping Connecteam shift (scheduled-unassigned, not 'busy')", () => {
    const day = [ctShift("c1", NOON, EIGHT_PM, [member(1, "Joel", "driver")])]; // Joel scheduled this window
    const recs = recommendCrew(shift("driver", "2026-10-01T12:00:00-04:00", "2026-10-01T20:00:00-04:00"), day, roster);
    // Joel is no longer excluded — he's a scheduled-but-unassigned worker, the TOP pick (sunk commitment).
    expect(recs.map((r) => r.userId)).toEqual([1, 2]);
    expect(recs[0].userId).toBe(1);
    expect(recs[0].state).toBe("SCHEDULED_UNASSIGNED");
    expect(recs[0].preferred).toBe(true);
    expect(recs[1].state).toBe("AVAILABLE");
  });

  it("excludes a driver on a real time-off / unavailability block overlapping the window", () => {
    const unavailabilityByUser = new Map([[1, [{ userId: 1, kind: "timeOff" as const, startUnix: NOON, endUnix: EIGHT_PM, reason: "PTO" }]]]);
    const recs = recommendCrew(
      shift("driver", "2026-10-01T12:00:00-04:00", "2026-10-01T20:00:00-04:00"),
      [],
      roster,
      { assignments: [], unavailabilityByUser, availabilityKnown: true },
    );
    expect(recs.map((r) => r.userId)).toEqual([2]); // Joel is marked off → excluded; only James
  });

  it("excludes a driver already ASSIGNED to another overlapping Zoe route", () => {
    const assignments = [{ userId: 1, shiftId: "other", start: NOON, end: EIGHT_PM }];
    const recs = recommendCrew(
      shift("driver", "2026-10-01T12:00:00-04:00", "2026-10-01T20:00:00-04:00"),
      [],
      roster,
      { assignments, unavailabilityByUser: new Map(), availabilityKnown: true },
    );
    expect(recs.map((r) => r.userId)).toEqual([2]); // Joel is on another route → not double-offered
  });

  it("ranks least-loaded first among equally-preferred (unscheduled) candidates", () => {
    // James already booked 4h earlier (non-overlapping → AVAILABLE, booked > 0); Joel booked nothing → Joel first.
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

  it("flags availability as unverified when the feed did not answer, but still recommends (never fabricates off)", () => {
    const recs = recommendCrew(
      shift("driver", "2026-10-01T12:00:00-04:00", "2026-10-01T20:00:00-04:00"),
      [],
      roster,
      { assignments: [], unavailabilityByUser: new Map(), availabilityKnown: false },
    );
    expect([...recs.map((r) => r.userId)].sort()).toEqual([1, 2]);
    expect(recs.every((r) => r.availabilityKnown === false)).toBe(true);
    expect(recs[0].reason).toContain("unverified");
  });
});

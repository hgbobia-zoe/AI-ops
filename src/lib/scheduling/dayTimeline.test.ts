import { describe, expect, it } from "vitest";
import type { CrewMember, CrewShift } from "@/lib/connecteam";
import type { StaffShift } from "@/lib/scheduling/types";
import { buildDayTimeline, initialsOf, stackLanes, type DayTimelineInput, type TimelineBar } from "./dayTimeline";

const DAY = Date.UTC(2031, 0, 6, 5, 0, 0); // local midnight (UTC-5)
const at = (h: number, m = 0): number => DAY + (h * 60 + m) * 60000;
const iso = (h: number, m = 0): string => new Date(at(h, m)).toISOString();

const roster: CrewMember[] = [
  { userId: 1, name: "Adrane Walgori", role: "driver", title: "Driver" },
  { userId: 2, name: "Brock Romano", role: "prep" },
  { userId: 3, name: "Cindy Gbobia", role: "other" },
];

function shift(p: Partial<StaffShift> & { id: string }): StaffShift {
  return {
    date: "2031-01-06", role: "field", headcount: 1, startTime: iso(9), endTime: iso(13), windowKnown: true,
    location: null, routeId: "R1", truckId: null, eventLabel: null, reasons: [], notes: null, source: "derived",
    status: "draft", assignees: [], instaworkHeadcount: 0, payRate: null, connecteamShiftId: null,
    connecteamSchedulerId: null, connecteamPublishedAt: null, connecteamContentHash: null, connecteamSyncedAt: null,
    connecteamLastModified: null, syncStatus: null, syncNote: null, instaworkGigId: null, instaworkPostedAt: null,
    lifecycleState: null, supervisorUserId: null, reportLocation: null, reportTime: null, equipment: [], instructions: null,
    createdAt: "", updatedAt: "", ...p,
  } as StaffShift;
}

function ct(p: Partial<CrewShift> & { id: string }): CrewShift {
  return { schedulerId: 1, schedulerName: "Job Scheduler", startUnix: at(9) / 1000, endUnix: at(12) / 1000, timezone: "America/New_York", isOpen: false, title: "Zoe Event Rentals", assignees: [], ...p };
}

function input(p: Partial<DayTimelineInput> = {}): DayTimelineInput {
  return {
    dayStartMs: DAY, roster, appShifts: [], gapByShift: {}, connecteamShifts: [], unavailability: [],
    routeLabel: (id) => (id === "R1" ? "Ford E450" : null),
    clock: (ms) => `${(ms - DAY) / 3600000}h`,
    ...p,
  };
}

describe("buildDayTimeline", () => {
  it("puts an app shift on each assigned person and keeps open seats in the unassigned row", () => {
    const t = buildDayTimeline(input({ appShifts: [shift({ id: "S1", headcount: 2, assignees: [1] })], gapByShift: { S1: 1 } }));
    const adrane = t.people.find((r) => r.userId === 1)!;
    expect(adrane.bars).toHaveLength(1);
    expect(adrane.bars[0]).toMatchObject({ kind: "app", startMin: 540, endMin: 780, title: "Field, Ford E450", shiftId: "S1", published: false });
    expect(adrane.hours).toBe(4);
    expect(t.unassigned.bars).toEqual([expect.objectContaining({ shiftId: "S1", filled: 1, total: 2 })]);
    expect(t.people[0].userId).toBe(1); // working people sort first
  });

  it("shows Connecteam shifts that did not come from the app, and does not double a published app shift", () => {
    const t = buildDayTimeline(
      input({
        appShifts: [shift({ id: "S1", assignees: [1], connecteamShiftId: "CT1" })],
        connecteamShifts: [ct({ id: "CT1", assignees: [roster[0]] }), ct({ id: "CT2", assignees: [roster[2]] }), ct({ id: "CT3", isOpen: true })],
      }),
    );
    expect(t.people.find((r) => r.userId === 1)!.bars.map((b) => b.kind)).toEqual(["app"]);
    expect(t.people.find((r) => r.userId === 1)!.bars[0].published).toBe(true);
    expect(t.people.find((r) => r.userId === 3)!.bars).toEqual([expect.objectContaining({ kind: "connecteam", title: "Zoe Event Rentals" })]);
    expect(t.unassigned.bars).toEqual([expect.objectContaining({ id: "ct:CT3:open", kind: "connecteam" })]);
  });

  it("marks unavailability, flags a whole day block, and never counts it as hours", () => {
    const t = buildDayTimeline(
      input({ unavailability: [{ userId: 2, kind: "unavailability", startUnix: at(-2) / 1000, endUnix: at(26) / 1000 }] }),
    );
    const brock = t.people.find((r) => r.userId === 2)!;
    expect(brock.bars[0]).toMatchObject({ kind: "unavailable", allDay: true, title: "Unavailable", timeLabel: "All day" });
    expect(brock.hours).toBe(0);
    expect(t.people.map((r) => r.userId)).toEqual([2, 1, 3]); // unavailable before people with nothing
  });

  it("a partial day block says until or after, never all day (team report 2026-11-13)", () => {
    const t = buildDayTimeline(
      input({
        unavailability: [
          { userId: 1, kind: "unavailability", startUnix: at(0) / 1000, endUnix: at(14) / 1000 }, // until 2 PM
          { userId: 2, kind: "unavailability", startUnix: at(15) / 1000, endUnix: at(23, 59) / 1000 }, // after 3 PM
          { userId: 3, kind: "timeOff", startUnix: at(14, 30) / 1000, endUnix: at(15, 30) / 1000 },
        ],
      }),
    );
    const bar = (id: number): TimelineBar => t.people.find((r) => r.userId === id)!.bars[0];
    expect(bar(1)).toMatchObject({ allDay: false, timeLabel: "Until 14h", startMin: 0, endMin: 840 });
    expect(bar(2)).toMatchObject({ allDay: false, timeLabel: "After 15h" });
    expect(bar(3)).toMatchObject({ allDay: false, timeLabel: "14.5h to 15.5h", title: "Time off" });
  });

  it("lists a shift with no known time instead of inventing one", () => {
    const t = buildDayTimeline(input({ appShifts: [shift({ id: "S9", windowKnown: false, startTime: null, endTime: null, assignees: [3] })] }));
    expect(t.untimed).toEqual([{ shiftId: "S9", title: "Field, Ford E450", people: ["Cindy Gbobia"], filled: 1, total: 1 }]);
    expect(t.people.every((r) => r.bars.length === 0)).toBe(true);
  });

  it("leaves cancelled shifts off the schedule", () => {
    const t = buildDayTimeline(
      input({
        appShifts: [shift({ id: "S1", headcount: 2, assignees: [1], status: "cancelled" }), shift({ id: "S2", windowKnown: false, startTime: null, status: "cancelled" })],
        gapByShift: { S1: 1 },
      }),
    );
    expect(t.people.find((r) => r.userId === 1)!.bars).toHaveLength(0);
    expect(t.unassigned.bars).toHaveLength(0);
    expect(t.untimed).toHaveLength(0);
  });

  it("still shows a cancelled shift's Connecteam copy while it is in Connecteam, as a Connecteam shift", () => {
    const t = buildDayTimeline(
      input({
        appShifts: [shift({ id: "S1", assignees: [1], status: "cancelled", connecteamShiftId: "CT1" })],
        connecteamShifts: [ct({ id: "CT1", assignees: [roster[0]] })],
      }),
    );
    expect(t.people.find((r) => r.userId === 1)!.bars).toEqual([expect.objectContaining({ kind: "connecteam", id: "ct:CT1:1" })]);
  });

  it("widens the visible hours to fit an early shift, defaulting to 6am to 10pm", () => {
    expect(buildDayTimeline(input())).toMatchObject({ startHour: 6, endHour: 22 });
    const t = buildDayTimeline(input({ appShifts: [shift({ id: "S1", startTime: iso(4, 30), endTime: iso(23, 15), assignees: [1] })] }));
    expect(t).toMatchObject({ startHour: 4, endHour: 24 });
  });

  it("places bars by the Eastern wall clock on a DST switch day (Nov 1 2026, fall back)", () => {
    const nov1 = Date.parse("2026-11-01T04:00:00Z"); // Eastern midnight, still EDT
    const t = buildDayTimeline(
      input({
        dayStartMs: nov1,
        appShifts: [shift({ id: "S1", date: "2026-11-01", startTime: "2026-11-01T13:00:00.000Z", endTime: "2026-11-01T17:00:00.000Z", assignees: [1] })], // 8 AM to noon EST
      }),
    );
    expect(t.people.find((r) => r.userId === 1)!.bars[0]).toMatchObject({ startMin: 480, endMin: 720 });
  });
});

describe("stackLanes", () => {
  it("puts overlapping bars on separate lanes and reuses a lane once free", () => {
    const bar = (id: string, s: number, e: number): TimelineBar => ({ id, kind: "app", startMin: s, endMin: e, timeLabel: "", title: "", lane: 0 });
    const bars = [bar("a", 540, 750), bar("b", 565, 685), bar("c", 750, 900)];
    expect(stackLanes(bars)).toBe(2);
    expect(bars.map((b) => b.lane)).toEqual([0, 1, 0]);
  });
});

describe("initialsOf", () => {
  it("takes first and last initials", () => {
    expect(initialsOf("Adrane Walgori")).toBe("AW");
    expect(initialsOf("Gifti  Abakoyas Jr")).toBe("GJ");
    expect(initialsOf("Cher")).toBe("CH");
  });
});

import { describe, expect, it } from "vitest";
import type { CrewMember, CrewShift } from "@/lib/connecteam";
import type { StaffShift } from "./types";
import { buildWeekGrid, hoursLabel, weekDayLabel, weekStartOf, type WeekDayInput } from "./weekGrid";

// The week of Nov 9 2026 (EST, UTC-5), shaped like the Connecteam week the office shared.
const midnight = (ymd: string): number => Date.parse(`${ymd}T05:00:00.000Z`);
const at = (ymd: string, h: number, m = 0): string => new Date(midnight(ymd) + (h * 60 + m) * 60000).toISOString();
const unix = (ymd: string, h: number, m = 0): number => Date.parse(at(ymd, h, m)) / 1000;

const roster: CrewMember[] = [
  { userId: 1, name: "Adrane Walgori", role: "driver" },
  { userId: 2, name: "Alain Miko", role: "prep" },
  { userId: 3, name: "Brock Romano", role: "driver" },
  { userId: 4, name: "Cindy Gbobia", role: "other" },
];

function shift(p: Partial<StaffShift> & { id: string; date: string }): StaffShift {
  return {
    role: "field", headcount: 1, startTime: null, endTime: null, windowKnown: true, location: null, routeId: null, truckId: null,
    eventLabel: "Zoe Event Rentals", reasons: [], notes: null, source: "manual", status: "sent", assignees: [], instaworkHeadcount: 0,
    payRate: null, connecteamShiftId: null, connecteamSchedulerId: null, connecteamPublishedAt: null, connecteamContentHash: null,
    connecteamSyncedAt: null, connecteamLastModified: null, syncStatus: null, syncNote: null, instaworkGigId: null, instaworkPostedAt: null,
    lifecycleState: null, supervisorUserId: null, reportLocation: null, reportTime: null, equipment: [], instructions: null,
    routeOverride: null, routeWindowStart: null, routeWindowEnd: null, createdAt: "", updatedAt: "", ...p,
  } as StaffShift;
}
const ct = (p: Partial<CrewShift> & { id: string }): CrewShift => ({ schedulerId: 1, schedulerName: "Job Scheduler", startUnix: 0, endUnix: 0, timezone: "America/New_York", isOpen: false, title: "Zoe Event Rentals", assignees: [], ...p });

const WEEK = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
function days(over: Partial<Record<string, Partial<WeekDayInput>>> = {}): WeekDayInput[] {
  return WEEK.map((date) => ({ date, dayStartMs: midnight(date), appShifts: [], gapByShift: {}, connecteamShifts: [], unavailability: [], ...(over[date] ?? {}) }));
}
const build = (d: WeekDayInput[]) =>
  buildWeekGrid({ days: d, roster, routeLabel: () => "Isuzu NPR 1", clock: (ms) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }), today: "2026-11-13" });

describe("week schedule (Connecteam style)", () => {
  it("weeks run Monday to Sunday, labeled like Connecteam", () => {
    expect(weekStartOf("2026-11-13")).toBe("2026-11-09");
    expect(weekStartOf("2026-11-15")).toBe("2026-11-09"); // Sunday belongs to the week before
    expect(weekStartOf("2026-11-16")).toBe("2026-11-16");
    expect(weekDayLabel("2026-11-09")).toBe("Mon 11/9");
    expect(hoursLabel(17.5)).toBe("17:30");
  });

  it("puts each person's shifts and unavailability in the right day, with day and week totals", () => {
    const g = build(
      days({
        "2026-11-10": {
          appShifts: [shift({ id: "S1", date: "2026-11-10", routeId: "R1", startTime: at("2026-11-10", 14, 30), endTime: at("2026-11-10", 19), assignees: [1], connecteamShiftId: "c1" })],
          // Its Connecteam copy is the same shift: shown and counted once.
          connecteamShifts: [ct({ id: "c1", startUnix: unix("2026-11-10", 14, 30), endUnix: unix("2026-11-10", 19), assignees: [{ userId: 1, name: "Adrane Walgori", role: "driver" }] })],
          unavailability: [{ userId: 2, kind: "unavailability", startUnix: unix("2026-11-10", 9), endUnix: unix("2026-11-10", 17) }],
        },
        "2026-11-14": {
          // Overnight 9:30 PM to 1:30 AM: 4 hours, not the 2.5 before midnight.
          connecteamShifts: [ct({ id: "c2", startUnix: unix("2026-11-14", 21, 30), endUnix: unix("2026-11-15", 1, 30), assignees: [{ userId: 2, name: "Alain Miko", role: "prep" }] })],
          unavailability: [{ userId: 3, kind: "unavailability", startUnix: unix("2026-11-14", 0), endUnix: unix("2026-11-14", 23, 59) }],
        },
      }),
    );
    const row = (id: number) => g.people.find((p) => p.userId === id)!;
    expect(row(1).cells["2026-11-10"]).toEqual([expect.objectContaining({ kind: "app", shiftId: "S1", title: "Field, Isuzu NPR 1", published: true })]);
    expect(row(2).cells["2026-11-10"]).toEqual([expect.objectContaining({ kind: "unavailable", title: "Unavailable", allDay: false })]);
    expect(row(2).cells["2026-11-14"]).toEqual([expect.objectContaining({ kind: "connecteam" })]);
    expect(row(3).cells["2026-11-14"]).toEqual([expect.objectContaining({ kind: "unavailable", allDay: true, timeLabel: "All day" })]);
    expect([row(1).hours, row(2).hours, row(3).hours]).toEqual([4.5, 4, 0]);

    const day = (d: string) => g.days.find((x) => x.date === d)!;
    expect(day("2026-11-10")).toMatchObject({ label: "Tue 11/10", hours: 4.5, shifts: 1, people: 1 });
    expect(day("2026-11-14")).toMatchObject({ hours: 4, shifts: 1, people: 1 });
    expect(day("2026-11-13").isToday).toBe(true);
    expect(g.summary).toEqual({ hours: 8.5, shifts: 2, people: 2 });
    // Working people first, then people only marked unavailable, then the rest, by name within each.
    expect(g.people.map((p) => p.name)).toEqual(["Adrane Walgori", "Alain Miko", "Brock Romano", "Cindy Gbobia"]);
  });

  it("open seats and shifts with no time yet sit in the unassigned row of their day", () => {
    const g = build(
      days({
        "2026-11-12": {
          appShifts: [
            shift({ id: "D1", date: "2026-11-12", role: "driver", headcount: 2, startTime: at("2026-11-12", 9), endTime: at("2026-11-12", 13), assignees: [1] }),
            shift({ id: "P1", date: "2026-11-12", role: "prep", headcount: 2, windowKnown: false, assignees: [] }),
          ],
        },
      }),
    );
    expect(g.unassigned["2026-11-12"]).toEqual([
      expect.objectContaining({ shiftId: "D1", filled: 1, total: 2 }),
      expect.objectContaining({ shiftId: "P1", timeLabel: "No time yet", filled: 0, total: 2 }),
    ]);
    expect(g.days.find((d) => d.date === "2026-11-12")!.shifts).toBe(2);
  });

  it("a cancelled shift is not on the week", () => {
    const g = build(days({ "2026-11-11": { appShifts: [shift({ id: "X", date: "2026-11-11", status: "cancelled", startTime: at("2026-11-11", 9), endTime: at("2026-11-11", 13), assignees: [4] })] } }));
    expect(g.people.find((p) => p.userId === 4)!.cells).toEqual({});
    expect(g.summary.shifts).toBe(0);
  });
});

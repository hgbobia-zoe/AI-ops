import { describe, expect, it } from "vitest";
import { parseTimesheetUser } from "./connecteam";

// parseTimesheetUser is the shape-tolerant reader for the payroll-sync prerequisite: it must capture the
// approved/unapproved split + open punches WITHOUT ever assuming unknown approval is "approved" (§4).
describe("parseTimesheetUser", () => {
  it("returns null when there's no userId", () => {
    expect(parseTimesheetUser({ dailyRecords: [] })).toBeNull();
  });

  it("sums dailyTotalHours and leaves approval UNVERIFIED when no approval field is present", () => {
    const d = parseTimesheetUser({
      userId: 7,
      dailyRecords: [{ date: "2026-10-05", dailyTotalHours: 8 }, { date: "2026-10-06", dailyTotalHours: 4.5 }],
    })!;
    expect(d.totalHours).toBe(12.5);
    expect(d.approvalKnown).toBe(false);
    expect(d.approvedHours).toBeNull(); // never 0 when unknown
    expect(d.unapprovedHours).toBeNull();
    expect(d.openPunch).toBe(false);
    expect(d.workedDates).toEqual(["2026-10-05", "2026-10-06"]); // both days have hours
  });

  it("captures worked dates ONLY for days with hours (never a zero-hour day), unique + sorted", () => {
    const d = parseTimesheetUser({
      userId: 7,
      dailyRecords: [
        { date: "2026-10-07", dailyTotalHours: 0 }, // no hours → never locked
        { date: "2026-10-06", dailyTotalHours: 4 },
        { date: "2026-10-05", dailyTotalHours: 8 },
        { date: "2026-10-05", dailyTotalHours: 2 }, // duplicate date → deduped
      ],
    })!;
    expect(d.workedDates).toEqual(["2026-10-05", "2026-10-06"]);
  });

  it("reads a day-level boolean approval flag", () => {
    const d = parseTimesheetUser({
      userId: 7,
      dailyRecords: [
        { date: "2026-10-05", dailyTotalHours: 8, isApproved: true },
        { date: "2026-10-06", dailyTotalHours: 4, isApproved: false },
      ],
    })!;
    expect(d.approvalKnown).toBe(true);
    expect(d.approvedHours).toBe(8);
    expect(d.unapprovedHours).toBe(4);
  });

  it("reads a string approvalStatus and treats pending as unapproved", () => {
    const d = parseTimesheetUser({
      userId: 9,
      dailyRecords: [
        { date: "2026-10-05", dailyTotalHours: 6, approvalStatus: "approved" },
        { date: "2026-10-06", dailyTotalHours: 3, approvalStatus: "pending" },
      ],
    })!;
    expect(d.approvedHours).toBe(6);
    expect(d.unapprovedHours).toBe(3);
  });

  it("splits approval at the shift level and totals from day hours", () => {
    const d = parseTimesheetUser({
      userId: 11,
      dailyRecords: [{
        date: "2026-10-05", dailyTotalHours: 10,
        shifts: [
          { totalHours: 6, isApproved: true },
          { totalHours: 4, isApproved: false },
        ],
      }],
    })!;
    expect(d.totalHours).toBe(10);
    expect(d.approvedHours).toBe(6);
    expect(d.unapprovedHours).toBe(4);
  });

  it("detects an open punch (clock-in without clock-out)", () => {
    const d = parseTimesheetUser({
      userId: 12,
      dailyRecords: [{ date: "2026-10-05", dailyTotalHours: 0, shifts: [{ start: 1_800_000_000, end: null }] }],
    })!;
    expect(d.openPunch).toBe(true);
  });

  it("never counts an un-flagged shift as approved once the field is known", () => {
    const d = parseTimesheetUser({
      userId: 13,
      dailyRecords: [{
        date: "2026-10-05", dailyTotalHours: 9,
        shifts: [
          { totalHours: 5, isApproved: true },
          { totalHours: 4 }, // no flag → must count as unapproved, never silently approved
        ],
      }],
    })!;
    expect(d.approvedHours).toBe(5);
    expect(d.unapprovedHours).toBe(4);
  });
});

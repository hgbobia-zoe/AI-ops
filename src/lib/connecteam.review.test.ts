import { describe, expect, it } from "vitest";
import { parseTimesheetReviewUser } from "./connecteam";

// parseTimesheetReviewUser is the per-DAY reader behind the in-app Timesheet Review surface. It must keep the
// same honesty contract as parseTimesheetUser (approval NEVER assumed when no field is present; hours never
// fabricated) while surfacing the daily rows the owner would otherwise open Connecteam to read: date, hours,
// open-punch, per-day approval, and clock in/out WHEN the payload exposes shift start/end.
describe("parseTimesheetReviewUser", () => {
  it("returns null when there's no userId", () => {
    expect(parseTimesheetReviewUser({ dailyRecords: [] })).toBeNull();
  });

  it("builds sorted per-day rows, sums hours, and leaves approval UNVERIFIED when no field is present", () => {
    const r = parseTimesheetReviewUser({
      userId: 7,
      dailyRecords: [
        { date: "2026-10-06", dailyTotalHours: 4.5 },
        { date: "2026-10-05", dailyTotalHours: 8 },
      ],
    })!;
    expect(r.totalHours).toBe(12.5);
    expect(r.approvalState).toBe("UNVERIFIED"); // never assumed approved
    expect(r.openPunch).toBe(false);
    expect(r.days.map((d) => d.date)).toEqual(["2026-10-05", "2026-10-06"]); // sorted
    expect(r.days[0]).toMatchObject({ hours: 8, approvalState: null, clockIn: null, clockOut: null });
  });

  it("rolls up APPROVED only when every day is approved; any unapproved day → UNAPPROVED", () => {
    const approved = parseTimesheetReviewUser({
      userId: 7,
      dailyRecords: [
        { date: "2026-10-05", dailyTotalHours: 8, isApproved: true },
        { date: "2026-10-06", dailyTotalHours: 4, isApproved: true },
      ],
    })!;
    expect(approved.approvalState).toBe("APPROVED");
    expect(approved.days.map((d) => d.approvalState)).toEqual(["approved", "approved"]);

    const mixed = parseTimesheetReviewUser({
      userId: 7,
      dailyRecords: [
        { date: "2026-10-05", dailyTotalHours: 8, isApproved: true },
        { date: "2026-10-06", dailyTotalHours: 4, approvalStatus: "pending" },
      ],
    })!;
    expect(mixed.approvalState).toBe("UNAPPROVED");
    expect(mixed.days.map((d) => d.approvalState)).toEqual(["approved", "unapproved"]);
  });

  it("includes clock in/out (ET) from shift start/end, and omits clock-out on an open punch", () => {
    // 2026-10-05 13:30:00Z = 9:30 AM ET; 21:00:00Z = 5:00 PM ET.
    const r = parseTimesheetReviewUser({
      userId: 11,
      dailyRecords: [
        { date: "2026-10-05", dailyTotalHours: 7.5, shifts: [{ start: 1759671000, end: 1759698000 }] },
        { date: "2026-10-06", dailyTotalHours: 0, shifts: [{ start: 1759757400, end: null }] },
      ],
    })!;
    expect(r.days[0].clockIn).toBe("9:30 AM");
    expect(r.days[0].clockOut).toBe("5:00 PM");
    expect(r.days[1].openPunch).toBe(true);
    expect(r.days[1].clockOut).toBeNull(); // open punch → no clock-out fabricated
    expect(r.openPunch).toBe(true);
  });

  it("skips days with no resolvable date (never fabricated)", () => {
    const r = parseTimesheetReviewUser({
      userId: 7,
      dailyRecords: [
        { date: "2026-10-05", dailyTotalHours: 8 },
        { dailyTotalHours: 3 }, // no date → dropped
      ],
    })!;
    expect(r.days).toHaveLength(1);
    expect(r.totalHours).toBe(8);
  });
});

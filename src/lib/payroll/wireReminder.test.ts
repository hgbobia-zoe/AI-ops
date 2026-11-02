import { describe, it, expect } from "vitest";
import { wireSeenFor, reminderDueAt, reminderToSend, wireReminderCard, periodLabelOf } from "./wireReminder";
import type { GustoSubmitResult } from "./gustoSubmitState";
import type { WireEventRecord } from "./wireEvent";

// Tuesday Nov 3 2026, 9:00 AM ET (EST, UTC-5) = 14:00 UTC.
const SUBMIT_AT = "2026-11-03T14:00:00.000Z";
const H = 60 * 60 * 1000;
const at = (iso: string) => Date.parse(iso);

const submit = (over: Partial<GustoSubmitResult> = {}): GustoSubmitResult => ({
  key: "2026-10-26..2026-11-01",
  at: SUBMIT_AT,
  ok: true,
  aborted: null,
  submitted: true,
  alreadySubmitted: false,
  draftPayrollId: null,
  payrollId: "p1",
  periodStart: "2026-10-26",
  periodEnd: "2026-11-01",
  checkDate: "2026-11-06",
  uniqueIdentifier: null,
  expectedTotal: 5000,
  headcount: 8,
  wirePathTaken: true,
  errors: [],
  initiatedBy: "Owner",
  ...over,
});

const wire = (over: Partial<WireEventRecord> = {}): WireEventRecord => ({
  transactionId: "tx1",
  amount: -5000,
  amountAbs: 5000,
  counterpartyName: "ZenPayroll",
  bankDescription: null,
  kind: "wire",
  status: "sent",
  createdAt: "2026-11-03T15:00:00.000Z",
  estimatedDeliveryDate: null,
  dashboardLink: null,
  matchedPeriod: null,
  postedToSlack: true,
  postedAt: null,
  failureNotified: false,
  statusHistory: ["sent"],
  firstSeenAt: "2026-11-03T15:00:00.000Z",
  updatedAt: "2026-11-03T15:00:00.000Z",
  ...over,
});

describe("wireSeenFor", () => {
  it("no wires and nothing confirmed means not seen", () => {
    expect(wireSeenFor(submit(), [], false)).toBe(false);
  });
  it("a wire sent after the submit counts", () => {
    expect(wireSeenFor(submit(), [wire()], false)).toBe(true);
  });
  it("last week's wire does not count", () => {
    expect(wireSeenFor(submit(), [wire({ createdAt: "2026-10-27T15:00:00.000Z", firstSeenAt: "2026-10-27T15:00:00.000Z" })], false)).toBe(false);
  });
  it("a wire matched to this period counts even if dated earlier", () => {
    const w = wire({
      createdAt: "2026-10-30T15:00:00.000Z",
      matchedPeriod: { periodStart: "2026-10-26", periodEnd: "2026-11-01", periodLabel: "x", expectedTotal: 5000, source: "current", deltaPct: 0 },
    });
    expect(wireSeenFor(submit(), [w], false)).toBe(true);
  });
  it("a failed wire does not count", () => {
    expect(wireSeenFor(submit(), [wire({ status: "failed" })], false)).toBe(false);
  });
  it("a wire confirmed in Gusto counts", () => {
    expect(wireSeenFor(submit(), [], true)).toBe(true);
  });
});

describe("reminder timing", () => {
  it("first reminder is due 2 hours after the submit", () => {
    expect(reminderDueAt(SUBMIT_AT, 1)).toBe(at(SUBMIT_AT) + 2 * H);
  });
  it("second reminder is due at 10am ET the next day", () => {
    expect(new Date(reminderDueAt(SUBMIT_AT, 2)).toISOString()).toBe("2026-11-04T15:00:00.000Z");
  });
  it("late-night submit still gets the next-morning reminder", () => {
    // Tue 11:30 PM ET = Wed 04:30 UTC; next day (ET) is Wed, 10am ET = 15:00 UTC.
    expect(new Date(reminderDueAt("2026-11-04T04:30:00.000Z", 2)).toISOString()).toBe("2026-11-04T15:00:00.000Z");
  });

  it("nothing before 2 hours", () => {
    expect(reminderToSend(submit(), null, false, at(SUBMIT_AT) + 1 * H)).toBeNull();
  });
  it("reminder 1 after 2 hours", () => {
    expect(reminderToSend(submit(), null, false, at(SUBMIT_AT) + 2 * H)).toBe(1);
  });
  it("reminder 2 waits for 10am next day", () => {
    const st = { sent: 1, lastAt: null };
    expect(reminderToSend(submit(), st, false, at("2026-11-04T14:59:00.000Z"))).toBeNull();
    expect(reminderToSend(submit(), st, false, at("2026-11-04T15:00:00.000Z"))).toBe(2);
  });
  it("stops after two reminders", () => {
    expect(reminderToSend(submit(), { sent: 2, lastAt: null }, false, at("2026-11-04T20:00:00.000Z"))).toBeNull();
  });
  it("never reminds once the wire is seen", () => {
    expect(reminderToSend(submit(), null, true, at(SUBMIT_AT) + 3 * H)).toBeNull();
  });
  it("ignores failed or unsubmitted runs", () => {
    expect(reminderToSend(submit({ ok: false }), null, false, at(SUBMIT_AT) + 3 * H)).toBeNull();
    expect(reminderToSend(submit({ submitted: false }), null, false, at(SUBMIT_AT) + 3 * H)).toBeNull();
  });
  it("ignores submits older than 2 days", () => {
    expect(reminderToSend(submit(), null, false, at(SUBMIT_AT) + 49 * H)).toBeNull();
  });
});

describe("wireReminderCard", () => {
  it("names the period, time and amount with no dashes or emoji", () => {
    const c = wireReminderCard(submit(), 1);
    expect(periodLabelOf(submit())).toBe("Oct 26 to Nov 1");
    expect(c.title).toBe("Payroll wire not sent yet");
    expect(c.body).toContain("Oct 26 to Nov 1");
    expect(c.body).toContain("$5,000.00");
    expect(c.body).toContain("9:00");
    expect(c.body).not.toMatch(/[–—]| - /);
  });
  it("second card says so", () => {
    const c = wireReminderCard(submit(), 2);
    expect(c.title).toBe("Payroll wire still not sent");
    expect(c.body?.startsWith("Second reminder.")).toBe(true);
  });
});

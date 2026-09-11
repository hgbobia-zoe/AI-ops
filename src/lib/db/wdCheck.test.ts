import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import {
  saveBookings,
  listUpcomingSignedForTeamCheck,
  requeueWarehouseTeamAdd,
  shouldAlertMissingWd,
  listPendingGsOps,
  enqueueGsOp,
  WAREHOUSE_DESKTOP_USER_ID,
  type BookingRecord,
} from "./repo";

const day = (offset: number): string => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const booking = (id: string, signed: boolean, date: string | null): BookingRecord => ({
  bookingId: id,
  eventName: `Event ${id}`,
  eventDate: date,
  statusLabel: signed ? "Contract Signed" : "Quote Sent",
  signed,
  contractTotal: 1000,
  grandTotal: 1000,
  amountPaid: 0,
  amountDue: 1000,
  clientName: "Client",
  clientEmail: `${id}@x.com`,
  clientPhone: "",
  quoteSentDate: null,
  dateCreated: null,
  venue: null,
  location: null,
});

beforeEach(() => {
  getDb().prepare("DELETE FROM bookings").run();
  getDb().prepare("DELETE FROM gs_outbox").run();
  getDb().prepare("DELETE FROM wd_alerts").run();
});

describe("listUpcomingSignedForTeamCheck", () => {
  it("returns only SIGNED projects with an event date inside the window", () => {
    const today = day(0);
    saveBookings([
      booking("SOON", true, day(3)), // in window
      booking("QUOTE", false, day(3)), // unsigned → excluded
      booking("PAST", true, day(-2)), // past → excluded
      booking("FAR", true, day(40)), // beyond window → excluded
      booking("UNDATED", true, null), // no date → excluded
    ]);
    const ids = listUpcomingSignedForTeamCheck(14, today).map((p) => p.transactionId);
    expect(ids).toEqual(["SOON"]);
  });

  it("excludes projects that already have a pending add-team-member op (add still in flight)", () => {
    const today = day(0);
    saveBookings([booking("A", true, day(2)), booking("B", true, day(4))]);
    enqueueGsOp({ op: "add_team_member", transactionId: "A", payload: { userID: WAREHOUSE_DESKTOP_USER_ID, linkType: "OTHER" } });
    const ids = listUpcomingSignedForTeamCheck(14, today).map((p) => p.transactionId);
    expect(ids).toEqual(["B"]);
  });
});

describe("requeueWarehouseTeamAdd", () => {
  it("queues an add for a missing project and clears the add-once flag", () => {
    saveBookings([booking("M", true, day(2))]);
    getDb().prepare("UPDATE bookings SET wd_member_added = ? WHERE booking_id = ?").run(new Date().toISOString(), "M");
    expect(requeueWarehouseTeamAdd("M")).toBe(true);
    const ops = listPendingGsOps(50).filter((o) => o.op === "add_team_member" && o.transactionId === "M");
    expect(ops).toHaveLength(1);
    expect((ops[0].payload as { userID: string }).userID).toBe(WAREHOUSE_DESKTOP_USER_ID);
    const flag = getDb().prepare("SELECT wd_member_added FROM bookings WHERE booking_id = ?").get("M") as { wd_member_added: string | null };
    expect(flag.wd_member_added).toBeNull();
  });

  it("does not double-queue when an add is already pending", () => {
    saveBookings([booking("M", true, day(2))]);
    expect(requeueWarehouseTeamAdd("M")).toBe(true);
    expect(requeueWarehouseTeamAdd("M")).toBe(false);
    const ops = listPendingGsOps(50).filter((o) => o.op === "add_team_member" && o.transactionId === "M");
    expect(ops).toHaveLength(1);
  });
});

describe("shouldAlertMissingWd", () => {
  it("alerts the first time, then throttles within the cooldown", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    expect(shouldAlertMissingWd("P", "2026-09-20", 20, now)).toBe(true);
    // 5 hours later — still within the 20h cooldown → no repeat
    expect(shouldAlertMissingWd("P", "2026-09-20", 20, new Date("2026-09-10T17:00:00Z"))).toBe(false);
    // 21 hours later → re-alerts (still missing = keep nagging)
    expect(shouldAlertMissingWd("P", "2026-09-20", 20, new Date("2026-09-11T09:00:00Z"))).toBe(true);
  });

  it("re-alerts immediately when the event date changed, even inside the cooldown", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    expect(shouldAlertMissingWd("P", "2026-09-20", 20, now)).toBe(true);
    expect(shouldAlertMissingWd("P", "2026-09-25", 20, new Date("2026-09-10T13:00:00Z"))).toBe(true);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { saveBookings, enqueueWarehouseTeamAdds, listPendingGsOps, WAREHOUSE_DESKTOP_USER_ID, type BookingRecord } from "./repo";

const booking = (id: string, signed: boolean, date = "2026-09-20"): BookingRecord => ({
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
});

describe("enqueueWarehouseTeamAdds", () => {
  it("queues an add-team-member op only for SIGNED projects, targeting Warehouse Desktop", () => {
    saveBookings([booking("S1", true), booking("Q1", false), booking("S2", true)]);
    const n = enqueueWarehouseTeamAdds();
    expect(n).toBe(2);
    const ops = listPendingGsOps(50).filter((o) => o.op === "add_team_member");
    expect(ops.map((o) => o.transactionId).sort()).toEqual(["S1", "S2"]);
    for (const o of ops) {
      expect((o.payload as { userID: string; linkType: string }).userID).toBe(WAREHOUSE_DESKTOP_USER_ID);
      expect((o.payload as { linkType: string }).linkType).toBe("OTHER");
    }
  });

  it("is add-once — a second run queues nothing more for the same signed projects", () => {
    saveBookings([booking("S1", true)]);
    expect(enqueueWarehouseTeamAdds()).toBe(1);
    expect(enqueueWarehouseTeamAdds()).toBe(0);
    // A newly-signed project after the fact does get queued.
    saveBookings([booking("S9", true)]);
    expect(enqueueWarehouseTeamAdds()).toBe(1);
  });
});

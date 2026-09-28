import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { saveBookings, saveLeadNotes, listPendingGsOps, type BookingRecord } from "./repo";

const booking = (id: string, signed: boolean, statusLabel: string): BookingRecord => ({
  bookingId: id,
  eventName: `Event ${id}`,
  eventDate: "2026-10-01",
  statusLabel,
  signed,
  contractTotal: 1000,
  grandTotal: 1000,
  amountPaid: 0,
  amountDue: 1000,
  clientName: "Jordan Client",
  clientEmail: `${id}@x.com`,
  clientPhone: "",
  quoteSentDate: null,
  dateCreated: null,
  venue: null,
  location: null,
});

const taskOpsFor = (id: string) =>
  listPendingGsOps(200).filter((o) => o.op === "create_gs_task" && o.transactionId === id);

const safeguardAt = (id: string): string | null =>
  (getDb().prepare("SELECT cancel_safeguard_at FROM bookings WHERE booking_id = ?").get(id) as { cancel_safeguard_at: string | null }).cancel_safeguard_at;

beforeEach(() => {
  getDb().prepare("DELETE FROM bookings").run();
  getDb().prepare("DELETE FROM gs_outbox").run();
  getDb().prepare("DELETE FROM history_changes").run();
});

describe("signed→lost linen cancellation safeguard", () => {
  it("fires once, naming the matched linen titles, when a signed order with linen is cancelled", () => {
    saveBookings([booking("LIN", true, "Contract Signed")]);
    saveLeadNotes([{ bookingId: "LIN", lineItems: ["90x132 Tablecloth - White", "Chiavari Chair"] }]);

    saveBookings([booking("LIN", false, "Lost")]); // signed → lost

    const ops = taskOpsFor("LIN");
    expect(ops.length).toBe(1);
    const payload = ops[0].payload as { transactionID: string; title: string; note: string };
    expect(payload.transactionID).toBe("LIN");
    expect(payload.title).toMatch(/linen sub-rental/i);
    expect(payload.note).toMatch(/Tablecloth/);
    expect(safeguardAt("LIN")).not.toBeNull();

    // Idempotent — a repeated pull in the lost state fires nothing more.
    saveBookings([booking("LIN", false, "Cancelled")]);
    expect(taskOpsFor("LIN").length).toBe(1);
  });

  it("fires with soft wording when the order's line items were never captured (missing data must not hide risk)", () => {
    saveBookings([booking("UNK", true, "Contract Signed")]); // no saveLeadNotes → line_items null
    saveBookings([booking("UNK", false, "Lost")]);

    const ops = taskOpsFor("UNK");
    expect(ops.length).toBe(1);
    expect((ops[0].payload as { note: string }).note).toMatch(/not captured/i);
    expect(safeguardAt("UNK")).not.toBeNull();
  });

  it("skips the ask (but still stamps the marker) when line items are present with no linen", () => {
    saveBookings([booking("NOLIN", true, "Contract Signed")]);
    saveLeadNotes([{ bookingId: "NOLIN", lineItems: ["Chiavari Chair", "60in Round Table"] }]);
    saveBookings([booking("NOLIN", false, "Lost")]);

    expect(taskOpsFor("NOLIN").length).toBe(0);
    expect(safeguardAt("NOLIN")).not.toBeNull(); // marked so it isn't reconsidered every pull
  });

  it("does not fire for an UNSIGNED quote that is lost (no signed→lost transition)", () => {
    saveBookings([booking("QUOTE", false, "Quote Sent")]);
    saveLeadNotes([{ bookingId: "QUOTE", lineItems: ["120in Round Linen"] }]);
    saveBookings([booking("QUOTE", false, "Lost")]);

    expect(taskOpsFor("QUOTE").length).toBe(0);
    expect(safeguardAt("QUOTE")).toBeNull();
  });

  it("does not fire when a signed project stays signed", () => {
    saveBookings([booking("KEEP", true, "Contract Signed")]);
    saveLeadNotes([{ bookingId: "KEEP", lineItems: ["Satin Table Runner"] }]);
    saveBookings([booking("KEEP", true, "Contract Signed")]);

    expect(taskOpsFor("KEEP").length).toBe(0);
    expect(safeguardAt("KEEP")).toBeNull();
  });
});

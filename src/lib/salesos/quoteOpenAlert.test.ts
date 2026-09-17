import { describe, expect, it } from "vitest";
import { saveBookings, saveLeadNotes, pendingQuoteOpenAlerts, markQuoteOpenAlerted } from "@/lib/db/repo";

// DATABASE_PATH is ":memory:" (vitest.config.ts).
function seed(bookingId: string, sentAt: string | null, openedAt: string | null): void {
  saveBookings([{ bookingId, eventName: "Jane · Wedding", clientName: "Jane Doe", eventDate: "2027-06-20", location: "Bethesda, MD" }]);
  saveLeadNotes([{ bookingId, quoteSentAt: sentAt, quoteOpenedAt: openedAt }]);
}
const has = (id: string): boolean => pendingQuoteOpenAlerts().some((c) => c.bookingId === id);

describe("pendingQuoteOpenAlerts", () => {
  it("flags an open more than an hour after send, with client/context", () => {
    seed("QO-1", "2027-01-01T10:00:00.000Z", "2027-01-01T13:00:00.000Z");
    const c = pendingQuoteOpenAlerts().find((x) => x.bookingId === "QO-1");
    expect(c).toBeTruthy();
    expect(c?.clientName).toBe("Jane Doe");
    expect(c?.eventName).toBe("Jane · Wedding");
  });

  it("ignores an open within an hour of send (too early to ping)", () => {
    seed("QO-2", "2027-01-01T10:00:00.000Z", "2027-01-01T10:30:00.000Z");
    expect(has("QO-2")).toBe(false);
  });

  it("ignores a quote that was never opened", () => {
    seed("QO-3", "2027-01-01T10:00:00.000Z", null);
    expect(has("QO-3")).toBe(false);
  });

  it("stops flagging once alerted, then re-qualifies on a newer open", () => {
    seed("QO-4", "2027-01-01T10:00:00.000Z", "2027-01-01T13:00:00.000Z");
    expect(has("QO-4")).toBe(true);
    markQuoteOpenAlerted("QO-4", "2027-01-01T13:00:00.000Z");
    expect(has("QO-4")).toBe(false);
    saveLeadNotes([{ bookingId: "QO-4", quoteOpenedAt: "2027-01-02T09:00:00.000Z" }]);
    expect(has("QO-4")).toBe(true);
  });
});

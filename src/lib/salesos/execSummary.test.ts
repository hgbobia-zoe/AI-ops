import { describe, expect, it } from "vitest";
import { buildPipelineStatus } from "./execSummary";
import { saveBookings, saveLeadNotes, insertCommsEventIfNew } from "@/lib/db/repo";

// DATABASE_PATH is ":memory:" (vitest.config.ts). The DB is shared across the run, so assertions target
// specific seeded ids (absolute cross-test sums would be brittle).

const TODAY = "2029-01-01";
const find = (id: string) => buildPipelineStatus(TODAY).rows.find((r) => r.id === id);

describe("buildPipelineStatus", () => {
  it("flags a quote the client opened with no rep follow-up, money stays in dollars", () => {
    const id = "PS-opened-1";
    saveBookings([{ bookingId: id, eventName: "Reed · Gala", clientName: "Sam Reed", eventDate: "2030-05-01", signed: false, grandTotal: 4200, amountDue: 500 }]);
    saveLeadNotes([{ bookingId: id, quoteSentAt: "2028-12-01T10:00:00.000Z", quoteOpenedAt: "2028-12-03T10:00:00.000Z" }]);
    const r = find(id)!;
    expect(r).toBeTruthy();
    // Dollars are passed through untouched (no re-division of an already-dollars figure).
    expect(r.value).toBe(4200);
    expect(r.amountDue).toBe(500);
    // The only outbound touch is the quote email, which predates the open → opened, no follow-up.
    expect(r.openedNoFollowup).toBe(true);
    expect(r.lastOutbound?.channel).toBe("quote");
    expect(r.awaitingReply).toBe(false);
  });

  it("marks a lead a rep has never contacted, and counts it neglected", () => {
    const id = "PS-never-1";
    saveBookings([{ bookingId: id, eventName: "Cole", clientName: "Jo Cole", eventDate: "2030-06-01", signed: false, amountDue: 1200 }]);
    const r = find(id)!;
    expect(r.lastOutbound).toBeNull();
    expect(r.daysSinceOutbound).toBeNull();
    expect(r.neglected7).toBe(true);
    expect(r.neglected14).toBe(true);
    expect(r.amountDue).toBe(1200);
    const summary = buildPipelineStatus(TODAY).summary;
    expect(summary.neverTouched).toBeGreaterThanOrEqual(1);
    expect(summary.openCount).toBeGreaterThanOrEqual(2);
  });

  it("marks a lead awaiting our reply when the last activity is inbound", () => {
    const id = "PS-await-1";
    saveBookings([{ bookingId: id, eventName: "Vega", clientName: "Rio Vega", clientPhone: "4105551212", eventDate: "2030-07-01", signed: false }]);
    insertCommsEventIfNew({ providerId: "await-sms-out", leadId: id, direction: "outbound", channel: "sms", body: "Any questions?", actor: "HG", occurredAt: "2028-12-20T10:00:00.000Z" });
    insertCommsEventIfNew({ providerId: "await-sms-in", leadId: id, direction: "inbound", channel: "sms", body: "Can you hold my date?", occurredAt: "2028-12-28T10:00:00.000Z" });
    const r = find(id)!;
    expect(r.awaitingReply).toBe(true);
    expect(r.lastActivity?.direction).toBe("in");
    expect(r.lastOutbound?.channel).toBe("sms");
    expect(r.daysSinceOutbound).toBeGreaterThanOrEqual(0);
  });
});

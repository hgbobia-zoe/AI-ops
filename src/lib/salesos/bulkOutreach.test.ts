// Bulk Review-and-Fire tests. The LLM is OFF in the test env, so draftLeadOutreach falls back to its
// deterministic template floor — no real model calls. The SMS provider (sendSms) is MOCKED, so no real
// text is ever sent: we assert it is invoked (or not) exactly as the gate + idempotency dictate. Email
// stays a governed gs_outbox email_send op (no provider).

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { getDb } from "@/lib/db";
import { saveBookings, insertCommsEventIfNew, listPendingGsOps } from "@/lib/db/repo";
import { getApproval, approvalExistsByKey } from "@/lib/aiorg/approvals";
import { todayInOpsTz } from "@/lib/dates";
import { sendSms } from "@/lib/notify/sms";
import { buildBulkOutreachCohort, queueBulkOutreach, bulkIdempotencyKey } from "./bulkOutreach";

// The provider is MOCKED — no real text is ever sent in tests. Default: a successful send.
vi.mock("@/lib/notify/sms", () => ({
  sendSms: vi.fn(async () => ({ ok: true, providerMsgId: "PM-test" })),
}));
const sendSmsMock = sendSms as unknown as Mock;

beforeEach(() => {
  sendSmsMock.mockClear();
  sendSmsMock.mockResolvedValue({ ok: true, providerMsgId: "PM-test" });
  getDb().prepare("DELETE FROM ai_approvals").run();
  getDb().prepare("DELETE FROM gs_outbox").run();
  getDb().prepare("DELETE FROM bookings").run();
  getDb().prepare("DELETE FROM comms_events").run();
  getDb().prepare("DELETE FROM messages").run();
  delete process.env.EMAIL_SEND_ENABLED;
  delete process.env.OUTREACH_LLM;
  process.env.SMS_SEND_ENABLED = "true"; // default ON (prod parity); a gate-off test overrides it
});
afterEach(() => {
  delete process.env.EMAIL_SEND_ENABLED;
  delete process.env.SMS_SEND_ENABLED;
});

// A lead that derives to the "quote_sent" board status: quote sent today, future event, not signed, no
// inbound reply. Variants flip the reachable channels.
function seedQuoteSent(over: Partial<Parameters<typeof saveBookings>[0][number]> = {}): void {
  saveBookings([
    {
      bookingId: "QS1",
      eventName: "Garcia Wedding",
      eventDate: "2099-06-01",
      statusLabel: "Quote Sent",
      signed: false,
      grandTotal: 12000,
      clientName: "Pat Garcia",
      clientEmail: "pat@example.com",
      clientPhone: "+13015551234",
      quoteSentDate: todayInOpsTz(),
      ...over,
    },
  ]);
}

describe("buildBulkOutreachCohort — cohort scope", () => {
  it("returns only quote_sent leads (drops new / signed / lost)", async () => {
    saveBookings([
      { bookingId: "QS1", eventName: "Quote Lead", eventDate: "2099-06-01", statusLabel: "Quote Sent", signed: false, grandTotal: 9000, clientName: "Q", clientEmail: "q@example.com", clientPhone: "+13015550001", quoteSentDate: todayInOpsTz() },
      { bookingId: "NEW1", eventName: "New Lead", eventDate: "2099-06-02", statusLabel: "New Project", signed: false, grandTotal: 1000, clientName: "N", clientEmail: "n@example.com", clientPhone: "" },
      { bookingId: "WON1", eventName: "Signed Lead", eventDate: "2099-06-03", statusLabel: "Contract Signed", signed: true, grandTotal: 5000, clientName: "W", clientEmail: "w@example.com", clientPhone: "" },
      { bookingId: "LOST1", eventName: "Lost Lead", eventDate: "2099-06-04", statusLabel: "Lost", signed: false, grandTotal: 3000, clientName: "L", clientEmail: "l@example.com", clientPhone: "" },
    ]);
    const cohort = await buildBulkOutreachCohort("Jessie");
    expect(cohort.rows.map((r) => r.leadId)).toEqual(["QS1"]);
  });
});

describe("buildBulkOutreachCohort — per-row availability + flags", () => {
  it("no phone → SMS not available (email still offered)", async () => {
    seedQuoteSent({ clientPhone: "" });
    const row = (await buildBulkOutreachCohort("Jessie")).rows[0];
    expect(row.smsAvailable).toBe(false);
    expect(row.defaultSms).toBe(false);
    expect(row.emailAvailable).toBe(true);
    expect(row.defaultEmail).toBe(true);
    expect(row.smsDraft).toBeTruthy(); // drafted even if not reachable; availability is a separate honest flag
  });

  it("no email → email not available (SMS still offered)", async () => {
    seedQuoteSent({ clientEmail: "" });
    const row = (await buildBulkOutreachCohort("Jessie")).rows[0];
    expect(row.emailAvailable).toBe(false);
    expect(row.defaultEmail).toBe(false);
    expect(row.smsAvailable).toBe(true);
    expect(row.defaultEmail).toBe(false);
  });

  it("recently contacted (< 24h) → flagged and default-off", async () => {
    seedQuoteSent();
    insertCommsEventIfNew({ providerId: "out-1", leadId: "QS1", direction: "outbound", channel: "sms", toPhone: "+13015551234", body: "just reached out", actor: "SalesOS", occurredAt: new Date().toISOString() });
    const row = (await buildBulkOutreachCohort("Jessie")).rows[0];
    expect(row.recentlyContacted).toBe(true);
    expect(row.defaultSms).toBe(false);
    expect(row.defaultEmail).toBe(false);
    expect(row.note).toMatch(/Contacted within/i);
    expect(row.lastTouch?.what).toMatch(/Outbound/i);
  });

  it("not recently contacted → default-on for every reachable channel", async () => {
    seedQuoteSent();
    const row = (await buildBulkOutreachCohort("Jessie")).rows[0];
    expect(row.recentlyContacted).toBe(false);
    expect(row.defaultSms).toBe(true);
    expect(row.defaultEmail).toBe(true);
  });
});

describe("queueBulkOutreach — email (governed outbox op)", () => {
  it("email with the gate ON enqueues the email_send outbox op, status queued (not 'sent')", async () => {
    process.env.EMAIL_SEND_ENABLED = "true";
    seedQuoteSent();
    const summary = await queueBulkOutreach([{ leadId: "QS1", email: { subject: "Following up", body: "Hi Pat, checking in." } }], "Owner");
    expect(summary.queuedEmail).toBe(1);
    const ch = summary.rows[0].channels.find((c) => c.channel === "email")!;
    expect(ch.status).toBe("queued"); // honest: enqueued, NOT confirmed delivered
    const ops = listPendingGsOps(50).filter((o) => o.op === "email_send");
    expect(ops.length).toBe(1);
    expect(ops[0].transactionId).toBe("QS1");
    expect(approvalExistsByKey(bulkIdempotencyKey("QS1", "email", summary.today))).toBe(true);
    expect(getApproval(ch.approvalId)!.outboxOpId).toBeTruthy();
  });

  it("email with the gate OFF is approved+held — nothing enqueued", async () => {
    delete process.env.EMAIL_SEND_ENABLED;
    seedQuoteSent();
    const summary = await queueBulkOutreach([{ leadId: "QS1", email: { body: "Hi Pat." } }], "Owner");
    expect(summary.heldEmail).toBe(1);
    expect(summary.queuedEmail).toBe(0);
    expect(summary.rows[0].channels[0].status).toBe("held");
    expect(listPendingGsOps(50).filter((o) => o.op === "email_send").length).toBe(0);
  });

  it("email is idempotent — re-firing the same day does NOT enqueue twice", async () => {
    process.env.EMAIL_SEND_ENABLED = "true";
    seedQuoteSent();
    const items = [{ leadId: "QS1", email: { body: "Hi Pat." } }];
    const first = await queueBulkOutreach(items, "Owner");
    expect(first.queuedEmail).toBe(1);
    const second = await queueBulkOutreach(items, "Owner");
    expect(second.queuedEmail).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(second.rows[0].channels[0].status).toBe("already_sent");
    expect(listPendingGsOps(50).filter((o) => o.op === "email_send").length).toBe(1);
  });
});

describe("queueBulkOutreach — SMS (real live send through the gated sender)", () => {
  it("an approved reachable SMS row actually sends: calls sendSms once, status 'sent'", async () => {
    seedQuoteSent(); // SMS_SEND_ENABLED is ON by default in beforeEach
    const summary = await queueBulkOutreach([{ leadId: "QS1", sms: { body: "Hi Pat, it's Zoe Events." } }], "Owner");
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    expect(sendSmsMock).toHaveBeenCalledWith("+13015551234", "Hi Pat, it's Zoe Events.", expect.anything());
    expect(summary.sentSms).toBe(1);
    const ch = summary.rows[0].channels.find((c) => c.channel === "sms")!;
    expect(ch.status).toBe("sent");
    // The governed approval is still recorded for the audit trail.
    expect(approvalExistsByKey(bulkIdempotencyKey("QS1", "sms", summary.today))).toBe(true);
  });

  it("is idempotent — re-firing the same SMS row the same day does NOT text twice", async () => {
    seedQuoteSent();
    const items = [{ leadId: "QS1", sms: { body: "Hi Pat." } }];
    const first = await queueBulkOutreach(items, "Owner");
    expect(first.sentSms).toBe(1);
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    const second = await queueBulkOutreach(items, "Owner");
    expect(sendSmsMock).toHaveBeenCalledTimes(1); // NOT called again
    expect(second.sentSms).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(second.rows[0].channels[0].status).toBe("already_sent");
  });

  it("gate OFF holds the SMS without calling the provider (never a fake 'sent')", async () => {
    delete process.env.SMS_SEND_ENABLED;
    seedQuoteSent();
    const summary = await queueBulkOutreach([{ leadId: "QS1", sms: { body: "Hi Pat." } }], "Owner");
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(summary.heldSms).toBe(1);
    expect(summary.sentSms).toBe(0);
    expect(summary.rows[0].channels[0].status).toBe("held");
  });

  it("a provider failure surfaces honestly as failed (with reason), not sent", async () => {
    sendSmsMock.mockResolvedValueOnce({ ok: false, error: "carrier rejected" });
    seedQuoteSent();
    const summary = await queueBulkOutreach([{ leadId: "QS1", sms: { body: "Hi Pat." } }], "Owner");
    expect(summary.failedSms).toBe(1);
    expect(summary.sentSms).toBe(0);
    const ch = summary.rows[0].channels[0];
    expect(ch.status).toBe("failed");
    expect(ch.message).toMatch(/carrier rejected/);
  });

  it("no phone on file → SMS skipped with a reason, provider never called", async () => {
    seedQuoteSent({ clientPhone: "" });
    const summary = await queueBulkOutreach([{ leadId: "QS1", sms: { body: "hi" } }], "Owner");
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.rows[0].skipped).toEqual([{ channel: "sms", reason: "No phone on file." }]);
  });
});

describe("queueBulkOutreach — mixed + edge cases", () => {
  it("fires BOTH channels on one row: email queued + SMS sent", async () => {
    process.env.EMAIL_SEND_ENABLED = "true";
    seedQuoteSent();
    const summary = await queueBulkOutreach([{ leadId: "QS1", email: { body: "Hi Pat." }, sms: { body: "Hi Pat, it's Zoe Events." } }], "Owner");
    expect(summary.queuedEmail).toBe(1);
    expect(summary.sentSms).toBe(1);
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    expect(listPendingGsOps(50).filter((o) => o.op === "email_send").length).toBe(1);
  });

  it("re-validates reachability server-side: a requested SMS with no phone is skipped while email still queues", async () => {
    process.env.EMAIL_SEND_ENABLED = "true";
    seedQuoteSent({ clientPhone: "" });
    const summary = await queueBulkOutreach([{ leadId: "QS1", sms: { body: "hi" }, email: { body: "Hi Pat." } }], "Owner");
    expect(summary.queuedEmail).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(summary.rows[0].skipped).toEqual([{ channel: "sms", reason: "No phone on file." }]);
  });

  it("skips an unknown lead without throwing", async () => {
    const summary = await queueBulkOutreach([{ leadId: "NOPE", email: { body: "x" } }], "Owner");
    expect(summary.skipped).toBe(1);
    expect(summary.queuedEmail).toBe(0);
    expect(listPendingGsOps(50).length).toBe(0);
  });
});

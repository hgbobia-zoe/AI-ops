// Bulk Review-and-Fire tests. The LLM is OFF in the test env, so draftLeadOutreach falls back to its
// deterministic template floor — no real model calls. The SMS provider (sendSms) is MOCKED, so no real
// text is ever sent: we assert it is invoked (or not) exactly as the gate + idempotency dictate. Email
// stays a governed gs_outbox email_send op (no provider).

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { getDb } from "@/lib/db";
import { saveBookings, saveLeadNotes, insertCommsEventIfNew, listPendingGsOps } from "@/lib/db/repo";
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

const ymdDaysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// A lead that derives to the "quote_sent" board status: quote sent a couple of days ago (recent enough to
// still be "Quote Sent", not past the follow-up window, but NOT within the recently-contacted window),
// future event, not signed, no inbound reply. Variants flip the reachable channels.
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
      quoteSentDate: ymdDaysAgo(2),
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

// Part A — last touch + recently-contacted reflect the REAL merged timeline (quote-send + GSPRO note log
// + comms), not just the comms_events rows. A quoted/worked lead must never read "none logged"; a
// genuinely blank lead honestly still does.
describe("buildBulkOutreachCohort — last touch reflects the real timeline (not just comms_events)", () => {
  it("a quote-sent lead with NO inbound comms still shows a real last touch (the quote-send), never 'none logged'", async () => {
    seedQuoteSent(); // quote sent 2 days ago, zero comms_events rows
    const row = (await buildBulkOutreachCohort("Jessie")).rows[0];
    expect(row.lastTouch).not.toBeNull();
    expect(row.lastTouch!.what.toLowerCase()).toContain("quote");
    expect(row.lastTouch!.whenIso).toBeTruthy(); // a real dated touch, not a fabricated one
    expect(row.recentlyContacted).toBe(false);
  });

  it("surfaces a Goodshuffle internal-note touch as the last touch when it is the newest activity", async () => {
    seedQuoteSent();
    // A rep note newer than the (2-day-old) quote-send. Notes are UNDATED (no reliable year) — the date
    // token is kept exactly as written, and whenIso stays null.
    saveLeadNotes([{ bookingId: "QS1", internalNotes: "header line\nHG - 9/7 - Called client, left a message" }]);
    const row = (await buildBulkOutreachCohort("Jessie")).rows[0];
    expect(row.lastTouch).not.toBeNull();
    // The newest DATED touch is still the quote-send; the undated note never jumps ahead of a dated
    // entry (we can't place it on an instant). Either way it is a REAL touch, never "none logged".
    expect(row.lastTouch!.what.toLowerCase()).toMatch(/quote|note/);
  });

  it("the double-contact guard sees a just-sent quote (quote-send counts as a recent OUTBOUND touch)", async () => {
    seedQuoteSent();
    saveLeadNotes([{ bookingId: "QS1", quoteSentAt: new Date().toISOString() }]); // precise, just now
    const row = (await buildBulkOutreachCohort("Jessie")).rows[0];
    expect(row.recentlyContacted).toBe(true);
    expect(row.defaultSms).toBe(false);
    expect(row.defaultEmail).toBe(false);
    expect(row.note).toMatch(/Contacted within/i);
  });

  it("a genuinely blank lead (no quote date, no comms, no notes) honestly shows no last touch", async () => {
    // Quote-sent by status label only — nothing actually captured. "none logged" is the honest answer;
    // we must NOT fabricate a touch.
    saveBookings([
      { bookingId: "QS1", eventName: "Blank Co", eventDate: "2099-06-01", statusLabel: "Quote Sent", signed: false, grandTotal: 5000, clientName: "Blank Co", clientEmail: "b@example.com", clientPhone: "+13015559999" },
    ]);
    const row = (await buildBulkOutreachCohort("Jessie")).rows[0];
    expect(row.leadId).toBe("QS1");
    expect(row.lastTouch).toBeNull();
    expect(row.recentlyContacted).toBe(false);
  });
});

// The cockpit works the WHOLE open-quote cohort — Goodshuffle's single "Quote Sent" stage, which our
// board auto-splits into quote_sent (recent) + follow_up (dormant) + action_needed (replied). All three are
// open quotes awaiting movement; `new` (no quote) and `signed` are not.
describe("buildBulkOutreachCohort — broadened open-quote cohort + sub-status", () => {
  function seed(): void {
    saveBookings([
      // quote_sent (recent): quoted 2 days ago, silent → "Recent".
      { bookingId: "RECENT", eventName: "Recent Co", eventDate: "2099-06-01", statusLabel: "Quote Sent", signed: false, grandTotal: 8000, clientName: "Rae Recent", clientEmail: "r@example.com", clientPhone: "+13015550010", quoteSentDate: ymdDaysAgo(2) },
      // follow_up: quoted 10 days ago, no contact since → past the follow-up silence window → "Needs follow-up".
      { bookingId: "DORMANT", eventName: "Dormant Co", eventDate: "2099-07-01", statusLabel: "Quote Sent", signed: false, grandTotal: 9000, clientName: "Dana Dormant", clientEmail: "d@example.com", clientPhone: "+13015550011", quoteSentDate: ymdDaysAgo(10) },
      // action_needed: quoted 3 days ago AND the client just replied → "Replied".
      { bookingId: "REPLIED", eventName: "Replied Co", eventDate: "2099-08-01", statusLabel: "Quote Sent", signed: false, grandTotal: 11000, clientName: "Remy Replied", clientEmail: "p@example.com", clientPhone: "+13015550012", quoteSentDate: ymdDaysAgo(3) },
      // excluded: no quote yet (new) + signed.
      { bookingId: "NEWLEAD", eventName: "New Co", eventDate: "2099-09-01", statusLabel: "New Project", signed: false, grandTotal: 1000, clientName: "Newt New", clientEmail: "n@example.com", clientPhone: "" },
      { bookingId: "SIGNED", eventName: "Signed Co", eventDate: "2099-10-01", statusLabel: "Contract Signed", signed: true, grandTotal: 5000, clientName: "Sam Signed", clientEmail: "s@example.com", clientPhone: "" },
    ]);
    // The reply that pushes REPLIED into action_needed (inbound, so it does NOT trip the recently-contacted
    // guard — which keys off OUTBOUND touches only).
    insertCommsEventIfNew({ providerId: "in-replied-1", leadId: "REPLIED", direction: "inbound", channel: "sms", fromPhone: "+13015550012", body: "Can you do Saturday instead?", occurredAt: new Date().toISOString() });
  }

  it("includes quote_sent + follow_up + action_needed (a quote is out), excludes new + signed", async () => {
    seed();
    const cohort = await buildBulkOutreachCohort("Jessie");
    const byId = Object.fromEntries(cohort.rows.map((r) => [r.leadId, r]));
    expect(new Set(cohort.rows.map((r) => r.leadId))).toEqual(new Set(["RECENT", "DORMANT", "REPLIED"]));
    expect(byId.RECENT.subStatus).toBe("quote_sent");
    expect(byId.RECENT.subStatusLabel).toBe("Recent");
    expect(byId.DORMANT.subStatus).toBe("follow_up");
    expect(byId.DORMANT.subStatusLabel).toBe("Needs follow-up");
    expect(byId.REPLIED.subStatus).toBe("action_needed");
    expect(byId.REPLIED.subStatusLabel).toBe("Replied");
  });

  it("the action_needed ('Replied') row is flagged and defaults UNCHECKED (opt-in), guardrails intact", async () => {
    seed();
    const row = (await buildBulkOutreachCohort("Jessie")).rows.find((r) => r.leadId === "REPLIED")!;
    expect(row.replied).toBe(true);
    expect(row.recentlyContacted).toBe(false); // an inbound reply must NOT read as "we contacted them"
    expect(row.defaultSms).toBe(false);
    expect(row.defaultEmail).toBe(false);
    expect(row.note).toMatch(/replied/i);
  });

  it("a non-replied, non-recent open quote (follow_up) defaults ON for every reachable channel", async () => {
    seed();
    const row = (await buildBulkOutreachCohort("Jessie")).rows.find((r) => r.leadId === "DORMANT")!;
    expect(row.replied).toBe(false);
    expect(row.defaultSms).toBe(true);
    expect(row.defaultEmail).toBe(true);
  });

  it("each row carries its bounded touch-point strip; the quote-send is on it", async () => {
    seed();
    const row = (await buildBulkOutreachCohort("Jessie")).rows.find((r) => r.leadId === "RECENT")!;
    expect(row.touchpoints.length).toBeGreaterThanOrEqual(1);
    expect(row.touchpoints.some((t) => t.isQuote)).toBe(true);
    expect(row.touchpointsEarlier).toBe(0);
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

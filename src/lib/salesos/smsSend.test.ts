// The lead sender applies the thank-you line rule at send time, with the number's real history from the
// message log and the OpenPhone synced timeline. The provider is MOCKED: no real text is ever sent.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { getDb } from "@/lib/db";
import { saveBookings, insertCommsEventIfNew, insertMessage } from "@/lib/db/repo";
import { sendSms } from "@/lib/notify/sms";
import { SMS_SIGNOFF } from "@/lib/comms/smsSignoff";
import { sendLeadSms } from "./smsSend";

vi.mock("@/lib/notify/sms", () => ({
  sendSms: vi.fn(async () => ({ ok: true, providerMsgId: "PM-test" })),
}));
const sendSmsMock = sendSms as unknown as Mock;

const minsAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
  sendSmsMock.mockClear();
  getDb().prepare("DELETE FROM bookings").run();
  getDb().prepare("DELETE FROM comms_events").run();
  getDb().prepare("DELETE FROM messages").run();
  process.env.SMS_SEND_ENABLED = "true";
  // The phone on file is in a different format from the OpenPhone timeline on purpose.
  saveBookings([{ bookingId: "L1", eventName: "Test Party", eventDate: "2099-06-01", statusLabel: "Quote Sent", signed: false, grandTotal: 1000, clientName: "Pat Test", clientPhone: "(301) 555-1234" }]);
});
afterEach(() => {
  delete process.env.SMS_SEND_ENABLED;
  delete process.env.SMS_SIGNOFF;
});

const sentBody = (): string => sendSmsMock.mock.calls[0][1] as string;
const inbound = (m: number): void => {
  insertCommsEventIfNew({ providerId: `in-${m}`, leadId: "L1", direction: "inbound", channel: "sms", fromPhone: "+13015551234", toPhone: "+12025550000", body: "Sounds good", occurredAt: minsAgo(m) });
};

describe("sendLeadSms and the thank-you line", () => {
  it("a follow up on a quiet thread gets the line", async () => {
    const r = await sendLeadSms({ id: "L1", body: "Hi Pat, just checking in on your quote." });
    expect(r.ok).toBe(true);
    expect(r.signoff).toBe(true);
    expect(sentBody()).toBe(`Hi Pat, just checking in on your quote. ${SMS_SIGNOFF}`);
  });

  it("a text in a live back and forth goes without it, even from a draft that had it", async () => {
    inbound(30);
    const r = await sendLeadSms({ id: "L1", body: `Great, see you then. ${SMS_SIGNOFF}` });
    expect(r.signoff).toBe(false);
    expect(sentBody()).toBe("Great, see you then.");
  });

  it("never twice in one day: a line already sent today keeps it off even an opener", async () => {
    insertMessage({ channel: "sms", provider: "openphone", toPhone: "(301) 555-1234", body: `Hi Pat. ${SMS_SIGNOFF}`, status: "sent" });
    await sendLeadSms({ id: "L1", body: "Here is your updated quote.", occasion: "start" });
    expect(sentBody()).toBe("Here is your updated quote.");
  });

  it("dispatch texts and failed sends do not count as our sales texts", async () => {
    insertMessage({ stopId: "S1", channel: "sms", provider: "openphone", toPhone: "+13015551234", body: "Your delivery is on the way.", status: "sent" });
    insertMessage({ channel: "sms", provider: "openphone", toPhone: "+13015551234", body: `Hi. ${SMS_SIGNOFF}`, status: "failed" });
    await sendLeadSms({ id: "L1", body: "Checking in on your quote." });
    expect(sentBody()).toBe(`Checking in on your quote. ${SMS_SIGNOFF}`);
  });

  it("an opener (call wrap up, quote send) gets it even right after a text", async () => {
    inbound(10);
    await sendLeadSms({ id: "L1", body: "Here is your quote.", occasion: "start" });
    expect(sentBody()).toBe(`Here is your quote. ${SMS_SIGNOFF}`);
  });

  it("a quick reply never gets it", async () => {
    await sendLeadSms({ id: "L1", body: "Yes, 3pm works.", occasion: "reply" });
    expect(sentBody()).toBe("Yes, 3pm works.");
  });

  it("a double click does not text twice, though the second try would drop the line", async () => {
    const first = await sendLeadSms({ id: "L1", body: "Hi Pat, checking in." });
    expect(first.signoff).toBe(true);
    const second = await sendLeadSms({ id: "L1", body: "Hi Pat, checking in." });
    expect(second).toEqual({ ok: true, duplicate: true });
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
  });

  it("the kill switch sends the text as written", async () => {
    process.env.SMS_SIGNOFF = "false";
    await sendLeadSms({ id: "L1", body: "Hi Pat." });
    expect(sentBody()).toBe("Hi Pat.");
  });
});

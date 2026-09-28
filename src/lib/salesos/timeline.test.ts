import { describe, expect, it } from "vitest";
import { buildLeadTimeline, timelineLastActivity, timelineLastOutbound } from "./timeline";
import { saveBookings, saveLeadNotes, insertCommsEventIfNew, insertCallEventIfNew, saveEmailEvents } from "@/lib/db/repo";

// DATABASE_PATH is ":memory:" (vitest.config.ts). Unique ids keep tests isolated in the shared DB.

describe("buildLeadTimeline", () => {
  it("merges every stored source newest-first, dedupes, keeps facts, and never invents", () => {
    const id = "TL-merge-1";
    saveBookings([{ bookingId: id, eventName: "Dixon · Wedding", clientName: "Ivy Dixon", clientPhone: "301-555-1234", eventDate: "2030-06-20", signed: false }]);
    saveLeadNotes([{ bookingId: id, quoteSentAt: "2027-03-01T10:00:00.000Z", quoteOpenedAt: "2027-03-02T10:00:00.000Z", internalNotes: "some header line\nHG - 3/1 - Called, left VM" }]);
    insertCommsEventIfNew({ providerId: "sms-out-1", leadId: id, direction: "outbound", channel: "sms", body: "Following up on your quote", actor: "HG", occurredAt: "2027-03-03T10:00:00.000Z" });
    insertCommsEventIfNew({ providerId: "sms-in-1", leadId: id, direction: "inbound", channel: "sms", body: "Looks good, thanks", occurredAt: "2027-03-04T10:00:00.000Z" });
    insertCallEventIfNew({ providerId: "op-call-1", direction: "incoming", fromPhone: "+13015551234", toPhone: "+13019999999", durationSec: 0, occurredAt: "2027-03-05T09:00:00.000Z" });
    saveEmailEvents([{ providerMsgId: "gs-msg-1", bookingId: id, direction: "outbound", subject: "Your quote", snippet: "Here is your quote", occurredAt: "2027-02-28T10:00:00.000Z" }]);

    const tl = buildLeadTimeline(id);
    const dated = tl.filter((e) => e.at != null);
    const undated = tl.filter((e) => e.at == null);

    // Dated entries strictly newest-first.
    const times = dated.map((e) => Date.parse(e.at as string));
    expect(times).toEqual([...times].sort((a, b) => b - a));

    // Newest dated entry is the incoming voicemail (call), oldest is the outbound email.
    expect(dated[0].channel).toBe("call");
    expect(dated[0].direction).toBe("in");
    expect(dated[0].title.toLowerCase()).toContain("voicemail");
    expect(dated[dated.length - 1].channel).toBe("email");

    // All six channels present exactly once each for the dated set (quote emitted from quoteSentAt/opened).
    const channels = dated.map((e) => e.channel);
    expect(channels).toContain("sms");
    expect(channels).toContain("call");
    expect(channels).toContain("email");
    expect(channels).toContain("quote");

    // Last activity = newest overall (the inbound call). Last outbound = newest OUT entry (the text).
    expect(timelineLastActivity(tl)?.channel).toBe("call");
    const out = timelineLastOutbound(tl);
    expect(out?.channel).toBe("sms");
    expect(out?.direction).toBe("out");

    // The one dated internal-note line is kept UNDATED with its date token exactly as written.
    expect(undated).toHaveLength(1);
    expect(undated[0].channel).toBe("note");
    expect(undated[0].at).toBeNull();
    expect(undated[0].rawDate).toBe("3/1");
  });

  it("de-duplicates a call present in both comms_events and call_events (by provider id)", () => {
    const id = "TL-dedupe-1";
    saveBookings([{ bookingId: id, eventName: "Nunez", clientName: "Ana Nunez", clientPhone: "2025550000", eventDate: "2030-07-01", signed: false }]);
    insertCommsEventIfNew({ providerId: "shared-call-9", leadId: id, direction: "inbound", channel: "call", body: "Inbound call", occurredAt: "2027-04-01T10:00:00.000Z" });
    insertCallEventIfNew({ providerId: "shared-call-9", direction: "incoming", fromPhone: "+12025550000", toPhone: "+12021110000", occurredAt: "2027-04-01T10:00:00.000Z" });
    const calls = buildLeadTimeline(id).filter((e) => e.channel === "call");
    expect(calls).toHaveLength(1);
  });

  it("returns an empty timeline for an unknown booking (no fabrication)", () => {
    expect(buildLeadTimeline("TL-does-not-exist")).toEqual([]);
  });
});

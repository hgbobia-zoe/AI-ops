import { describe, expect, it } from "vitest";
import { buildLeadTimeline, timelineLastActivity, timelineLastOutbound, leadTouchSummary, shapeTouchpoints, leadTouchContext, lastThreadMessage, lastThreadMessageForLead } from "./timeline";
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

describe("leadTouchSummary — cockpit last-touch + recently-contacted signal", () => {
  it("newest dated entry is the last touch; newest dated outbound feeds the recently-contacted guard", () => {
    const id = "LT-dated-1";
    saveBookings([{ bookingId: id, eventName: "A", clientName: "A", clientPhone: "301-555-7777", eventDate: "2030-01-01", signed: false }]);
    insertCommsEventIfNew({ providerId: "lt-out", leadId: id, direction: "outbound", channel: "sms", body: "we reached out", actor: "HG", occurredAt: "2027-05-01T10:00:00.000Z" });
    insertCommsEventIfNew({ providerId: "lt-in", leadId: id, direction: "inbound", channel: "sms", body: "they replied", occurredAt: "2027-05-02T10:00:00.000Z" });
    const s = leadTouchSummary(id);
    expect(s.lastTouch?.whenIso).toBe("2027-05-02T10:00:00.000Z"); // newest of any direction (inbound)
    expect(s.lastTouch?.what).toBe("Inbound text");
    expect(s.lastOutboundAt).toBe("2027-05-01T10:00:00.000Z"); // newest OUT only
  });

  it("a quote-send alone counts as a real last touch AND an outbound touch (never 'none logged')", () => {
    const id = "LT-quote-1";
    saveBookings([{ bookingId: id, eventName: "Q", clientName: "Q", eventDate: "2030-01-01", signed: false }]);
    saveLeadNotes([{ bookingId: id, quoteSentAt: "2027-06-01T12:00:00.000Z" }]);
    const s = leadTouchSummary(id);
    expect(s.lastTouch).not.toBeNull();
    expect(s.lastTouch?.what.toLowerCase()).toContain("quote");
    expect(s.lastOutboundAt).toBe("2027-06-01T12:00:00.000Z");
  });

  it("falls back to an UNDATED internal-note touch when there is no dated activity (honest, whenIso null)", () => {
    const id = "LT-note-1";
    saveBookings([{ bookingId: id, eventName: "N", clientName: "N", eventDate: "2030-01-01", signed: false }]);
    saveLeadNotes([{ bookingId: id, internalNotes: "HG - 9/6 - first call\nHG - 9/7 - second call" }]);
    const s = leadTouchSummary(id);
    expect(s.lastTouch).not.toBeNull();
    expect(s.lastTouch?.what).toBe("Logged note");
    expect(s.lastTouch?.whenIso).toBeNull(); // undated — we never fabricate an instant
    expect(s.lastTouch?.rawDate).toBe("9/7"); // the most recently WRITTEN note's date token, as written
    expect(s.lastOutboundAt).toBeNull(); // undated notes never trip the recently-contacted guard
  });

  it("a genuinely empty lead honestly has no last touch and no outbound signal", () => {
    const id = "LT-empty-1";
    saveBookings([{ bookingId: id, eventName: "E", clientName: "E", eventDate: "2030-01-01", signed: false }]);
    const s = leadTouchSummary(id);
    expect(s.lastTouch).toBeNull();
    expect(s.lastOutboundAt).toBeNull();
  });
});

describe("shapeTouchpoints — bounded, chronological, facts-only strip", () => {
  it("returns entries OLDEST → NEWEST, mapping channel/direction/date/preview faithfully", () => {
    const id = "TP-order-1";
    saveBookings([{ bookingId: id, eventName: "Dixon", clientName: "Ivy", clientPhone: "301-555-1234", eventDate: "2030-06-20", signed: false }]);
    saveLeadNotes([{ bookingId: id, quoteSentAt: "2027-03-01T10:00:00.000Z" }]);
    insertCommsEventIfNew({ providerId: "sms-out-9", leadId: id, direction: "outbound", channel: "sms", body: "Following up", actor: "HG", occurredAt: "2027-03-03T10:00:00.000Z" });
    insertCommsEventIfNew({ providerId: "sms-in-9", leadId: id, direction: "inbound", channel: "sms", body: "Looks good", occurredAt: "2027-03-04T10:00:00.000Z" });

    const { touchpoints, earlier } = shapeTouchpoints(buildLeadTimeline(id));
    expect(earlier).toBe(0);
    // Oldest first: quote-send (3/1) → outbound text (3/3) → inbound text (3/4).
    expect(touchpoints.map((t) => t.iso)).toEqual([...touchpoints.map((t) => t.iso)].sort());
    expect(touchpoints[0].isQuote).toBe(true);
    expect(touchpoints[0].channel).toBe("quote");
    expect(touchpoints[0].direction).toBe("out");
    const inbound = touchpoints.find((t) => t.direction === "in")!;
    expect(inbound.channel).toBe("sms");
    expect(inbound.preview).toBe("Looks good");
  });

  it("caps to the most recent `limit` dated touches and reports the rest as `earlier`", () => {
    const id = "TP-cap-1";
    saveBookings([{ bookingId: id, eventName: "Busy", clientName: "B", clientPhone: "301-555-7777", eventDate: "2030-06-20", signed: false }]);
    for (let d = 1; d <= 8; d++) {
      insertCommsEventIfNew({ providerId: `sms-${d}`, leadId: id, direction: "outbound", channel: "sms", body: `msg ${d}`, occurredAt: `2027-03-0${d}T10:00:00.000Z` });
    }
    const { touchpoints, earlier } = shapeTouchpoints(buildLeadTimeline(id), 5);
    expect(touchpoints).toHaveLength(5);
    expect(earlier).toBe(3); // 8 dated touches, 5 shown
    // The LAST (rightmost) is the newest (3/8); the first shown is 3/4.
    expect(touchpoints[touchpoints.length - 1].iso).toContain("2027-03-08");
    expect(touchpoints[0].iso).toContain("2027-03-04");
  });

  it("an empty timeline → empty array (the honest 'no activity yet' state)", () => {
    const id = "TP-empty-1";
    saveBookings([{ bookingId: id, eventName: "E", clientName: "E", eventDate: "2030-01-01", signed: false }]);
    expect(shapeTouchpoints(buildLeadTimeline(id)).touchpoints).toEqual([]);
    expect(leadTouchContext(id).touchpoints).toEqual([]);
  });

  it("undated note lines carry their written token and stay at the LEFT (never a fabricated instant)", () => {
    const id = "TP-undated-1";
    saveBookings([{ bookingId: id, eventName: "N", clientName: "N", eventDate: "2030-01-01", signed: false }]);
    saveLeadNotes([{ bookingId: id, quoteSentAt: "2027-03-01T10:00:00.000Z", internalNotes: "HG - 9/7 - left a message" }]);
    const { touchpoints } = shapeTouchpoints(buildLeadTimeline(id));
    const note = touchpoints.find((t) => t.channel === "note")!;
    expect(note.iso).toBeNull();
    expect(note.dateToken).toBe("9/7");
    expect(touchpoints[0].channel).toBe("note"); // undated note kept at the left of the strip
    expect(touchpoints[touchpoints.length - 1].iso).not.toBeNull(); // the dated quote sits to its right
  });
});

describe("lastThreadMessage", () => {
  it("picks the newest DATED real communication (either direction), with who/when/channel/snippet", () => {
    const id = "LM-newest-1";
    saveBookings([{ bookingId: id, eventName: "Reed · Gala", clientName: "Ada Reed", clientPhone: "301-555-7788", eventDate: "2030-09-01", signed: false }]);
    saveLeadNotes([{ bookingId: id, quoteSentAt: "2027-04-01T10:00:00.000Z", internalNotes: "header" }]);
    insertCommsEventIfNew({ providerId: "lm-sms-out", leadId: id, direction: "outbound", channel: "sms", body: "Just following up", actor: "HG", occurredAt: "2027-04-02T10:00:00.000Z" });
    insertCommsEventIfNew({ providerId: "lm-sms-in", leadId: id, direction: "inbound", channel: "sms", body: "We need to check with my husband first, can you give us a few days", occurredAt: "2027-04-05T14:00:00.000Z" });

    const lm = lastThreadMessage(buildLeadTimeline(id));
    expect(lm).not.toBeNull();
    expect(lm!.channel).toBe("sms");
    expect(lm!.direction).toBe("in"); // the inbound text is the most recent
    expect(lm!.snippet).toContain("husband");
    expect(lm!.at).toBe("2027-04-05T14:00:00.000Z");
  });

  it("excludes internal system/audit entries; falls back to the most recently WRITTEN undated note", () => {
    const id = "LM-note-1";
    saveBookings([{ bookingId: id, eventName: "N", clientName: "Ned Flint", eventDate: "2030-01-01", signed: false }]);
    saveLeadNotes([{ bookingId: id, internalNotes: "HG - 9/1 - first call\nHG - 9/7 - left a voicemail" }]);
    const lm = lastThreadMessage(buildLeadTimeline(id));
    expect(lm).not.toBeNull();
    expect(lm!.channel).toBe("note");
    expect(lm!.at).toBeNull();
    expect(lm!.rawDate).toBe("9/7"); // the most recently written note
    expect(lm!.snippet).toContain("voicemail");
  });

  it("returns null for a genuinely empty thread (honest 'no prior message', never fabricated)", () => {
    const id = "LM-empty-1";
    saveBookings([{ bookingId: id, eventName: "E", clientName: "E", eventDate: "2030-01-01", signed: false }]);
    expect(lastThreadMessage(buildLeadTimeline(id))).toBeNull();
    expect(lastThreadMessageForLead(id)).toBeNull();
    expect(lastThreadMessageForLead("LM-does-not-exist")).toBeNull();
  });

  it("prefers a dated communication over an undated note even when the note was written later", () => {
    const id = "LM-prefer-dated-1";
    saveBookings([{ bookingId: id, eventName: "P", clientName: "Pia Vo", clientPhone: "301-555-2200", eventDate: "2030-05-05", signed: false }]);
    saveLeadNotes([{ bookingId: id, internalNotes: "HG - 9/9 - undated note line" }]);
    insertCommsEventIfNew({ providerId: "lm-sms-pref", leadId: id, direction: "inbound", channel: "sms", body: "Can you resend the quote?", occurredAt: "2027-05-01T10:00:00.000Z" });
    const lm = lastThreadMessageForLead(id);
    expect(lm!.channel).toBe("sms"); // dated comm wins over the undated note
    expect(lm!.snippet).toContain("resend");
  });
});

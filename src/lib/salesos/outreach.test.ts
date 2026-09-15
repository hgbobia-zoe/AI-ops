import { describe, it, expect } from "vitest";
import { summarizeComms, templateOutreach, humanize, type OutreachLead } from "./outreach";

const GRADY_NOTES = `8/28 - JM SENT THE QUOTE

8/29 - JM MADE A FOLLOW-UP CALL - NO RESPONSE - SENT A MESSAGE - AN EMAIL

9/1 - JM MADE A FOLLOW-UP CALL - NO RESPONSE - LEAVE A VOICEMAIL - SENT AN EMAIL

9/2 - JM SENT A FOLLOW-UP MESSAGE & EMAIL

9/8 - JM MADE A FOLLOW-UP CALL - NO RESPONSE - LEAVE A VOICEMAIL - SENT A MESSAGE`;

describe("outreach — summarizeComms", () => {
  it("counts dated attempts, spots channels, and flags a no-response streak", () => {
    const c = summarizeComms(GRADY_NOTES, "DEVIN IS ON PATERNITY LEAVE");
    expect(c.attempts).toBe(5);
    expect(c.lastContact).toBe("9/8");
    expect(c.channels).toEqual(expect.arrayContaining(["call", "text", "email", "voicemail"]));
    expect(c.noResponse).toBe(true);
    expect(c.clientContext).toBe("DEVIN IS ON PATERNITY LEAVE");
  });

  it("is empty and honest when there are no notes", () => {
    const c = summarizeComms(null, null);
    expect(c.attempts).toBe(0);
    expect(c.lastContact).toBeNull();
    expect(c.channels).toEqual([]);
    expect(c.noResponse).toBe(false);
  });
});

const lead = (stage: OutreachLead["stage"]): OutreachLead => ({
  firstName: "Devin Grady",
  eventName: "UDC Banquet",
  eventDateLong: "Saturday, Sep 20",
  daysToEvent: 6,
  stage,
});

describe("outreach — templateOutreach", () => {
  it("uses the first name and the event DATE (never the internal project name) in the message", () => {
    const d = templateOutreach(lead("follow_up"), summarizeComms(null, null));
    expect(d.sms).toContain("Devin");
    // Customer-facing copy references the date, not the internal project name.
    expect(d.sms).toContain("your event on Saturday, Sep 20");
    expect(d.sms).not.toContain("UDC Banquet");
    expect(d.source).toBe("template");
  });

  it("surfaces a client-context caution when one exists", () => {
    const d = templateOutreach(lead("cold"), summarizeComms(GRADY_NOTES, "DEVIN IS ON PATERNITY LEAVE"));
    expect(d.caution).toMatch(/paternity leave/i);
  });

  it("warns to change approach after many unanswered attempts (no client note)", () => {
    const d = templateOutreach(lead("cold"), summarizeComms(GRADY_NOTES, null));
    expect(d.caution).toMatch(/different approach/i);
  });

  it("an unsent lead is told to send the quote now", () => {
    const d = templateOutreach(lead("unsent"), summarizeComms(null, null));
    expect(d.cadence).toMatch(/now/i);
    expect(d.callStrategy).toMatch(/send the quote/i);
  });

  it("no template text contains an em or en dash (reads like a person, not a brochure)", () => {
    const stages = ["unsent", "awaiting", "follow_up", "cold", "closing"] as const;
    for (const s of stages) {
      const d = templateOutreach(lead(s), summarizeComms(GRADY_NOTES, "DEVIN IS ON PATERNITY LEAVE"));
      for (const text of [d.sms, d.callStrategy, d.cadence, d.caution ?? ""]) {
        expect(text).not.toMatch(/[—–]/);
      }
    }
  });
});

describe("outreach — humanize", () => {
  it("replaces em dashes with commas and number ranges with 'to'", () => {
    expect(humanize("Zoe Events — your quote is ready")).toBe("Zoe Events, your quote is ready");
    expect(humanize("Give it 2–3 days")).toBe("Give it 2 to 3 days");
    expect(humanize("plain text stays put")).toBe("plain text stays put");
    expect(humanize("a — b – c")).toBe("a, b, c");
  });
});

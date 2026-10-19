import { describe, it, expect } from "vitest";
import { summarizeComms, templateOutreach, humanize, stripSignOff, renderConversationContext, type ConversationEntry, type OutreachLead } from "./outreach";

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

describe("outreach — renderConversationContext (the full two-way picture for the drafter)", () => {
  // The real "Nelson" shape: customer said she needs to decide WITH HER HUSBAND, plus the Oct 17 call.
  // Newest-first, as buildLeadTimeline returns.
  const NELSON: ConversationEntry[] = [
    { at: "2026-10-17T15:00:00Z", channel: "call", direction: "out", title: "Call to client", detail: "Jessie Medalla from Zoe spoke with Melissa. Melissa will talk to her husband tomorrow to come up with a plan." },
    { at: "2026-10-16T18:30:00Z", channel: "sms", direction: "in", title: "Text from client", detail: "I need to go through the details with my husband, he's travelling, I'll get back to you in a day or so." },
    { at: "2026-10-14T12:00:00Z", channel: "email", direction: "out", title: "Email sent: Your quote", detail: "Here is your quote for the event." },
    { at: "2026-10-14T11:00:00Z", channel: "quote", direction: "out", title: "Quote emailed" }, // excluded (not something the customer said)
    { at: null, channel: "note", direction: null, title: "Logged note", detail: "10/16 husband travelling, will decide together" }, // excluded (notes pass separately)
  ];

  it("includes both directions, the call summary, and surfaces the customer's latest inbound statement", () => {
    const c = renderConversationContext(NELSON);
    expect(c.hasInbound).toBe(true);
    // The customer's own words are captured verbatim as the latest inbound.
    expect(c.latestInbound).toMatch(/husband/i);
    expect(c.latestInbound).toMatch(/travelling/i);
    // The thread carries the inbound text, the outbound call summary, and the outbound email.
    expect(c.thread).toMatch(/Customer text: I need to go through the details with my husband/);
    expect(c.thread).toMatch(/Zoe call: .*talk to her husband/);
    expect(c.thread).toMatch(/Zoe email:/);
    // Internal notes and quote milestones are NOT part of the two-way conversation block.
    expect(c.thread).not.toMatch(/Logged note/);
    expect(c.thread).not.toMatch(/Quote emailed/);
  });

  it("a genuinely comparing customer's words are carried through (comparison is real, not invented)", () => {
    const c = renderConversationContext([
      { at: "2026-10-10T10:00:00Z", channel: "sms", direction: "in", title: "Text from client", detail: "Still comparing a few rental companies, can you beat this other quote?" },
    ]);
    expect(c.latestInbound).toMatch(/comparing a few rental companies/i);
    expect(c.thread).toMatch(/Customer text: Still comparing/);
  });

  it("is empty and honest when nothing was captured (drafter then writes a neutral follow-up)", () => {
    const c = renderConversationContext([]);
    expect(c.thread).toBe("");
    expect(c.latestInbound).toBeNull();
    expect(c.hasInbound).toBe(false);
  });

  it("never asserts a sender it doesn't know, and falls back to the factual title with no body", () => {
    const c = renderConversationContext([
      { at: "2026-10-12T10:00:00Z", channel: "call", direction: "in", title: "Voicemail from client", detail: null },
      { at: "2026-10-11T10:00:00Z", channel: "email", direction: null, title: "Email: re quote", detail: "hello" },
    ]);
    expect(c.thread).toMatch(/Customer call: Voicemail from client/); // title fallback, no fabricated body
    expect(c.thread).toMatch(/Unknown sender email: hello/); // direction unknown is not asserted as in/out
    expect(c.latestInbound).toBeNull(); // the inbound voicemail had no captured body
  });

  it("caps the number of entries", () => {
    const many: ConversationEntry[] = Array.from({ length: 40 }, (_, i) => ({
      at: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`,
      channel: "sms" as const,
      direction: "out" as const,
      title: "Text to client",
      detail: `message ${i}`,
    }));
    const c = renderConversationContext(many, { maxEntries: 5 });
    expect(c.thread.split("\n").length).toBe(5);
  });
});

describe("outreach — humanize (house voice: no dashes, no emoji)", () => {
  it("turns em/en dashes into commas", () => {
    expect(humanize("it's Zoe Events — happy to help")).toBe("it's Zoe Events, happy to help");
    expect(humanize("quote is in your inbox – I'd love to help")).toBe("quote is in your inbox, I'd love to help");
  });
  it("turns a spaced hyphen used as a dash into a comma but leaves word hyphens alone", () => {
    expect(humanize("sent your quote over - happy to walk through the follow-up")).toBe("sent your quote over, happy to walk through the follow-up");
  });
  it("converts number ranges to 'to'", () => {
    expect(humanize("give it 2–3 days")).toBe("give it 2 to 3 days");
  });
  it("strips emojis", () => {
    expect(humanize("Thanks so much 😊🎉 talk soon")).toBe("Thanks so much talk soon");
  });
  it("preserves newlines (email bodies keep their shape)", () => {
    expect(humanize("Hi Devin,\n\nYour quote — is ready.\n\nBest,\nZoe Events")).toBe("Hi Devin,\n\nYour quote, is ready.\n\nBest,\nZoe Events");
  });
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

  it("introduces the rep by name when one is provided", () => {
    const d = templateOutreach({ ...lead("unsent"), repFirstName: "Sarah" }, summarizeComms(null, null));
    expect(d.sms.startsWith("Hi Devin, this is Sarah from Zoe Events.")).toBe(true);
  });

  it("falls back to the company intro when no rep name is known", () => {
    const d = templateOutreach(lead("unsent"), summarizeComms(null, null));
    expect(d.sms).toContain("it's Zoe Events & Party Rentals");
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

describe("outreach — stripSignOff (email bodies, Goodshuffle appends the real signature)", () => {
  const GREETING = "Hi Ivy,";
  const BODY = "Following up on your event on Saturday, Sep 20. Happy to answer any questions whenever you're ready.";

  it("removes the real-world 'Best,\\nZoe Events' closing while keeping the greeting and body", () => {
    const out = stripSignOff(`${GREETING}\n\n${BODY}\n\nBest,\nZoe Events`);
    expect(out).toBe(`${GREETING}\n\n${BODY}`);
    expect(out.startsWith("Hi Ivy,")).toBe(true);
    expect(out).not.toMatch(/Best,/);
    expect(out).not.toMatch(/\bZoe Events\b/);
  });

  it("removes assorted closing words with a name/company tail", () => {
    for (const close of ["Best,", "Thanks,", "Thank you,", "Sincerely,", "Warm regards,", "Best regards,", "Kind regards,", "Regards,", "Cheers,", "Talk soon,"]) {
      const out = stripSignOff(`${GREETING}\n${BODY}\n${close}\nSarah\nZoe Events`);
      expect(out).toBe(`${GREETING}\n${BODY}`);
    }
  });

  it("removes a closing word even with only a name line after it (no company)", () => {
    expect(stripSignOff(`${GREETING}\n${BODY}\nThanks,\nSarah`)).toBe(`${GREETING}\n${BODY}`);
  });

  it("removes a bare trailing company line with no closing word, with or without a leading dash", () => {
    expect(stripSignOff(`${GREETING}\n${BODY}\nZoe Events`)).toBe(`${GREETING}\n${BODY}`);
    expect(stripSignOff(`${GREETING}\n${BODY}\n- Zoe Events`)).toBe(`${GREETING}\n${BODY}`);
    expect(stripSignOff(`${GREETING}\n${BODY}\nZoe Events & Party Rentals`)).toBe(`${GREETING}\n${BODY}`);
  });

  it("keeps the greeting and never eats an inline company mention in the body", () => {
    // The opening identifies the rep/company inline; that must survive (only trailing sign-offs go).
    const body = "Hi Devin, this is Sarah from Zoe Events. Your quote for your event on Sep 20 is ready to go.";
    expect(stripSignOff(body)).toBe(body);
  });

  it("leaves a body with no sign-off completely intact", () => {
    expect(stripSignOff(`${GREETING}\n${BODY}`)).toBe(`${GREETING}\n${BODY}`);
  });

  it("does not strip a real sentence that merely starts with a closing word", () => {
    const body = `${GREETING}\nThanks so much for considering Zoe Events for your celebration.`;
    expect(stripSignOff(body)).toBe(body);
  });

  it("is idempotent", () => {
    const once = stripSignOff(`${GREETING}\n${BODY}\n\nBest,\nZoe Events`);
    expect(stripSignOff(once)).toBe(once);
  });

  it("handles empty / whitespace input safely", () => {
    expect(stripSignOff("")).toBe("");
    expect(stripSignOff("   ")).toBe("");
  });
});

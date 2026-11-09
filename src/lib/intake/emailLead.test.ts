import { describe, expect, it } from "vitest";
import { parseInboundEmail, ruleVerdict, newText, phoneIn, leadInputFromEmail, type InboundEmail } from "./emailLead";

const mail = (over: Partial<InboundEmail> = {}): InboundEmail => ({
  fromEmail: "dana.whit@gmail.com",
  fromName: "Dana Whit",
  subject: "Tent and chairs for a backyard party",
  body: "Hi! We are having a birthday party on June 14 for about 80 guests in Bethesda. Could I get a quote for a tent, tables and chairs, with delivery? Thanks, Dana 240-555-0182",
  messageId: "m1",
  threadId: "t1",
  headers: {},
  labels: ["INBOX", "CATEGORY_PERSONAL"],
  ...over,
});

describe("parseInboundEmail", () => {
  it("reads the Gmail trigger's nested output", () => {
    const e = parseInboundEmail({
      message_id: "18c1",
      thread_id: "18c0",
      labels: ["INBOX", "UNREAD"],
      from: { name: "Dana Whit", email: "Dana.Whit@Gmail.com" },
      to: [{ email: "hello@zoeeventsdmv.com" }],
      subject: "Quote please",
      body_plain: "Need 10 tables for Oct 3.\n\nOn Mon, Nov 9, 2026 at 9:00 AM Zoe <hello@zoeeventsdmv.com> wrote:\n> old text",
    });
    expect(e).toMatchObject({ fromEmail: "dana.whit@gmail.com", fromName: "Dana Whit", subject: "Quote please", body: "Need 10 tables for Oct 3.", messageId: "18c1", threadId: "18c0" });
    expect(e.labels).toContain("UNREAD");
  });

  it("reads a flat \"Name <email>\" sender, Zapier's __ keys and a headers array", () => {
    const e = parseInboundEmail({
      from: '"Sam Lee" <sam@lee-events.com>',
      subject: "Hello",
      body_html: "<p>Do you rent <b>lounge</b> furniture?</p>",
      raw__payload__headers: [{ name: "List-Unsubscribe", value: "<mailto:x>" }, { name: "Subject", value: "Hello" }],
    });
    expect(e.fromEmail).toBe("sam@lee-events.com");
    expect(e.fromName).toBe("Sam Lee");
    expect(e.body).toContain("Do you rent lounge furniture?");
    expect(e.headers["list-unsubscribe"]).toBe("<mailto:x>");
  });
});

describe("newText", () => {
  it("keeps only the new words", () => {
    expect(newText("Yes please.\nSent from my iPhone\n\nOn Tue wrote: blah")).toBe("Yes please.");
    expect(newText("Thanks\n---------- Forwarded message ---------\nFrom: x")).toBe("Thanks");
    expect(newText("Hi\n> quoted\nMore")).toBe("Hi\nMore");
  });
});

describe("ruleVerdict (the free checks)", () => {
  it("passes a clear rental inquiry as a lead", () => {
    const v = ruleVerdict(mail());
    expect(v.decision).toBe("lead");
  });

  it.each([
    ["own domain", mail({ fromEmail: "jessie@zoeeventsdmv.com" }), "own_address"],
    ["platform", mail({ fromEmail: "no-reply@messaging.yelp.com" }), "other_channel"],
    ["goodshuffle", mail({ fromEmail: "notifications@goodshuffle.com" }), "other_channel"],
    ["noreply", mail({ fromEmail: "noreply@someshop.com" }), "automated"],
    ["newsletter headers", mail({ fromEmail: "deals@partyshop.com", headers: { "list-unsubscribe": "<mailto:u>" } }), "automated"],
    ["auto reply header", mail({ fromEmail: "pat@corp.com", headers: { "auto-submitted": "auto-replied" } }), "automated"],
    ["promotions tab", mail({ fromEmail: "deals@partyshop.com", labels: ["CATEGORY_PROMOTIONS"] }), "automated"],
    ["reply subject", mail({ subject: "Re: Your quote from Zoe" }), "reply"],
    ["reply header", mail({ headers: { "in-reply-to": "<abc@mail>" } }), "reply"],
    ["out of office", mail({ fromEmail: "pat@corp.com", subject: "Out of office until Monday", body: "I am away." }), "automated"],
    ["seo pitch", mail({ fromEmail: "mike@growthrank.io", subject: "Rank #1 on Google", body: "We offer SEO and backlinks to rank higher. Our agency provides marketing services." }), "not_a_lead"],
    ["job seeker", mail({ fromEmail: "kim@gmail.com", subject: "Job application", body: "Attached is my resume for any open positions." }), "not_a_lead"],
    ["no sender", mail({ fromEmail: "" }), "no_sender"],
  ])("skips %s", (_label, e, reason) => {
    const v = ruleVerdict(e);
    expect(v).toMatchObject({ decision: "skip", reason });
  });

  it("leaves a vague note for the model or a person", () => {
    expect(ruleVerdict(mail({ subject: "Question", body: "Hi, could someone call me back when you have a minute?" })).decision).toBe("unsure");
  });

  it("our own domain list can be extended", () => {
    process.env.EMAIL_INTAKE_SKIP_DOMAINS = "vendorco.com";
    try {
      expect(ruleVerdict(mail({ fromEmail: "sales@vendorco.com" }))).toMatchObject({ decision: "skip", reason: "other_channel" });
    } finally {
      delete process.env.EMAIL_INTAKE_SKIP_DOMAINS;
    }
  });
});

describe("lead fields", () => {
  it("takes the first phone that is not ours", () => {
    expect(phoneIn("Call us at (301) 291-5296 or me at 240.555.0182")).toBe("2405550182");
    expect(phoneIn("no number here")).toBe("");
  });

  it("builds the intake lead, preferring what the model read and checking it", () => {
    const l = leadInputFromEmail(mail(), { firstName: "Danielle", lastName: "Whitaker", eventDate: "2027-06-14", eventType: "social", guestCount: 80 });
    expect(l).toMatchObject({ source: "email", firstName: "Danielle", lastName: "Whitaker", email: "dana.whit@gmail.com", phone: "2405550182", eventDate: "2027-06-14", guestCount: 80 });
    expect(l.message).toMatch(/^Subject: Tent and chairs/);
    expect(leadInputFromEmail(mail(), { eventDate: "June 14" }).eventDate).toBe(""); // never a guessed date
    expect(leadInputFromEmail(mail()).firstName).toBe("Dana"); // sender name when the model is off
  });
});

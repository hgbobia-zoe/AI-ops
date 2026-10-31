import { describe, expect, it } from "vitest";
import {
  normalizeLead,
  leadValidationError,
  webLeadEventName,
  toIntakePatch,
  buildAckEmail,
} from "./webLead";

// Pure-function layer for the structured web-lead receiver. The route's I/O (record → gate → dedupe →
// enqueue) is covered in src/app/api/intake/lead/route.test.ts; this file pins the normalize / validate /
// map helpers and their edge cases so a source Zap's messy field values never become a wrong project.

describe("normalizeLead", () => {
  it("trims strings and defaults source to 'web'", () => {
    const n = normalizeLead({ firstName: "  Pat  ", lastName: " Smith ", message: "  hi  " });
    expect(n.source).toBe("web");
    expect(n.firstName).toBe("Pat");
    expect(n.lastName).toBe("Smith");
    expect(n.message).toBe("hi");
  });

  it("keeps an explicit source", () => {
    expect(normalizeLead({ source: "yelp" }).source).toBe("yelp");
  });

  it("builds dedupe keys: lowercased email + digits-only phone", () => {
    const n = normalizeLead({ email: "  Pat@Example.COM ", phone: "(555) 000-1234" });
    expect(n.email).toBe("Pat@Example.COM"); // raw (trimmed) preserved for display
    expect(n.emailKey).toBe("pat@example.com");
    expect(n.phone).toBe("(555) 000-1234");
    expect(n.phoneKey).toBe("5550001234");
  });

  it("coerces guest count from a number, a numeric string, and a comma/word string", () => {
    expect(normalizeLead({ guestCount: 120 }).guestCount).toBe(120);
    expect(normalizeLead({ guestCount: "150" }).guestCount).toBe(150);
    expect(normalizeLead({ guestCount: "about 1,200 guests" }).guestCount).toBe(1200);
  });

  it("treats empty / zero / non-numeric guest count as null (unknown)", () => {
    expect(normalizeLead({ guestCount: "" }).guestCount).toBeNull();
    expect(normalizeLead({ guestCount: 0 }).guestCount).toBeNull();
    expect(normalizeLead({ guestCount: "lots" }).guestCount).toBeNull();
    expect(normalizeLead({}).guestCount).toBeNull();
  });

  it("accepts only YYYY-MM-DD dates and drops anything else (never guesses)", () => {
    expect(normalizeLead({ eventDate: "2027-06-20" }).eventDate).toBe("2027-06-20");
    expect(normalizeLead({ eventDate: "06/20/2027" }).eventDate).toBe("");
    expect(normalizeLead({ eventDate: "June 20 2027" }).eventDate).toBe("");
    expect(normalizeLead({ eventDate: "" }).eventDate).toBe("");
  });

  it("maps known event-type buckets and preserves the original for 'other'", () => {
    expect(normalizeLead({ eventType: "Wedding reception" }).eventType).toBe("wedding");
    expect(normalizeLead({ eventType: "Corporate gala" }).eventType).toBe("corporate");
    expect(normalizeLead({ eventType: "Annual conference" }).eventType).toBe("corporate");
    expect(normalizeLead({ eventType: "Birthday party" }).eventType).toBe("social");
    expect(normalizeLead({ eventType: "Baby shower" }).eventType).toBe("social");
    const other = normalizeLead({ eventType: "Film shoot" });
    expect(other.eventType).toBe("other");
    expect(other.eventTypeOther).toBe("Film shoot"); // original text kept verbatim
  });

  it("leaves event type blank when none is given", () => {
    const n = normalizeLead({});
    expect(n.eventType).toBe("");
    expect(n.eventTypeOther).toBe("");
  });

  it("coerces non-string scalars rather than dropping them", () => {
    const n = normalizeLead({ firstName: 42 as unknown, phone: 5550001234 as unknown });
    expect(n.firstName).toBe("42");
    expect(n.phoneKey).toBe("5550001234");
  });
});

describe("leadValidationError", () => {
  it("passes with an email only", () => {
    expect(leadValidationError(normalizeLead({ email: "a@b.com" }))).toBeNull();
  });
  it("passes with a phone only", () => {
    expect(leadValidationError(normalizeLead({ phone: "5550001234" }))).toBeNull();
  });
  it("fails with neither email nor phone", () => {
    expect(leadValidationError(normalizeLead({ firstName: "No", lastName: "Contact" }))).toBe("email_or_phone_required");
  });
  it("fails when a phone has no digits at all", () => {
    expect(leadValidationError(normalizeLead({ phone: "call me" }))).toBe("email_or_phone_required");
  });
});

describe("webLeadEventName", () => {
  it("uses 'LastName - EventTypeLabel'", () => {
    expect(webLeadEventName(normalizeLead({ lastName: "Smith", eventType: "wedding" }))).toBe("Smith - Wedding");
    expect(webLeadEventName(normalizeLead({ lastName: "Jones", eventType: "corporate" }))).toBe("Jones - Corporate");
    expect(webLeadEventName(normalizeLead({ lastName: "Lee", eventType: "birthday" }))).toBe("Lee - Social / Private");
  });
  it("uses the verbatim 'other' type as the label", () => {
    expect(webLeadEventName(normalizeLead({ lastName: "Cruz", eventType: "Film shoot" }))).toBe("Cruz - Film shoot");
  });
  it("labels the form's bare 'other' choice as 'Event' (live: 'Gbobia - other')", () => {
    expect(webLeadEventName(normalizeLead({ lastName: "Gbobia", eventType: "other" }))).toBe("Gbobia - Event");
    expect(webLeadEventName(normalizeLead({ lastName: "Gbobia", eventType: " Other " }))).toBe("Gbobia - Event");
  });
  it("falls back to first name when last name is missing", () => {
    expect(webLeadEventName(normalizeLead({ firstName: "Pat", eventType: "wedding" }))).toBe("Pat - Wedding");
  });
  it("uses just the name when no event type is known", () => {
    expect(webLeadEventName(normalizeLead({ lastName: "Smith" }))).toBe("Smith");
  });
  it("falls back to 'New web lead' when the customer gave no name", () => {
    expect(webLeadEventName(normalizeLead({ email: "a@b.com" }))).toBe("New web lead");
  });
});

describe("toIntakePatch", () => {
  it("maps the normalized lead onto the sales_intake patch (message → salesNotes)", () => {
    const patch = toIntakePatch(
      normalizeLead({ firstName: "Pat", lastName: "Smith", email: "a@b.com", phone: "5550001234", eventType: "wedding", eventDate: "2027-06-20", guestCount: 120, message: "tables + chairs" }),
    );
    expect(patch).toMatchObject({
      firstName: "Pat",
      lastName: "Smith",
      email: "a@b.com",
      phone: "5550001234",
      eventType: "wedding",
      eventTypeOther: "",
      eventDate: "2027-06-20",
      guestCount: 120,
      salesNotes: "tables + chairs",
    });
  });
});

describe("buildAckEmail", () => {
  it("greets by first name and mentions Zoe Events", () => {
    const ack = buildAckEmail(normalizeLead({ firstName: "Pat", email: "a@b.com" }));
    expect(ack.content).toContain("Hi Pat");
    expect(ack.content).toContain("Zoe Events");
    expect(ack.subject).toBe("Thanks for reaching out to Zoe Events");
  });
  it("falls back to 'Hi there' when no first name", () => {
    expect(buildAckEmail(normalizeLead({ email: "a@b.com" })).content).toContain("Hi there");
  });
  it("obeys house comms style: no dashes and no emoji", () => {
    const ack = buildAckEmail(normalizeLead({ firstName: "Pat", email: "a@b.com" }));
    expect(ack.content).not.toMatch(/[—–]/); // em / en dash
    expect(ack.content).not.toMatch(/ - /); // spaced hyphen used as a dash
    expect(ack.content).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u); // emoji
  });
  it("wraps the body in the simple HTML the GS editor produces", () => {
    expect(buildAckEmail(normalizeLead({ firstName: "Pat", email: "a@b.com" })).content).toMatch(/^<div>.*<\/div>$/s);
  });
});

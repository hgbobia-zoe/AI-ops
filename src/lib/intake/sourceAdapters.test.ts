import { describe, expect, it } from "vitest";
import { adaptLeadBody, flattenPayload, fromYelpLead, isYelpLeadPayload, newLeadSlackText, splitName } from "./sourceAdapters";
import { normalizeLead, webLeadEventName } from "./webLead";

// The shape the Yelp Leads trigger hands a webhook step with an empty Data field (made-up values).
const YELP = {
  id: "LEAD123",
  business_id: "BIZ9",
  temporary_email_address: "leadsapi+abc123@messaging.yelp.com",
  temporary_email_address_expiry: "2026-11-27T17:51:05Z",
  temporary_phone_number: "",
  time_created: "2026-10-28T17:51:01+00:00",
  user: { display_name: "Pat Q." },
  project: {
    location: { postal_code: "22203" },
    additional_info: "Wine tasting for 20, need glassware.",
    job_names: ["Party equipment rental"],
    survey_answers: [
      { question_text: "What do you need to rent?", answer_text: ["Bar and beverage service equipment"] },
      { question_text: "Approximately how many people will attend this event?", answer_text: ["1–25"] },
    ],
  },
  business: { name: "Zoe Events & Party Rentals", postal_code: "20852" },
};

describe("flattenPayload", () => {
  it("flattens nested objects and arrays into lowercased __ keys", () => {
    expect(flattenPayload({ A: { b: [1, { C: "x" }] } })).toEqual({ a__b__0: "1", a__b__1__c: "x" });
  });
});

describe("Yelp lead", () => {
  it("is recognized by shape, flat or nested", () => {
    expect(isYelpLeadPayload(YELP)).toBe(true);
    expect(isYelpLeadPayload({ temporary_email_address: "x@y.com" })).toBe(true);
    expect(isYelpLeadPayload({ email: "pat@example.com", firstName: "Pat" })).toBe(false);
  });

  it("maps the relay email, name, answers, ZIP and reply link", () => {
    const { lead, yelp } = fromYelpLead(YELP);
    expect(lead.source).toBe("yelp");
    expect(lead.email).toBe("leadsapi+abc123@messaging.yelp.com");
    expect(lead.firstName).toBe("Pat");
    expect(lead.lastName).toBe("Q.");
    expect(String(lead.message)).toContain("What do you need to rent?: Bar and beverage service equipment");
    expect(String(lead.message)).toContain("ZIP: 22203"); // the customer's ZIP, not the business's
    expect(String(lead.message)).toContain("Wine tasting for 20");
    expect(yelp.replyUrl).toBe("https://biz.yelp.com/leads_center/BIZ9/leads/LEAD123");
    expect(yelp.emailExpiry).toBe("2026-11-27T17:51:05Z");
  });

  it("names the project 'Pat Q. - Yelp' (a bare initial is not a surname)", () => {
    const n = normalizeLead(adaptLeadBody(YELP).input);
    expect(webLeadEventName(n)).toBe("Pat Q. - Yelp");
  });

  it("writes a #new-leads post that carries the email (so the project reply can find it)", () => {
    const { input, yelp } = adaptLeadBody(YELP);
    const text = newLeadSlackText(normalizeLead(input), yelp);
    expect(text).toContain("Name: Pat Q.");
    expect(text).toContain("leadsapi+abc123@messaging.yelp.com");
    expect(text).toContain("Reply in Yelp: https://biz.yelp.com/leads_center/BIZ9/leads/LEAD123");
    // House style for our own wording (the customer's answers, like "1–25", are passed through as written).
    expect(text.split("\n").filter((l) => /^(Name|Email|Reply in Yelp):/.test(l)).join("\n")).not.toMatch(/[—–]/);
  });
});

describe("loose field names (an AI parser's output, or the website Zap)", () => {
  it("maps snake_case and keeps camelCase", () => {
    const { input } = adaptLeadBody({ first_name: "Ann", last_name: "Lee", email_address: "ann@example.com", phone_number: "301-555-0100" }, "google_ads");
    expect(input).toMatchObject({ source: "google_ads", firstName: "Ann", lastName: "Lee", email: "ann@example.com", phone: "301-555-0100" });
    const web = adaptLeadBody({ source: "web_form", firstName: "Bo", email: "bo@example.com" }, "ignored");
    expect(web.input).toMatchObject({ source: "web_form", firstName: "Bo", email: "bo@example.com" });
  });

  it("splits a single name field", () => {
    expect(splitName("Mary Ann Smith")).toEqual({ firstName: "Mary Ann", lastName: "Smith" });
    expect(adaptLeadBody({ name: "Cy Twombly", email: "c@example.com" }).input).toMatchObject({ firstName: "Cy", lastName: "Twombly" });
  });
});

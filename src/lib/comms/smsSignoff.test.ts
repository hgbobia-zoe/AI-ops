import { afterEach, describe, expect, it } from "vitest";
import { SMS_SIGNOFF, hasSmsSignoff, withSmsSignoff } from "./smsSignoff";
import { webLeadSmsText } from "@/lib/intake/webLead";
import { templateOutreach } from "@/lib/salesos/outreach";

afterEach(() => {
  delete process.env.SMS_SIGNOFF;
});

describe("withSmsSignoff", () => {
  it("ends a customer text with the thank-you line", () => {
    expect(withSmsSignoff("Hi Satta, your total is now $800.")).toBe(`Hi Satta, your total is now $800. ${SMS_SIGNOFF}`);
  });

  it("adds a period when the text has no end punctuation", () => {
    expect(withSmsSignoff("Let me know")).toBe(`Let me know. ${SMS_SIGNOFF}`);
  });

  it("never adds it twice, even with different spacing or case", () => {
    const once = withSmsSignoff("Any questions?");
    expect(withSmsSignoff(once)).toBe(once);
    expect(withSmsSignoff("Any questions? thank you  for considering us for your event!")).toBe("Any questions? thank you  for considering us for your event!");
    expect(hasSmsSignoff(once)).toBe(true);
  });

  it("leaves an empty text empty", () => {
    expect(withSmsSignoff("   ")).toBe("");
  });

  it("has a kill switch", () => {
    process.env.SMS_SIGNOFF = "false";
    expect(withSmsSignoff("Hi there.")).toBe("Hi there.");
  });
});

describe("customer texts the app writes", () => {
  it("the automatic web lead text ends with it", () => {
    expect(webLeadSmsText("Dana").endsWith(SMS_SIGNOFF)).toBe(true);
  });

  it("the Sales OS template draft ends with it", () => {
    const d = templateOutreach(
      { firstName: "Dana", eventName: "Whit", eventDateLong: "Saturday, Jun 14", daysToEvent: 200, stage: "QUOTE_SENT" as never, repFirstName: "Jessie" },
      { attempts: 0, lastContact: null, channels: [], noResponse: false, latestNote: null, clientContext: null },
    );
    expect(d.sms.endsWith(SMS_SIGNOFF)).toBe(true);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  SMS_SIGNOFF,
  appendSmsSignoff,
  decideSmsSignoff,
  hasSmsSignoff,
  stripSmsSignoff,
  withSmsSignoff,
  type TextTouch,
} from "./smsSignoff";
import { webLeadSmsText } from "@/lib/intake/webLead";

afterEach(() => {
  delete process.env.SMS_SIGNOFF;
});

const TZ = "America/New_York";
// 2 pm Eastern on a weekday.
const NOW = new Date("2026-11-11T19:00:00Z");
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const text = (direction: TextTouch["direction"], h: number, body = "ok"): TextTouch => ({ direction, channel: "sms", at: hoursAgo(h), body });
const call = (h: number): TextTouch => ({ direction: "outbound", channel: "call", at: hoursAgo(h), body: "Call" });
const ctx = (occasion: "start" | "follow_up" | "reply", history: TextTouch[] = []) => ({ occasion, history, now: NOW, tz: TZ });

describe("appendSmsSignoff / stripSmsSignoff", () => {
  it("ends a text with the thank-you line", () => {
    expect(appendSmsSignoff("Hi Dana, your total is now $800.")).toBe(`Hi Dana, your total is now $800. ${SMS_SIGNOFF}`);
  });

  it("adds a period when the text has no end punctuation", () => {
    expect(appendSmsSignoff("Let me know")).toBe(`Let me know. ${SMS_SIGNOFF}`);
  });

  it("never adds it twice, even with different spacing or case", () => {
    const once = appendSmsSignoff("Any questions?");
    expect(appendSmsSignoff(once)).toBe(once);
    expect(appendSmsSignoff("Any questions? thank you  for considering us for your event!")).toBe("Any questions? thank you  for considering us for your event!");
    expect(hasSmsSignoff(once)).toBe(true);
  });

  it("takes the line out, however it was typed", () => {
    expect(stripSmsSignoff(`Any questions? ${SMS_SIGNOFF}`)).toBe("Any questions?");
    expect(stripSmsSignoff("Sounds good. thank you  for considering us for your event!")).toBe("Sounds good.");
    expect(stripSmsSignoff("Sounds good.")).toBe("Sounds good.");
  });

  it("leaves an empty text empty", () => {
    expect(appendSmsSignoff("   ")).toBe("");
    expect(withSmsSignoff("   ", ctx("start"))).toBe("");
  });
});

describe("decideSmsSignoff: the owner rule", () => {
  it("a conversation opener gets it", () => {
    expect(decideSmsSignoff(ctx("start"))).toEqual({ add: true, reason: "start" });
  });

  it("an opener still gets it right after other texts (a call wrap up or a quote send)", () => {
    expect(decideSmsSignoff(ctx("start", [text("inbound", 0.2)])).add).toBe(true);
  });

  it("a follow up after a quiet thread gets it", () => {
    expect(decideSmsSignoff(ctx("follow_up"))).toEqual({ add: true, reason: "restart" });
    expect(decideSmsSignoff(ctx("follow_up", [text("inbound", 5), text("outbound", 4)]))).toEqual({ add: true, reason: "restart" });
  });

  it("a follow up in a live back and forth does not", () => {
    expect(decideSmsSignoff(ctx("follow_up", [text("inbound", 0.5)]))).toEqual({ add: false, reason: "live_conversation" });
    expect(decideSmsSignoff(ctx("follow_up", [text("outbound", 2.5)])).add).toBe(false);
  });

  it("a follow up right after a call wraps up that call, so it gets it", () => {
    expect(decideSmsSignoff(ctx("follow_up", [text("inbound", 2), call(0.3)]))).toEqual({ add: true, reason: "call_wrap_up" });
  });

  it("a text after the call is back to a live thread", () => {
    expect(decideSmsSignoff(ctx("follow_up", [call(1), text("inbound", 0.5)])).add).toBe(false);
  });

  it("a quick reply never gets it", () => {
    expect(decideSmsSignoff(ctx("reply"))).toEqual({ add: false, reason: "reply" });
  });

  it("never twice to the same number in one day, whatever the occasion", () => {
    const earlier = [text("outbound", 6, `Hi Dana. ${SMS_SIGNOFF}`)];
    expect(decideSmsSignoff(ctx("start", earlier))).toEqual({ add: false, reason: "sent_today" });
    expect(decideSmsSignoff(ctx("follow_up", earlier))).toEqual({ add: false, reason: "sent_today" });
  });

  it("yesterday's line does not count (days are Eastern days)", () => {
    // 19 hours before 2 pm Eastern is 7 pm Eastern the day before.
    expect(decideSmsSignoff(ctx("start", [text("outbound", 19, SMS_SIGNOFF)])).add).toBe(true);
    // 17 hours before is 9 pm Eastern the day before, though it is already today in UTC.
    expect(decideSmsSignoff(ctx("start", [text("outbound", 17, SMS_SIGNOFF)])).add).toBe(true);
    // 13 hours before is 1 am Eastern today.
    expect(decideSmsSignoff(ctx("start", [text("outbound", 13, SMS_SIGNOFF)])).add).toBe(false);
  });

  it("an inbound text that quotes the line does not count as us sending it", () => {
    expect(decideSmsSignoff(ctx("start", [text("inbound", 6, SMS_SIGNOFF)])).add).toBe(true);
  });

  it("ignores bad timestamps and treats future ones as now", () => {
    expect(decideSmsSignoff(ctx("follow_up", [{ direction: "inbound", channel: "sms", at: "not a date" }])).add).toBe(true);
    expect(decideSmsSignoff(ctx("follow_up", [text("inbound", -2)])).add).toBe(false);
  });

  it("the quiet window can be tuned", () => {
    expect(decideSmsSignoff({ ...ctx("follow_up", [text("inbound", 1.5)]), quietHours: 1 }).add).toBe(true);
  });
});

describe("withSmsSignoff", () => {
  it("adds the line when the rule says yes", () => {
    expect(withSmsSignoff("Hi there.", ctx("start"))).toBe(`Hi there. ${SMS_SIGNOFF}`);
  });

  it("takes a drafted line out when the rule says no", () => {
    expect(withSmsSignoff(`Sure, 3pm works. ${SMS_SIGNOFF}`, ctx("follow_up", [text("inbound", 0.1)]))).toBe("Sure, 3pm works.");
    expect(withSmsSignoff(`Sure. ${SMS_SIGNOFF}`, ctx("reply"))).toBe("Sure.");
  });

  it("has a kill switch that leaves the text exactly as written", () => {
    process.env.SMS_SIGNOFF = "false";
    expect(withSmsSignoff("Hi there.", ctx("start"))).toBe("Hi there.");
    expect(withSmsSignoff(`Hi there. ${SMS_SIGNOFF}`, ctx("reply"))).toBe(`Hi there. ${SMS_SIGNOFF}`);
    expect(decideSmsSignoff(ctx("start")).reason).toBe("off");
  });
});

describe("the automatic web lead text", () => {
  it("is a first text, so it ends with the line", () => {
    expect(webLeadSmsText("Dana").endsWith(SMS_SIGNOFF)).toBe(true);
  });

  it("leaves it off when the line already went to that number today", () => {
    const sentEarlier: TextTouch[] = [{ direction: "outbound", channel: "sms", at: new Date(Date.now() - 60_000).toISOString(), body: SMS_SIGNOFF }];
    expect(hasSmsSignoff(webLeadSmsText("Dana", sentEarlier))).toBe(false);
  });
});

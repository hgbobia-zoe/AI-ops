import { describe, expect, it } from "vitest";
import { describeLastMessageWho, formatLastMessageWhen, asLastMessageSnapshot, type LastMessageSnapshot } from "./lastMessage";

const snap = (over: Partial<LastMessageSnapshot> = {}): LastMessageSnapshot => ({
  channel: "sms",
  direction: "in",
  at: "2027-04-05T18:00:00.000Z",
  rawDate: null,
  actor: null,
  title: "Text from client",
  snippet: "hello",
  ...over,
});

describe("describeLastMessageWho", () => {
  it("renders an inbound message as 'from <client>'", () => {
    expect(describeLastMessageWho(snap({ direction: "in", channel: "email" }), "Ada Reed")).toBe("Email from Ada Reed");
  });

  it("renders an outbound message as 'to <client>', naming the actor when known", () => {
    expect(describeLastMessageWho(snap({ direction: "out", channel: "sms", actor: "HG" }), "Ada Reed")).toBe("Text to Ada Reed (by HG)");
    expect(describeLastMessageWho(snap({ direction: "out", channel: "sms", actor: null }), "Ada Reed")).toBe("Text to Ada Reed");
  });

  it("falls back to 'the client' when no name is given", () => {
    expect(describeLastMessageWho(snap({ direction: "in" }))).toBe("Text from the client");
  });

  it("uses the entry title for a directionless internal touch", () => {
    expect(describeLastMessageWho(snap({ direction: null, channel: "note", title: "Logged note", actor: "HG" }))).toBe("Logged note (by HG)");
  });
});

describe("formatLastMessageWhen", () => {
  it("formats a dated instant in Eastern time", () => {
    // 18:00Z on 2027-04-05 is 2:00 PM ET (EDT).
    expect(formatLastMessageWhen(snap({ at: "2027-04-05T18:00:00.000Z" }))).toBe("Apr 5, 2:00 PM");
  });

  it("keeps an undated note's written token", () => {
    expect(formatLastMessageWhen(snap({ at: null, rawDate: "9/7" }))).toBe("9/7");
  });

  it("returns empty string when there is neither an instant nor a token", () => {
    expect(formatLastMessageWhen(snap({ at: null, rawDate: null }))).toBe("");
  });

  it("uses no dashes or em dashes in the formatted output (house comms style)", () => {
    const out = formatLastMessageWhen(snap({ at: "2027-12-25T15:30:00.000Z" }));
    expect(out).not.toMatch(/[—–]/);
  });
});

describe("asLastMessageSnapshot", () => {
  it("round-trips a valid snapshot through JSON (the approval-payload path)", () => {
    const s = snap({ direction: "out", actor: "HG" });
    const parsed = asLastMessageSnapshot(JSON.parse(JSON.stringify(s)));
    expect(parsed).toEqual(s);
  });

  it("rejects malformed / absent input (so a bad field renders as 'no prior message')", () => {
    expect(asLastMessageSnapshot(undefined)).toBeNull();
    expect(asLastMessageSnapshot(null)).toBeNull();
    expect(asLastMessageSnapshot("nope")).toBeNull();
    expect(asLastMessageSnapshot({ channel: "telegram" })).toBeNull();
    expect(asLastMessageSnapshot({})).toBeNull();
  });

  it("normalizes an unknown direction to null and missing text fields to null", () => {
    const parsed = asLastMessageSnapshot({ channel: "call", direction: "sideways" });
    expect(parsed).toEqual({ channel: "call", direction: null, at: null, rawDate: null, actor: null, title: "", snippet: null });
  });
});

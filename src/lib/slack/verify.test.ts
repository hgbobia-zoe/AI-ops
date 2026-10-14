import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifySlackSignature, slackChallenge, extractSlackEvent } from "./verify";

const SECRET = "shh-signing-secret";
function sign(timestamp: string, body: string, secret = SECRET): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
}

describe("verifySlackSignature", () => {
  const now = 1_800_000_000_000; // fixed clock (ms)
  const ts = String(Math.floor(now / 1000));
  const body = '{"type":"event_callback"}';

  it("verifies a correct signature within the window", () => {
    const r = verifySlackSignature(SECRET, ts, body, sign(ts, body), now);
    expect(r).toEqual({ configured: true, verified: true, stale: false });
  });

  it("rejects a wrong signature", () => {
    const r = verifySlackSignature(SECRET, ts, body, sign(ts, body, "other"), now);
    expect(r.verified).toBe(false);
    expect(r.stale).toBe(false);
  });

  it("rejects a stale timestamp (>5 min) without trusting the HMAC", () => {
    const oldTs = String(Math.floor(now / 1000) - 10 * 60);
    const r = verifySlackSignature(SECRET, oldTs, body, sign(oldTs, body), now);
    expect(r).toEqual({ configured: true, verified: false, stale: true });
  });

  it("is unverified when a header is missing", () => {
    expect(verifySlackSignature(SECRET, null, body, sign(ts, body), now).verified).toBe(false);
    expect(verifySlackSignature(SECRET, ts, body, null, now).verified).toBe(false);
  });

  it("reports NOT configured when the signing secret is unset (setup window)", () => {
    const r = verifySlackSignature(undefined, ts, body, sign(ts, body), now);
    expect(r).toEqual({ configured: false, verified: false, stale: false });
  });
});

describe("slackChallenge", () => {
  it("echoes a url_verification challenge", () => {
    expect(slackChallenge({ type: "url_verification", challenge: "abc" })).toBe("abc");
  });
  it("is null for anything else", () => {
    expect(slackChallenge({ type: "event_callback" })).toBeNull();
    expect(slackChallenge(null)).toBeNull();
  });
});

describe("extractSlackEvent", () => {
  const base = { type: "event_callback", event_id: "Ev123" };

  it("extracts a mention and strips the @mention", () => {
    const r = extractSlackEvent({ ...base, event: { type: "app_mention", user: "U1", channel: "C1", ts: "111.1", text: "<@UBOT> what is our refund policy?" } });
    expect(r).toEqual({ kind: "app_mention", eventId: "Ev123", user: "U1", channel: "C1", ts: "111.1", threadTs: "111.1", text: "what is our refund policy?" });
  });

  it("extracts a DM and threads on thread_ts when present", () => {
    const r = extractSlackEvent({ ...base, event: { type: "message", channel_type: "im", user: "U2", channel: "D9", ts: "222.2", thread_ts: "200.0", text: "status of route 5?" } });
    expect(r).toMatchObject({ kind: "message_im", channel: "D9", ts: "222.2", threadTs: "200.0", text: "status of route 5?" });
  });

  it("extracts a thread reply in a public channel (thread-follow candidate)", () => {
    const r = extractSlackEvent({ ...base, event: { type: "message", channel_type: "channel", user: "U3", channel: "C1", ts: "333.3", thread_ts: "300.0", text: "what events are this week?" } });
    expect(r).toEqual({ kind: "channel_message", eventId: "Ev123", user: "U3", channel: "C1", ts: "333.3", threadTs: "300.0", text: "what events are this week?" });
  });

  it("extracts a thread reply in a private channel (group)", () => {
    const r = extractSlackEvent({ ...base, event: { type: "message", channel_type: "group", user: "U4", channel: "G1", ts: "444.4", thread_ts: "400.0", text: "and the crew?" } });
    expect(r).toMatchObject({ kind: "channel_message", channel: "G1", ts: "444.4", threadTs: "400.0", text: "and the crew?" });
  });

  it("ignores the bot's own / subtype / non-matching messages", () => {
    expect(extractSlackEvent({ ...base, event: { type: "app_mention", bot_id: "B1", user: "U1", channel: "C1", ts: "1", text: "hi" } })).toBeNull();
    expect(extractSlackEvent({ ...base, event: { type: "message", channel_type: "im", subtype: "message_changed", user: "U1", channel: "D1", ts: "1", text: "x" } })).toBeNull();
    // A channel message with NO thread_ts is a top-level post, not a thread reply — ignored (a mention of
    // it would instead arrive as app_mention).
    expect(extractSlackEvent({ ...base, event: { type: "message", channel_type: "channel", user: "U1", channel: "C1", ts: "1", text: "x" } })).toBeNull();
    expect(extractSlackEvent({ type: "something_else" })).toBeNull();
    expect(extractSlackEvent({ ...base, event: { type: "app_mention", user: "U1", channel: "C1", ts: "1", text: "<@UBOT>" } })).toBeNull(); // empty after strip
  });
});

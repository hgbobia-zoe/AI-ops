// Viktor (Slack bot) — inbound request verification + event extraction. PURE (crypto + string logic),
// so it is fully unit-tested and the route stays thin. Slack signs each request:
//   X-Slack-Signature: v0=<hex HMAC-SHA256( signing_secret, "v0:{timestamp}:{rawBody}" )>
//   X-Slack-Request-Timestamp: <unix seconds>   (reject if older than 5 min — replay guard)
// Fail-open ONLY while the signing secret is unset (setup window), matching the repo's ingest convention;
// once SLACK_SIGNING_SECRET exists, an unverified request is rejected.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SlackVerify {
  configured: boolean; // is a signing secret set?
  verified: boolean; //  did the HMAC match?
  stale: boolean; //     was the timestamp outside the 5-min window (replay)?
}

const FIVE_MIN_S = 300;

export function verifySlackSignature(
  signingSecret: string | undefined,
  timestamp: string | null,
  rawBody: string,
  signature: string | null,
  now: number = Date.now(),
): SlackVerify {
  if (!signingSecret) return { configured: false, verified: false, stale: false };
  if (!timestamp || !signature) return { configured: true, verified: false, stale: false };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > FIVE_MIN_S) {
    return { configured: true, verified: false, stale: true };
  }
  const expected = "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  const verified = a.length === b.length && timingSafeEqual(a, b);
  return { configured: true, verified, stale: false };
}

// ── Event extraction ──────────────────────────────────────────────────────────────────────────────
interface SlackEvent {
  type?: string;
  subtype?: string;
  channel_type?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}
interface SlackEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackEvent;
}

/** Slack's URL-verification handshake sends `{type:"url_verification", challenge}`; echo the challenge. */
export function slackChallenge(payload: unknown): string | null {
  const p = payload as SlackEnvelope | null;
  return p && p.type === "url_verification" && typeof p.challenge === "string" ? p.challenge : null;
}

export interface SlackInbound {
  // app_mention / message_im always act. A channel_message is a thread REPLY (no mention) in a public or
  // private channel — it only acts when Viktor is already in that thread (the route checks a session
  // exists for channel+threadTs); otherwise it is unrelated channel chatter and is ignored.
  kind: "app_mention" | "message_im" | "channel_message";
  eventId: string;
  user: string; //      the Slack user id who spoke
  text: string; //      the message, @mention stripped
  channel: string;
  ts: string; //        the message's OWN ts — used for message-identity dedup (a mentioned thread reply is
  //                    delivered twice, as app_mention AND message.*, with different event ids but one ts)
  threadTs: string | null; // the thread to reply in / the session key anchor
}

/** Extract an actionable inbound message from a Slack event_callback, or null to ignore it. Three kinds:
 *  a mention (app_mention), a DM (message.im), or a THREAD REPLY in a public/private channel
 *  (message.channels / message.groups with a thread_ts) — the last lets Viktor follow a thread it was
 *  mentioned into without a re-mention on every reply; the route gates it on an existing session so it
 *  never answers unrelated channel chatter. Ignores the bot's OWN messages and any bot/subtype message so
 *  Viktor can't loop on itself. */
export function extractSlackEvent(payload: unknown): SlackInbound | null {
  const env = payload as SlackEnvelope | null;
  if (!env || env.type !== "event_callback" || !env.event) return null;
  const e = env.event;
  if (e.bot_id || e.subtype) return null; // the bot's own / edited / joined / system messages
  const eventId = String(env.event_id ?? "").trim();
  const user = String(e.user ?? "").trim();
  const channel = String(e.channel ?? "").trim();
  const ts = e.ts ? String(e.ts) : "";
  const text = String(e.text ?? "").replace(/<@[^>]+>/g, "").trim(); // strip @mentions (incl. the @Viktor one)
  const threadTs = e.thread_ts ? String(e.thread_ts) : e.ts ? String(e.ts) : null;
  if (!eventId || !user || !channel || !ts || !text) return null;
  if (e.type === "app_mention") return { kind: "app_mention", eventId, user, text, channel, ts, threadTs };
  if (e.type === "message") {
    if (e.channel_type === "im") return { kind: "message_im", eventId, user, text, channel, ts, threadTs };
    // A reply inside a thread (public "channel" or private "group"). Only a real thread reply qualifies
    // (thread_ts present); the thread root itself arrives as its own top-level message and is ignored here
    // unless it mentions Viktor (which comes through as app_mention).
    if ((e.channel_type === "channel" || e.channel_type === "group") && e.thread_ts) {
      return { kind: "channel_message", eventId, user, text, channel, ts, threadTs: String(e.thread_ts) };
    }
  }
  return null;
}

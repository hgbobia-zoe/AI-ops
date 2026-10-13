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
  kind: "app_mention" | "message_im";
  eventId: string;
  user: string; //      the Slack user id who spoke
  text: string; //      the message, @mention stripped
  channel: string;
  threadTs: string | null; // the thread to reply in (existing thread, else the message ts)
}

/** Extract an actionable inbound message (a mention or a DM) from a Slack event_callback, or null to
 *  ignore it. Ignores the bot's OWN messages and any bot/subtype message so Viktor can't loop on itself. */
export function extractSlackEvent(payload: unknown): SlackInbound | null {
  const env = payload as SlackEnvelope | null;
  if (!env || env.type !== "event_callback" || !env.event) return null;
  const e = env.event;
  if (e.bot_id || e.subtype) return null; // the bot's own / edited / joined / system messages
  const eventId = String(env.event_id ?? "").trim();
  const user = String(e.user ?? "").trim();
  const channel = String(e.channel ?? "").trim();
  const text = String(e.text ?? "").replace(/<@[^>]+>/g, "").trim(); // strip @mentions (incl. the @Viktor one)
  const threadTs = e.thread_ts ? String(e.thread_ts) : e.ts ? String(e.ts) : null;
  if (!eventId || !user || !channel || !text) return null;
  if (e.type === "app_mention") return { kind: "app_mention", eventId, user, text, channel, threadTs };
  if (e.type === "message" && e.channel_type === "im") return { kind: "message_im", eventId, user, text, channel, threadTs };
  return null;
}

// Viktor — the Slack Events API inbound webhook. A mention (@Viktor ...) or a DM becomes an AI SESSION
// instruction, which the in-app Viktor agent (src/lib/ai/viktor) answers IN the Slack thread, raising an
// approval a human OKs in the app for any operational ask. Public path (cross-origin): it authenticates by
// Slack's HMAC signature, not a session (see src/proxy.ts PUBLIC).
//
// Fast-ACK: the request path is local (verify + a couple of SQLite writes), so we return 200 well within
// Slack's 3s window; the agent runs after the ACK.

import { NextResponse } from "next/server";
import { verifySlackSignature, slackChallenge, extractSlackEvent } from "@/lib/slack/verify";
import { markSlackEventSeen } from "@/lib/slack/store";
import { createSession, addInstruction, getSessionByIdempotencyKey } from "@/lib/ai/sessions";
import { insertAudit } from "@/lib/db/repo";
import { handleSessionInstruction } from "@/lib/ai/viktor/worker";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text(); // RAW body — required for the HMAC (don't parse first)

  const v = verifySlackSignature(
    process.env.SLACK_SIGNING_SECRET,
    req.headers.get("x-slack-request-timestamp"),
    raw,
    req.headers.get("x-slack-signature"),
  );
  // Enforce the signature once a secret is set; accept during the unset setup window (repo ingest convention).
  if (process.env.SLACK_SIGNING_SECRET && !v.verified) {
    try {
      insertAudit({ actor: "slack-webhook", action: "WEBHOOK_REJECTED", entity: "webhook", entityId: "slack", after: { reason: v.stale ? "stale_timestamp" : "signature_invalid" } });
    } catch {
      /* logging is best-effort */
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Slack's one-time endpoint handshake.
  const challenge = slackChallenge(payload);
  if (challenge) return NextResponse.json({ challenge });

  const ev = extractSlackEvent(payload);
  if (!ev) return NextResponse.json({ ok: true, ignored: true }); // not a mention/DM/thread reply we act on

  // One session per Slack thread. A mention or DM opens (or continues) it; a plain thread reply
  // (channel_message, no mention) only counts when Viktor is ALREADY in this thread — i.e. a session
  // exists for this key. That is how "mention once at the top, then just keep replying" works without
  // Viktor answering unrelated channel chatter.
  const threadKey = `slack:${ev.channel}:${ev.threadTs ?? ev.eventId}`;
  if (ev.kind === "channel_message" && !getSessionByIdempotencyKey(threadKey)) {
    return NextResponse.json({ ok: true, ignored: "not_a_viktor_thread" });
  }

  // Dedup by the MESSAGE identity (channel+ts): a mentioned thread reply is delivered twice — as
  // app_mention AND as message.* — with different event ids but the same ts, and Slack also retries the
  // same event. Keying on ts collapses all of those to a single handling.
  if (!markSlackEventSeen(`msg:${ev.channel}:${ev.ts}`)) return NextResponse.json({ ok: true, deduped: true });

  try {
    // The `slack` input carries the reply target Viktor needs to answer in-thread. createSession is
    // idempotent on the key, so a follow-up continues the same session.
    const session = createSession({
      agentId: "viktor",
      owner: ev.user,
      startedBy: `slack:${ev.user}`,
      title: `Slack: ${ev.text.slice(0, 60)}`,
      provider: "viktor-agent",
      input: { source: "slack", slack: { channel: ev.channel, threadTs: ev.threadTs, user: ev.user } },
      idempotencyKey: threadKey,
    });
    addInstruction(session.id, ev.text, ev.user);

    // Viktor answers in-app: the agent runs AFTER we ACK so Slack still gets its 200 inside 3s. The app is a
    // long-lived Node server on Fly, so this void promise runs to completion. The worker claims the
    // instruction first, so a Slack retry or the runtime backstop can never answer it twice.
    void handleSessionInstruction(session.id).catch(() => {});
  } catch {
    // Still ACK 200 so Slack doesn't retry-storm; a failure here is logged by the DB layer, not user-facing.
  }

  return NextResponse.json({ ok: true });
}

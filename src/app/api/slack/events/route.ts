// Viktor — the Slack Events API inbound webhook. A mention (@Viktor …) or a DM becomes an AI SESSION
// instruction; the connected responder (via the bridge) reads docs/app data, answers IN the Slack thread
// (using its Slack tool), and for an operational ask raises an approval a human OKs in the app. The app
// itself calls NO model here — it just verifies, dedups, and routes. Public path (cross-origin): it
// authenticates by Slack's HMAC signature, not a session (see src/proxy.ts PUBLIC).
//
// Fast-ACK: all work here is local (verify + a couple of SQLite writes), so we finish and return 200 well
// within Slack's 3s window — no network call happens until the responder picks the session up.

import { NextResponse } from "next/server";
import { verifySlackSignature, slackChallenge, extractSlackEvent } from "@/lib/slack/verify";
import { markSlackEventSeen } from "@/lib/slack/store";
import { createSession, addInstruction, getSessionByIdempotencyKey } from "@/lib/ai/sessions";
import { insertAudit } from "@/lib/db/repo";
import { responderHealthNow, recordReactiveAlert, formatAge } from "@/lib/ai/responderHealth";
import { slackNotify } from "@/lib/notify/slack";
import { handleViktorFastPath } from "@/lib/ai/viktorFastPath";

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
    // The `slack` input carries the reply target the responder needs to answer in-thread. createSession is
    // idempotent on the key, so a follow-up continues the same session.
    const session = createSession({
      agentId: "viktor",
      owner: ev.user,
      startedBy: `slack:${ev.user}`,
      title: `Slack: ${ev.text.slice(0, 60)}`,
      provider: "session-bridge",
      input: { source: "slack", slack: { channel: ev.channel, threadTs: ev.threadTs, user: ev.user } },
      idempotencyKey: threadKey,
    });
    addInstruction(session.id, ev.text, ev.user);

    // Tier 1 (the snappy fast path) + the fail-loud alarm, kicked off AFTER we ACK so Slack still gets its
    // 200 inside 3s. The app is a long-lived Node server on Fly, so this void promise runs to completion.
    // Fast path triages the message: a basic question it answers itself here (no office machine needed); a
    // real task it leaves on the bridge for the Claude Code responder (Tier 2) with a short ack.
    const sessionId = session.id;
    const fastText = ev.text;
    const channel = ev.channel;
    const threadTs = ev.threadTs;
    const messageTs = ev.ts;
    void (async () => {
      const outcome = await handleViktorFastPath({ sessionId, text: fastText, channel, threadTs, messageTs });
      // Only alarm when the message actually needs Tier 2 (routed, or fast path unavailable). A question
      // Tier 1 already answered must NOT trigger a false "responder is DOWN" alert. Deduped with a short
      // cool-off so a burst of Slack messages doesn't spam.
      if (outcome !== "answered") {
        const health = responderHealthNow();
        if (!health.alive && recordReactiveAlert().alert) {
          const since = health.state === "never" ? "ever" : `in ${formatAge(health.ageMs)}`;
          void slackNotify(
            `⚠️ Viktor has a task that needs the responder, but it is DOWN (no heartbeat ${since}). It's queued and will be handled once the responder is running. Start it: a Claude Code session running scripts/responder/loop.md via /loop 60s.`,
          ).catch(() => {});
        }
      }
    })().catch(() => {});
  } catch {
    // Still ACK 200 so Slack doesn't retry-storm; a failure here is logged by the DB layer, not user-facing.
  }

  return NextResponse.json({ ok: true });
}

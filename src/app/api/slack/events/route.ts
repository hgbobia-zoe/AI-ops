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
import { createSession, addInstruction } from "@/lib/ai/sessions";
import { insertAudit } from "@/lib/db/repo";
import { responderHealthNow, recordReactiveAlert, formatAge } from "@/lib/ai/responderHealth";
import { slackNotify } from "@/lib/notify/slack";

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
  if (!ev) return NextResponse.json({ ok: true, ignored: true }); // not a mention/DM we act on

  // Dedup Slack retries so we don't double-record the instruction.
  if (!markSlackEventSeen(ev.eventId)) return NextResponse.json({ ok: true, deduped: true });

  try {
    // One session per Slack thread (idempotencyKey), so a follow-up in the same thread continues the same
    // session. The `slack` input carries the reply target the responder needs to answer in-thread.
    const session = createSession({
      agentId: "viktor",
      owner: ev.user,
      startedBy: `slack:${ev.user}`,
      title: `Slack: ${ev.text.slice(0, 60)}`,
      provider: "session-bridge",
      input: { source: "slack", slack: { channel: ev.channel, threadTs: ev.threadTs, user: ev.user } },
      idempotencyKey: `slack:${ev.channel}:${ev.threadTs ?? ev.eventId}`,
    });
    addInstruction(session.id, ev.text, ev.user);

    // Fail LOUD: the instruction is queued, but if the office-machine responder hasn't heartbeated recently
    // then nothing is draining the queue — the person will get silence. Ping the ops channel so a human
    // starts the responder. Deduped with a short cool-off so a burst of Slack messages doesn't spam. Pure
    // best-effort: a slow/failed Slack must never block the fast-ACK (we've already recorded the work).
    const health = responderHealthNow();
    if (!health.alive && recordReactiveAlert().alert) {
      const since = health.state === "never" ? "ever" : `in ${formatAge(health.ageMs)}`;
      void slackNotify(
        `⚠️ Viktor got a Slack message but the responder is DOWN (no heartbeat ${since}). It's queued and will be answered once the responder is running. Start it: a Claude Code session running scripts/responder/loop.md via /loop 60s.`,
      ).catch(() => {});
    }
  } catch {
    // Still ACK 200 so Slack doesn't retry-storm; a failure here is logged by the DB layer, not user-facing.
  }

  return NextResponse.json({ ok: true });
}

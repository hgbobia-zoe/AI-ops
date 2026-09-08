// OpenPhone ("Quo") inbound webhook — the real-time feed of call events. On a completed call (or its
// transcript/summary), we record it and, if the customer sounds frustrated, alert the dedicated
// customer-alerts Slack channel. Fast-ACK: verify + parse, kick the analysis async, return 200 so
// OpenPhone doesn't retry. Public path (cross-origin) — it authenticates itself by HMAC signature.

import { NextResponse } from "next/server";
import { verifyOpenphoneSignature, openphoneSigningKey } from "@/lib/comms/openphone";
import { ingestCallEvent, ingestInboundSms, type IngestCallInput } from "@/lib/comms/service";
import { insertAudit } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

interface OpObject {
  id?: string;
  callId?: string;
  object?: string;
  direction?: string;
  from?: string;
  to?: string | string[];
  duration?: number;
  createdAt?: string;
  completedAt?: string;
  answeredAt?: string;
  dialogue?: { content?: string; identifier?: string }[];
  summary?: string[] | string;
  userId?: string;
  user?: { id?: string; name?: string; firstName?: string; lastName?: string };
  answeredBy?: { id?: string; name?: string };
  // message events
  body?: string;
  text?: string;
}

const firstTo = (to: unknown): string | null => (Array.isArray(to) ? (to[0] ? String(to[0]) : null) : typeof to === "string" ? to : null);

/** Best-effort Quo user id of who handled/made the call — mapped to initials for the note tag. */
function agentUserIdOf(o: OpObject): string | undefined {
  return o.userId || o.user?.id || o.answeredBy?.id || undefined;
}

/** Fallback: a name, if the event carries one instead of (or as well as) an id. */
function agentNameOf(o: OpObject): string | undefined {
  const u = o.user;
  const full = u?.name || [u?.firstName, u?.lastName].filter(Boolean).join(" ") || o.answeredBy?.name;
  return full || undefined;
}
interface OpEvent {
  id?: string;
  type?: string;
  createdAt?: string;
  data?: { object?: OpObject };
}

function joinDialogue(d: OpObject["dialogue"]): string | null {
  if (!Array.isArray(d) || d.length === 0) return null;
  return d.map((x) => (x.identifier ? `${x.identifier}: ${x.content ?? ""}` : x.content ?? "")).join("\n").trim() || null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();

  // Authenticate: enforce the HMAC signature when a signing key is configured. Until it's set (setup
  // window) we accept — matching the repo's fail-open ingest convention — but never once a key exists.
  // A rejection is a security event: log it (actor "quo-webhook") and return an explicit failure.
  const sig = verifyOpenphoneSignature(raw, req.headers.get("openphone-signature"));
  if (openphoneSigningKey() && !sig.verified) {
    try {
      insertAudit({ actor: "quo-webhook", action: "WEBHOOK_REJECTED", entity: "webhook", entityId: "openphone", after: { reason: "signature_invalid", hadHeader: Boolean(req.headers.get("openphone-signature")) } });
    } catch {
      /* logging is best-effort */
    }
    return NextResponse.json({ error: "Webhook rejected — authentication failed." }, { status: 401 });
  }

  let payload: OpEvent;
  try {
    payload = JSON.parse(raw) as OpEvent;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const type = payload.type ?? "";
  const obj = payload.data?.object ?? {};

  // Inbound customer SMS → capture on the unified timeline + match to a lead (Phase 3).
  if (type === "message.received" || (type.startsWith("message") && obj.direction === "incoming")) {
    const msgId = (obj.id ?? "").trim();
    const from = (obj.from ?? "").trim();
    const body = (obj.body ?? obj.text ?? "").trim();
    if (!msgId || !from) return NextResponse.json({ ok: true, ignored: "message missing id/from" });
    try {
      ingestInboundSms({ providerId: msgId, from, to: firstTo(obj.to), body, occurredAt: obj.createdAt ?? payload.createdAt ?? null });
    } catch {
      /* best-effort */
    }
    return NextResponse.json({ ok: true, received: type });
  }

  // Call events carry customer tone + call notes. Ack everything else without work.
  if (!type.startsWith("call")) return NextResponse.json({ ok: true, ignored: type || "unknown" });

  const callId = (obj.callId ?? obj.id ?? "").trim();
  if (!callId) return NextResponse.json({ ok: true, ignored: "no call id" });

  const input: IngestCallInput = {
    callId,
    providerId: callId,
    eventType: type,
    direction: obj.direction,
    fromPhone: obj.from,
    toPhone: firstTo(obj.to) ?? undefined,
    durationSec: typeof obj.duration === "number" ? obj.duration : null,
    transcript: joinDialogue(obj.dialogue),
    summary: Array.isArray(obj.summary) ? obj.summary.join(" ") : typeof obj.summary === "string" ? obj.summary : null,
    occurredAt: obj.completedAt ?? obj.createdAt ?? payload.createdAt ?? null,
    agentUserId: agentUserIdOf(obj),
    agentName: agentNameOf(obj),
  };

  // Fire-and-forget: transcript fetch + LLM can take seconds; don't make OpenPhone wait.
  void ingestCallEvent(input).catch(() => {});

  return NextResponse.json({ ok: true, received: type });
}

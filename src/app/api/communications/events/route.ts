// Communications ingestion — the adapter ingress. POST a provider event (Quo/Sona/anything) and it is
// normalized by the ADAPTER into a canonical event, then appended to the immutable communication log.
// The Tower never depends on a vendor's payload shape; the adapter maps whatever arrives. Token-gated
// (COMMS_INGEST_TOKEN, fail-open until set — the repo's ingest convention) and CORS-locked, so Quo/Sona
// can reach it cross-origin. This is the FUTURE primary ingress; today real calls still arrive via the
// existing OpenPhone webhook. The Quo→Sona schema is not finalized, so the adapter is intentionally lenient.

import { NextResponse } from "next/server";
import { adaptEvent, type RawEvent } from "@/lib/comms/adapter";
import { appendCommsLog } from "@/lib/comms/store";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-comms-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  const token = process.env.COMMS_INGEST_TOKEN;
  if (token && req.headers.get("x-comms-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: RawEvent | { events?: RawEvent[] };
  try {
    body = (await req.json()) as RawEvent | { events?: RawEvent[] };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  const raws: RawEvent[] = Array.isArray((body as { events?: RawEvent[] }).events)
    ? ((body as { events?: RawEvent[] }).events as RawEvent[])
    : [body as RawEvent];

  const results = raws.map((raw) => {
    const adapted = adaptEvent(raw);
    const id = appendCommsLog(adapted.event);
    return { conversationId: adapted.event.conversationId, canonicalType: adapted.canonicalType, recognized: adapted.recognized, logged: Boolean(id), duplicate: !id };
  });

  return NextResponse.json({ ok: true, count: results.length, results }, { headers: CORS });
}

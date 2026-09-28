// Ingest Goodshuffle CLIENT-EMAIL thread messages for open leads. The server can't live-fetch
// Goodshuffle (Cloudflare blocks datacenter IPs), so the office pull captures each message from
// getMessagesForTransaction and POSTs them here. FACTS ONLY, idempotent on the Goodshuffle message id.
// Rides on top of existing bookings; CORS-restricted to the Goodshuffle origin, own token (fail-open),
// exactly like /api/gs/notes and /api/gs/outbox.
//
// Body: { emails: [{ bookingId, providerMsgId, direction?(inbound|outbound), participant?, subject?,
//   snippet?, occurredAt?(ISO), openedAt?(ISO) }] }

import { NextResponse } from "next/server";
import { saveEmailEvents, type EmailEventInput } from "@/lib/db/repo";
import { logImport } from "@/lib/pull/state";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://pro.goodshuffle.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

interface InEmail {
  bookingId?: string | number;
  providerMsgId?: string | number;
  direction?: string | null;
  participant?: string | null;
  subject?: string | null;
  snippet?: string | null;
  occurredAt?: string | null;
  openedAt?: string | null;
}

const iso = (s: string | null | undefined): string | null => (s && !Number.isNaN(Date.parse(s)) ? s : null);
const dir = (s: string | null | undefined): "inbound" | "outbound" | null => (s === "inbound" || s === "outbound" ? s : null);
const str = (s: string | null | undefined, n: number): string | null => {
  const t = (s ?? "").trim();
  return t ? t.slice(0, n) : null;
};

export async function POST(req: Request): Promise<NextResponse> {
  const publishToken = process.env.GS_INGEST_TOKEN;
  if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: { emails?: InEmail[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  const emails = Array.isArray(body.emails) ? body.emails : [];
  if (emails.length === 0) return NextResponse.json({ error: "emails[] required" }, { status: 400, headers: CORS });

  const records: EmailEventInput[] = [];
  for (const e of emails) {
    const bookingId = e.bookingId != null ? String(e.bookingId) : "";
    const providerMsgId = e.providerMsgId != null ? String(e.providerMsgId) : "";
    if (!bookingId || !providerMsgId) continue; // idempotency + linkage both required — never fabricate
    records.push({
      providerMsgId,
      bookingId,
      direction: dir(e.direction),
      participant: str(e.participant, 200),
      subject: str(e.subject, 300),
      snippet: str(e.snippet, 300),
      occurredAt: iso(e.occurredAt),
      openedAt: iso(e.openedAt),
    });
  }
  const written = records.length > 0 ? saveEmailEvents(records) : 0;
  logImport("gs_emails", true, { rowsIn: emails.length, rowsWritten: written });
  return NextResponse.json({ ok: true, written }, { headers: CORS });
}

// Instawork contacts ingest — the Auto-Pull extension POSTs booked-pro contacts here. The gig-groups pull
// (/api/instawork/import) carries worker_id + name but NO phone; the extension ADDITIONALLY fetches
//   GET /api/partner/shifts/timesheet-v2/shift-group/<groupId>
// per booked group (same-origin, the operator's session) which DOES expose shifts[].worker_phone_number, and
// POSTs { contacts: [{ worker_id, worker, worker_phone_number }] } here. We persist the worker → phone map
// (src/lib/instawork/contacts.ts) so a shift debrief can reach Instawork workers. The Zoe server NEVER calls
// Instawork. Mirrors /api/instawork/import: force-dynamic, CORS to the Instawork origin, optional
// GS_INGEST_TOKEN gate (fail-open until set).

import { NextResponse } from "next/server";
import { saveInstaworkContacts, toContact, type InstaworkContact } from "@/lib/instawork/contacts";
import { logImport } from "@/lib/pull/state";

export const dynamic = "force-dynamic";

// CORS: allow the content script running INSIDE a logged-in app.instawork.com tab to POST here. Restricted
// to the Instawork origin so only code running there (the operator's own session) can post. CORS is not a
// security control — the ingest token (below) is.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://app.instawork.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  // Gated by the ingest token once GS_INGEST_TOKEN is set (the extension carries it); fail-open until then.
  const publishToken = process.env.GS_INGEST_TOKEN;
  if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }

  let body: { contacts?: unknown[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  const now = new Date().toISOString();
  const rows = Array.isArray(body.contacts) ? (body.contacts as Array<Record<string, unknown>>) : [];
  const contacts = rows.map((r) => toContact(r, now)).filter((c): c is InstaworkContact => c !== null);

  const stored = saveInstaworkContacts(contacts);
  logImport("instawork-contacts", true, { rowsIn: rows.length, rowsWritten: contacts.length, detail: `${contacts.length} captured, ${stored} stored` });

  return NextResponse.json({ ok: true, captured: contacts.length, stored }, { headers: CORS });
}

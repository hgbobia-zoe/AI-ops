// Ingest Goodshuffle project NOTES (the comms history) for open leads — the team logs every call,
// text, email, and voicemail in a project's internal notes, so this is where "previous contact"
// actually lives. Posted by the office pull (from a logged-in Goodshuffle tab, via initContractView).
// Rides on top of existing bookings; CORS-restricted to the Goodshuffle origin like /api/gs/projects.
//
// Body: { notes: [{ bookingId, internalNotes?, clientNotes?, lastSentDate?(YYYY-MM-DD), lineItems?[] }] }

import { NextResponse } from "next/server";
import { saveLeadNotes, type LeadNotesRecord } from "@/lib/db/repo";
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

interface InNote {
  bookingId?: string | number;
  internalNotes?: string;
  clientNotes?: string;
  lastSentDate?: string | null;
  lineItems?: unknown;
}

/** Line-item titles arrive as a string[]; keep only non-empty strings, cap the count, dedupe. */
function cleanLineItems(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t) seen.add(t.slice(0, 120));
  }
  return Array.from(seen).slice(0, 200);
}

const ymd = (s: string | null | undefined): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

export async function POST(req: Request): Promise<NextResponse> {
  const publishToken = process.env.GS_INGEST_TOKEN;
  if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: { notes?: InNote[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  const notes = Array.isArray(body.notes) ? body.notes : [];
  if (notes.length === 0) return NextResponse.json({ error: "notes[] required" }, { status: 400, headers: CORS });

  const records: LeadNotesRecord[] = [];
  for (const n of notes) {
    const id = n.bookingId != null ? String(n.bookingId) : "";
    if (!id) continue;
    records.push({
      bookingId: id,
      internalNotes: (n.internalNotes ?? "").trim() || null,
      clientNotes: (n.clientNotes ?? "").trim() || null,
      lastSentDate: ymd(n.lastSentDate),
      lineItems: cleanLineItems(n.lineItems), // undefined ⇒ leave stored line_items untouched
    });
  }
  const updated = records.length > 0 ? saveLeadNotes(records) : 0;
  logImport("lead_notes", true, { rowsIn: notes.length, rowsWritten: updated });
  return NextResponse.json({ ok: true, updated }, { headers: CORS });
}

// Ingest Goodshuffle project LOGISTICS legs (drop-off / pickup dates + windows, and whether we drive at all),
// posted by the office pull from a logged-in Goodshuffle tab (initProjectTimeline per upcoming signed project).
// The pull sends the raw timeline legs; parsing happens here (lib/gs/logistics.ts, unit-tested) so the
// extension stays dumb. Rides on top of existing bookings; CORS-restricted + GS_INGEST_TOKEN like /api/gs/notes.
//
// Body: { logistics: [{ bookingId, startDate?(YYYY-MM-DD), events: [{ type, dateLabel }] }] }

import { NextResponse } from "next/server";
import { parseProjectLogistics, type TimelineEvent } from "@/lib/gs/logistics";
import { saveBookingLogistics } from "@/lib/db/repo";

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

interface InLogistics {
  bookingId?: string | number;
  startDate?: string | null;
  events?: unknown;
}

const ymd = (s: unknown): string | null => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

function cleanEvents(raw: unknown): TimelineEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 50)
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      type: typeof e.type === "string" ? e.type.slice(0, 40) : null,
      dateLabel: typeof e.dateLabel === "string" ? e.dateLabel.slice(0, 120) : null,
    }));
}

export async function POST(req: Request): Promise<NextResponse> {
  const publishToken = process.env.GS_INGEST_TOKEN;
  if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: { logistics?: InLogistics[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  const list = Array.isArray(body.logistics) ? body.logistics.slice(0, 1000) : [];
  const records = [];
  for (const l of list) {
    const id = l.bookingId != null ? String(l.bookingId).trim() : "";
    if (!id) continue;
    const events = cleanEvents(l.events);
    // A failed/empty timeline read must not blank what we already know.
    if (events.length === 0) continue;
    records.push({ bookingId: id, ...parseProjectLogistics(events, ymd(l.startDate)) });
  }
  const updated = records.length ? saveBookingLogistics(records) : 0;
  return NextResponse.json({ ok: true, received: list.length, updated }, { headers: CORS });
}

// Ingest Goodshuffle BOOKINGS (projects) — the commercial pipeline behind Sales, Finance, and
// Customer. Posted by the office pull (runs inside a logged-in, full-access Goodshuffle tab, which
// can see financials the driver/tablet account can't). Amounts arrive in CENTS and are stored as
// dollars. CORS-restricted to the Goodshuffle origin, same as /api/route/import.
//
// Body: { projects: [{ bookingId, eventName?, eventDate?(YYYY-MM-DD|null), statusLabel?, signed?,
//   grandTotalCents?, contractTotalCents?, amountPaidCents?, amountDueCents?, clientName?, clientEmail? }] }

import { NextResponse } from "next/server";
import { saveBookings, type BookingRecord } from "@/lib/db/repo";
import { recordPullSuccess } from "@/lib/pull/state";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://pro.goodshuffle.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

interface InProject {
  bookingId?: string | number;
  eventName?: string;
  eventDate?: string | null;
  statusLabel?: string;
  signed?: boolean;
  grandTotalCents?: number;
  contractTotalCents?: number;
  amountPaidCents?: number;
  amountDueCents?: number;
  clientName?: string;
  clientEmail?: string;
}

const dollars = (cents: number | undefined): number | null =>
  typeof cents === "number" && Number.isFinite(cents) ? Math.round(cents) / 100 : null;

const ymd = (s: string | null | undefined): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

export async function POST(req: Request): Promise<NextResponse> {
  let body: { projects?: InProject[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  const projects = Array.isArray(body.projects) ? body.projects : [];
  if (projects.length === 0) return NextResponse.json({ error: "projects[] required" }, { status: 400, headers: CORS });

  const records: BookingRecord[] = [];
  for (const p of projects) {
    const id = p.bookingId != null ? String(p.bookingId) : "";
    if (!id) continue;
    records.push({
      bookingId: id,
      eventName: p.eventName,
      eventDate: ymd(p.eventDate),
      statusLabel: p.statusLabel,
      signed: Boolean(p.signed),
      contractTotal: dollars(p.contractTotalCents),
      grandTotal: dollars(p.grandTotalCents),
      amountPaid: dollars(p.amountPaidCents),
      amountDue: dollars(p.amountDueCents),
      clientName: p.clientName,
      clientEmail: p.clientEmail,
    });
  }
  if (records.length > 0) {
    saveBookings(records);
    recordPullSuccess("bookings", records.length); // bookings pull counts as a successful pull
  }
  return NextResponse.json({ ok: true, saved: records.length }, { headers: CORS });
}

// Type-to-search for the delivery calculator's project picker. Matches the query against the Goodshuffle
// project number (id), the event name, or the customer name (case-insensitive substring). Returns up to
// ~25 matches with the fields the calculator prefills. Staff-session-gated (NOT public): /api/pricing is
// not on the proxy's PUBLIC allowlist, so only a valid session reaches this handler.

import { NextResponse } from "next/server";
import { searchBookings } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ projects: [] });

  const projects = searchBookings(q, 25)
    .filter((b) => b.eventName || b.clientName)
    .map((b) => ({
      id: b.bookingId,
      name: b.eventName || b.clientName,
      clientName: b.clientName,
      subtotal: b.contractTotal, // Goodshuffle contract_subtotal (pre-discount, dollars) — the stored value
      location: b.location,
      eventDate: b.eventDate,
    }));

  return NextResponse.json({ projects });
}

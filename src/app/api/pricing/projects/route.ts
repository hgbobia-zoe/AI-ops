// Recent projects for the delivery calculator's "prefill from a project" picker. Newest-created first,
// so a quote you just built (once the Auto-Pull has captured it) sits at the top. Returns the fields the
// calculator needs: the Goodshuffle contract subtotal (the pre-discount figure the fee formula wants) and
// the event location (city/state/zip — enough to estimate driving miles; refine the street for exactness).

import { NextResponse } from "next/server";
import { getRecentBookings } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const projects = getRecentBookings(40)
    .filter((b) => b.eventName || b.clientName)
    .map((b) => ({
      id: b.bookingId,
      name: b.eventName || b.clientName,
      subtotal: b.contractTotal, // Goodshuffle contract_subtotal (pre-discount)
      location: b.location,
      dateCreated: b.dateCreated,
      eventDate: b.eventDate,
    }));
  return NextResponse.json({ projects });
}

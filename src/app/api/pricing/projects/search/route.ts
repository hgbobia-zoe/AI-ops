// The delivery calculator's project picker. LIVE projects only (no archived, lost, cancelled, or deleted
// ones), grouped New > Quote Sent > Signed and newest first. An empty query returns the whole dropdown; a
// query matches the project number, event name, or customer (case-insensitive substring). Staff-session-gated (NOT public): /api/pricing is
// not on the proxy's PUBLIC allowlist, so only a valid session reaches this handler.

import { NextResponse } from "next/server";
import { pickerBookings, getProjectRouteInfo, getBookingLogistics } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  const found = pickerBookings(q, 100).filter((b) => b.eventName || b.clientName);
  // When the project is already on a route, its stop has the venue's street address and the real
  // delivery and pickup dates. Goodshuffle's search gives only city + ZIP and the logistics start date.
  // Not routed yet: fall back to Goodshuffle's own venue street and timeline legs (captured by the pull).
  const ids = found.map((b) => b.bookingId);
  const routed = getProjectRouteInfo(ids);
  const gs = getBookingLogistics(ids);
  const projects = found.map((b) => {
    const r = routed.get(b.bookingId);
    const g = gs.get(b.bookingId);
    return {
      id: b.bookingId,
      name: b.eventName || b.clientName,
      clientName: b.clientName,
      status: b.statusLabel || null,
      subtotal: b.contractTotal, // Goodshuffle contract_subtotal (pre-discount, dollars), the stored value
      location: b.location,
      streetAddress: r?.address ?? g?.streetAddress ?? null,
      eventDate: r?.deliveryDate ?? g?.deliveryDate ?? b.eventDate,
      pickupDate: r?.pickupDate ?? g?.pickupDate ?? null,
    };
  });

  return NextResponse.json({ projects });
}

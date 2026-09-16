// Existing-customer check for the intake wizard. The server can't call Goodshuffle live, so this checks
// OUR Goodshuffle mirror (the bookings we've pulled) by phone — enough to warn "we may already have this
// customer" and pre-fill name/email. The authoritative Goodshuffle contact match happens at create time
// in the logged-in session. Honest: this is "based on our records", not a live Goodshuffle lookup.

import { NextResponse } from "next/server";
import { getBookingByPhoneDigits } from "@/lib/db/repo";
import { last10 } from "@/lib/comms/identity";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { phone?: string; email?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const digits = last10(body.phone ?? "");
  const b = digits ? getBookingByPhoneDigits(digits) : null;
  if (!b) return NextResponse.json({ match: null });
  return NextResponse.json({
    match: {
      name: b.clientName || "",
      email: b.clientEmail || "",
      phone: b.clientPhone || "",
      eventName: b.eventName || "",
      projectId: b.bookingId,
      gsUrl: `https://pro.goodshuffle.com/app/project/detail?id=${b.bookingId}`,
    },
  });
}

// Build + inspect a Context Pack for a caller. GET ?phone=+1... (optionally &bookingId= to anchor a
// disambiguated customer). This is the object the Tower would hand to Sona — verified facts only.

import { NextResponse } from "next/server";
import { buildContextPack } from "@/lib/comms/context";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const phone = url.searchParams.get("phone");
  const bookingId = url.searchParams.get("bookingId");
  const contactName = url.searchParams.get("name");
  const pack = await buildContextPack(phone, { anchorBookingId: bookingId, contactName });
  return NextResponse.json(pack);
}

// Marketing lead-source attribution — manual channel tags on recent bookings (Goodshuffle does not tell
// us how a lead heard about Zoe). GET returns recent bookings joined with their tag; POST sets one tag.

import { NextResponse } from "next/server";
import { getLeadTags, setLeadTag } from "@/lib/marketing/store";
import { getRecentBookings } from "@/lib/db/repo";
import { currentActor } from "@/lib/auth/getSession";
import { LEAD_CHANNELS, type LeadChannel } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const tags = getLeadTags();
  const rows = getRecentBookings(120).map((b) => {
    const tag = tags.get(b.bookingId);
    return {
      bookingId: b.bookingId,
      eventName: b.eventName,
      clientName: b.clientName,
      eventDate: b.eventDate,
      dateCreated: b.dateCreated,
      signed: b.signed,
      grandTotal: b.grandTotal,
      channel: tag?.channel ?? null,
      note: tag?.note ?? "",
    };
  });
  return NextResponse.json({ bookings: rows });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { bookingId?: string; channel?: LeadChannel | null; note?: string };
  try {
    body = (await req.json()) as { bookingId?: string; channel?: LeadChannel | null; note?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.bookingId) return NextResponse.json({ error: "booking_required" }, { status: 400 });
  const channel = body.channel && LEAD_CHANNELS.includes(body.channel) ? body.channel : null;
  setLeadTag(body.bookingId, channel, body.note ?? "", (await currentActor()).label);
  return NextResponse.json({ ok: true });
}

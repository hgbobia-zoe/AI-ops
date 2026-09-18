// Marketing channel hub — the links to the external tools the team runs (Confluence, social poster,
// ManyChat, Google Business, directories). Read + save. Settings-gated (owner/admin) via the proxy? No —
// these are shared team links, so any staff member may read/update them.

import { NextResponse } from "next/server";
import { getChannelLinks, saveChannelLinks } from "@/lib/marketing/store";
import { emptyChannelLinks, type ChannelLinks } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ links: getChannelLinks() });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Partial<ChannelLinks>;
  try {
    body = (await req.json()) as Partial<ChannelLinks>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const links = saveChannelLinks({ ...emptyChannelLinks(), ...body });
  return NextResponse.json({ ok: true, links });
}

// Outreach prospects — list + create. Top-of-funnel targets the team is reaching out to before
// Goodshuffle; the win is "quote agreed". Staff-only (proxy denies guests on /api/*).

import { NextResponse } from "next/server";
import { listProspects, createProspect } from "@/lib/marketing/store";
import { currentActor } from "@/lib/auth/getSession";
import type { ProspectInput } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ prospects: listProspects() });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: ProspectInput;
  try {
    body = (await req.json()) as ProspectInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.name || !body.name.trim()) return NextResponse.json({ error: "name_required" }, { status: 400 });
  return NextResponse.json({ ok: true, prospect: createProspect(body, (await currentActor()).label) });
}

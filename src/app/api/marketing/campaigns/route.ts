// Marketing campaigns — list + create. Staff-only (proxy denies guests on /api/*). FACTS the team enters.

import { NextResponse } from "next/server";
import { listCampaigns, createCampaign } from "@/lib/marketing/store";
import { currentActor } from "@/lib/auth/getSession";
import type { CampaignInput } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ campaigns: listCampaigns() });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: CampaignInput;
  try {
    body = (await req.json()) as CampaignInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.name || !body.name.trim()) return NextResponse.json({ error: "name_required" }, { status: 400 });
  const campaign = createCampaign(body, (await currentActor()).label);
  return NextResponse.json({ ok: true, campaign });
}

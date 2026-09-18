// Marketing campaigns — update + delete one.

import { NextResponse } from "next/server";
import { updateCampaign, deleteCampaign } from "@/lib/marketing/store";
import type { CampaignInput } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  let body: CampaignInput;
  try {
    body = (await req.json()) as CampaignInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const campaign = updateCampaign(id, body);
  if (!campaign) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, campaign });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  return NextResponse.json({ ok: deleteCampaign(id) });
}

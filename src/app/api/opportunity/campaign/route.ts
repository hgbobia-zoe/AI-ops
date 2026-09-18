// Opportunity Radar campaigns API (§11). Actions: create (a campaign with target criteria), assign
// (an opportunity to a campaign), automatch (assign everything matching the criteria). Proxy-gated.

import { NextResponse } from "next/server";
import { createCampaign, setCampaign, getOpportunity, getCampaign } from "@/lib/opportunity/store";
import { autoMatchCampaign, type CampaignCriteria } from "@/lib/opportunity/campaigns";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { action?: string; name?: string; description?: string; criteria?: CampaignCriteria; opportunityId?: string; campaignId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const action = body.action;

  if (action === "create") {
    const name = (body.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    const actor = (await currentActor()).label;
    const campaign = createCampaign({ name, description: body.description ?? null, criteria: (body.criteria as Record<string, unknown>) ?? null, createdBy: actor, isSeed: false });
    return NextResponse.json({ ok: true, campaign });
  }

  if (action === "assign") {
    const oid = (body.opportunityId ?? "").trim();
    const cid = body.campaignId?.trim() || null;
    if (!getOpportunity(oid)) return NextResponse.json({ error: "opportunity not found" }, { status: 404 });
    if (cid && !getCampaign(cid)) return NextResponse.json({ error: "campaign not found" }, { status: 404 });
    setCampaign(oid, cid);
    return NextResponse.json({ ok: true });
  }

  if (action === "automatch") {
    const cid = (body.campaignId ?? "").trim();
    if (!getCampaign(cid)) return NextResponse.json({ error: "campaign not found" }, { status: 404 });
    const n = autoMatchCampaign(cid);
    return NextResponse.json({ ok: true, assigned: n });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

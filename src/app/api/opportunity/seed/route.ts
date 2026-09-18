// Reload the Opportunity Radar DEMO dataset (procurement + facility signals) + re-bridge events. Every
// seeded row is is_seed=1 and badged SEED. Idempotent. Gated to users who can manage settings.

import { NextResponse } from "next/server";
import { reseedOpportunities } from "@/lib/opportunity/seed";
import { opportunityBoard } from "@/lib/opportunity/service";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await reseedOpportunities();
  return NextResponse.json({ ok: true, count: opportunityBoard().all.length });
}

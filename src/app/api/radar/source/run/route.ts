// Run a configured API source on demand (a "Pull now" for the sources page). Today that is SAM.gov
// (federal solicitations) — real data, server-side, once SAM_API_KEY is set. Reports clearly when a
// source is dormant (no key). Gated to settings managers.

import { NextResponse } from "next/server";
import { runOpportunitySource } from "@/lib/opportunity/ingest";
import { samGovSource, samGovConfigured } from "@/lib/opportunity/sources/samgov";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { sourceId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const sourceId = (body.sourceId ?? "").trim();

  if (sourceId === "samgov-federal") {
    if (!samGovConfigured()) return NextResponse.json({ ok: false, dormant: true, message: "SAM.gov is dormant — set SAM_API_KEY to enable the live federal feed." });
    const result = await runOpportunitySource(samGovSource());
    return NextResponse.json({ ok: true, ...result });
  }

  return NextResponse.json({ error: "only the SAM.gov API source can be run on demand; browser sources are fed by the local agent" }, { status: 400 });
}

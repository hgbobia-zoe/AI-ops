// Morning outreach DRY RUN. Owner/admin only. POST plans the next morning's automated follow up texts for
// up to ?limit= open quotes (default 10, max 50) and posts a per project recap to the Sales Bot channel
// (?post=0 skips Slack). It sends nothing. GET returns the progress and the last plan.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getMorningRunState, startMorningDryRun } from "@/lib/salesos/morningOutreach";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(getMorningRunState());
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const limit = Math.min(50, Math.max(1, Number(sp.get("limit")) || 10));
  const post = !["0", "false", "no"].includes((sp.get("post") ?? "").toLowerCase());
  // ?rep= is the fallback first name for projects whose Goodshuffle sales lead isn't captured yet
  const rep = (sp.get("rep") ?? "").trim().slice(0, 40) || null;
  return NextResponse.json(startMorningDryRun({ limit, post, rep }));
}

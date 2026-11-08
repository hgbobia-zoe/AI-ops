// Cold email hand off (Instantly or Smartlead, whichever is active), human approved. GET = the review list
// (who is due, what they will get, and why any can't go). POST { enrollmentIds } = push exactly the leads
// the person ticked. Owner/admin only. The app never sends email itself; the tool sends from its warmed
// inboxes.

import { NextResponse } from "next/server";
import { pushCandidates, pushApproved } from "@/lib/prospecting/service";
import { sequencerConfigured, activeProvider, PROVIDER_LABEL } from "@/lib/prospecting/sequencer";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, connected: sequencerConfigured(), provider: PROVIDER_LABEL[activeProvider()], candidates: pushCandidates() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { enrollmentIds?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const ids = Array.isArray(body.enrollmentIds) ? body.enrollmentIds.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
  if (ids.length === 0) return NextResponse.json({ error: "enrollmentIds required" }, { status: 400 });
  const result = await pushApproved(ids, (await currentActor()).label);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}

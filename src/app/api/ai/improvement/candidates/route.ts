// Self-Improvement Controller — improvement CANDIDATES (Phase 2.5). Read-only: the app's own failure signals
// (recurring audit failures + failed jobs), annotated with whether an active run already tracks each and
// whether a human may open one now. Owner/admin only (it is a governance surface); NO token path — the
// agent reads its work from the bridge, not from here. Opening a run goes through POST /api/ai/improvement.

import { NextResponse } from "next/server";
import { scanImprovementSignals, enrichCandidates } from "@/lib/ai/improvement/signals";
import { listActiveRuns } from "@/lib/ai/improvement/store";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const active = listActiveRuns().map((r) => ({ id: r.id, requestId: r.requestId }));
  const candidates = enrichCandidates(scanImprovementSignals(), active);
  return NextResponse.json({ ok: true, candidates });
}

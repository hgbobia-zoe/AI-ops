// Provider Benchmarking — start an experiment. Freezes the inputs and builds the generation matrix (case ×
// provider), enqueuing one generation per enabled provider through the EXISTING async pipeline. provider+model
// are prescriptive. Returns the fresh detail bundle so the UI shows the pending matrix immediately.

import { NextResponse } from "next/server";
import { startExperiment, buildDetail } from "@/lib/creative/experimentService";
import { currentActor } from "@/lib/auth/getSession";
import { publicOrigin } from "@/lib/http/origin";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const actor = (await currentActor()).label;
  const outcome = await startExperiment(id, actor, publicOrigin(req));
  if (!outcome.ok) {
    const status = outcome.error === "not_found" ? 404 : outcome.error === "already_started" ? 409 : 400;
    return NextResponse.json({ ok: false, error: outcome.error }, { status });
  }
  const detail = buildDetail(id);
  return NextResponse.json({ ok: true, ...(detail ?? {}) });
}

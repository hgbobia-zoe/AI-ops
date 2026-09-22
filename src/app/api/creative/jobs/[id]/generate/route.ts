// Generate (or regenerate) a job — runs the full attempt: art-direct → active provider → persist → QC →
// advance status. Uses the model-agnostic provider (mock by default, so it works with no external key).

import { NextResponse } from "next/server";
import { getJob, listGenerations, listEvents } from "@/lib/creative/store";
import { generateForJob } from "@/lib/creative/service";
import { currentActor } from "@/lib/auth/getSession";
import { publicOrigin } from "@/lib/http/origin";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  if (!getJob(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Absolute origin so an async provider (n8n) can build absolute image + callback URLs it can fetch/reach.
  const outcome = await generateForJob(id, (await currentActor()).label, { origin: publicOrigin(req) });
  return NextResponse.json({
    ok: outcome.ok,
    error: outcome.error,
    pending: outcome.pending ?? false,
    job: outcome.job ?? getJob(id),
    generations: listGenerations(id),
    events: listEvents(id),
  });
}

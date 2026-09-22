// Creative jobs — list + create. Staff-only (proxy denies guests on /api/*). Creating a job composes the
// Image Brief immediately (via the Art Director) so the user can see WHY before generating.

import { NextResponse } from "next/server";
import { listJobs, createJob } from "@/lib/creative/store";
import { ensureBrief } from "@/lib/creative/service";
import { currentActor } from "@/lib/auth/getSession";
import type { CreativeJobInput } from "@/lib/creative/types";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({ jobs: listJobs() });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: CreativeJobInput;
  try {
    body = (await req.json()) as CreativeJobInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.title || !body.title.trim()) return NextResponse.json({ error: "title_required" }, { status: 400 });
  const actor = (await currentActor()).label;
  const created = createJob(body, actor);
  // Compose the brief now (deterministic; optionally AI-refined). Non-fatal if it can't.
  const withBrief = await ensureBrief(created.id, actor);
  return NextResponse.json({ ok: true, job: withBrief ?? created });
}

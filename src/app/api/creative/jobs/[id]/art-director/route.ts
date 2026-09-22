// Re-run the Art Director for a job — recompose the Image Brief from the current job + Visual DNA.
// Deterministic floor + optional LLM refine; the response returns the fresh job (with brief).

import { NextResponse } from "next/server";
import { getJob } from "@/lib/creative/store";
import { rebuildBrief } from "@/lib/creative/service";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  if (!getJob(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const job = await rebuildBrief(id, (await currentActor()).label);
  return NextResponse.json({ ok: true, job });
}

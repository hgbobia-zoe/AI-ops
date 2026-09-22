// A single creative job — GET the full detail (job + generations + events), PATCH editable fields.
// Editing rebuilds the Image Brief so it always reflects the current definition.

import { NextResponse } from "next/server";
import { getJob, listGenerations, listEvents } from "@/lib/creative/store";
import { updateJobAndRebuild } from "@/lib/creative/service";
import { currentActor } from "@/lib/auth/getSession";
import type { CreativeJobInput } from "@/lib/creative/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ job, generations: listGenerations(id), events: listEvents(id) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  if (!getJob(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let body: CreativeJobInput;
  try {
    body = (await req.json()) as CreativeJobInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const actor = (await currentActor()).label;
  const job = await updateJobAndRebuild(id, body, actor);
  return NextResponse.json({ ok: true, job });
}

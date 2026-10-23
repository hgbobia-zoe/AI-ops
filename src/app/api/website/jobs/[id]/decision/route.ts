// Website Studio — a human approves or discards a job that is in `preview`. This flips the state the office
// runner is WAITING on: approve → the runner pushes the branch + opens a PR; discard → the runner deletes
// the branch + restores the local site. Role-gated (canUseWebsiteStudio) — the proxy enforces it coarsely
// too. Approving opens a PR for a human to review+merge; it still does NOT put anything live.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canUseWebsiteStudio } from "@/lib/auth/roles";
import { decideJob } from "@/lib/website/jobs";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canUseWebsiteStudio(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  let body: { decision?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const decision = (body.decision ?? "").trim();
  if (decision !== "approve" && decision !== "discard") {
    return NextResponse.json({ error: "decision must be 'approve' or 'discard'" }, { status: 400 });
  }

  const actor = (await currentActor()).label;
  const job = decideJob(id, decision, actor);
  if (!job) return NextResponse.json({ error: "not_in_preview_or_missing" }, { status: 409 });
  return NextResponse.json({ ok: true, job });
}

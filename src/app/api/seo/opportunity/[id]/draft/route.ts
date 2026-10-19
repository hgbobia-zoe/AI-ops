// POST /api/seo/opportunity/[id]/draft  — produce (or fetch) the landing-page draft for an approved
//                                          opportunity. body { force?: boolean }.
// GET  /api/seo/opportunity/[id]/draft  — fetch the current draft + a freshly computed quality report.
//
// Owner/admin only (gated with the rest of /api/seo; re-checked here). Content production is gated behind the
// opportunity-approval decision (produceDraft enforces it) and NEVER publishes — the furthest it goes is a
// DRAFT awaiting human review.

import { NextResponse } from "next/server";
import { produceDraft, draftWithQuality } from "@/lib/seo/produce";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const dq = draftWithQuality(id);
  if (!dq) return NextResponse.json({ error: "no_draft" }, { status: 404 });
  return NextResponse.json({ ok: true, draft: dq.draft, quality: dq.quality });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  let body: { force?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body is fine */
  }
  const actor = (await currentActor()).label;
  const result = produceDraft(id, { force: body.force, actor });
  if (!result.ok) {
    const code = result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error, note: result.note }, { status: code });
  }
  return NextResponse.json({ ok: true, draft: result.draft, quality: result.quality, created: result.created, note: result.note });
}

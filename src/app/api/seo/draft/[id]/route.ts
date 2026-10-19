// GET  /api/seo/draft/[id]  — one page draft + a freshly computed quality report + its opportunity + history.
// POST /api/seo/draft/[id]  — the REVIEW gate. body { op: "submit" | "approve" | "reject" | "reopen", note? }.
//                             Each transition is human-driven and logged; NONE publishes a page (publishing is
//                             a separate authorized step outside this engine).
//
// Owner/admin only (gated with the rest of /api/seo; re-checked here).

import { NextResponse } from "next/server";
import { getDraft, submitForReview, approveDraft, rejectDraft, reopenDraft, type ReviewResult } from "@/lib/seo/draftStore";
import { getOpportunity, decisionHistory } from "@/lib/seo/store";
import { runQualityChecks } from "@/lib/seo/quality";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import type { PageDraft } from "@/lib/seo/types";

export const dynamic = "force-dynamic";

function detail(draft: PageDraft): NextResponse {
  const opportunity = getOpportunity(draft.opportunityId);
  return NextResponse.json({
    ok: true,
    draft,
    quality: runQualityChecks(draft),
    opportunity,
    history: decisionHistory(draft.opportunityId),
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const draft = getDraft(id);
  if (!draft) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return detail(draft);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  let body: { op?: string; note?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const actor = (await currentActor()).label;
  const note = body.note ?? null;
  let res: ReviewResult;
  switch ((body.op ?? "").toLowerCase()) {
    case "submit":
      res = submitForReview(id, actor, note);
      break;
    case "approve":
      res = approveDraft(id, actor, note);
      break;
    case "reject":
      res = rejectDraft(id, actor, note);
      break;
    case "reopen":
      res = reopenDraft(id, actor);
      break;
    default:
      return NextResponse.json({ error: "bad_op" }, { status: 400 });
  }

  if (!res.ok || !res.draft) {
    const code = res.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: res.error ?? "transition_failed" }, { status: code });
  }
  return detail(res.draft);
}

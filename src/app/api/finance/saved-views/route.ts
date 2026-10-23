// Financial Intelligence — Stage 7b saved-views API. TEAM-LEVEL named dashboard states.
// GET    → list all saved views.
// POST   → create/update (idempotent by name) {name, state}.
// DELETE → remove one by ?id= or ?name=.
// Owner/admin only: the proxy already gates all of /api/finance to owner/admin, and we re-check in-handler
// (canSeeFinancials — the same bar as the blade) so the gate holds even with auth disabled (→ owner) and as
// defense-in-depth. Every mutation writes an audit row with the acting human.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { listFinanceSavedViews, saveFinanceSavedView, deleteFinanceSavedView } from "@/lib/finance/savedViews";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canSeeFinancials(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ views: listFinanceSavedViews() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canSeeFinancials(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { name?: unknown; state?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const actor = await currentActor();
  const view = saveFinanceSavedView({ name: body.name, state: body.state, actor: actor.label });
  if (!view) return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({ actor: actor.label, action: "finance.saved_view.save", entity: "finance_saved_view", entityId: view.id, after: view });
  } catch {
    /* best-effort audit */
  }
  return NextResponse.json({ ok: true, view });
}

export async function DELETE(req: Request): Promise<NextResponse> {
  if (!canSeeFinancials(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const name = url.searchParams.get("name");
  if (!id && !name) return NextResponse.json({ error: "missing_selector" }, { status: 400 });
  const removed = deleteFinanceSavedView({ id, name });
  if (removed) {
    try {
      const { insertAudit } = await import("@/lib/db/repo");
      const actor = await currentActor();
      insertAudit({ actor: actor.label, action: "finance.saved_view.delete", entity: "finance_saved_view", entityId: id ?? name ?? "" });
    } catch {
      /* best-effort audit */
    }
  }
  return NextResponse.json({ ok: true, removed });
}

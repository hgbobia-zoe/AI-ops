// Manual cost-entry API (FI Stage 5, G9) — owner/admin only. Lets a human add / edit / delete a
// `source='manual'` cost row on a project (sub-rental, subcontractor, vehicle, fuel, consumables,
// event expense, other). A manual entry is a real figure a human stands behind → amount_status=ACTUAL.
// Every write is RBAC-gated (canSeeFinancials — the same owner/admin bar as the rest of the money UI),
// audited via insertAudit, and idempotent on a stable source_ref. The per-project snapshot (PR #125)
// rolls these DIRECT rows up automatically.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { validateManualCost, manualCostEntry } from "@/lib/finance/costFamilies";
import { listManualCostEntries, upsertManualCostEntry, deleteManualCostEntry } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!canSeeFinancials(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const projectId = new URL(req.url).searchParams.get("projectId")?.trim();
  if (!projectId) return NextResponse.json({ error: "projectId_required" }, { status: 400 });
  return NextResponse.json({ entries: listManualCostEntries(projectId) });
}

interface PostBody {
  projectId?: string;
  type?: string;
  class?: string;
  amount?: number | null;
  note?: string | null;
  /** Present on an EDIT: the existing entry's source_ref (idempotent upsert in place). */
  sourceRef?: string;
}

export async function POST(req: Request): Promise<Response> {
  if (!canSeeFinancials(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as PostBody;
  const v = validateManualCost({ eventId: b.projectId ?? "", type: b.type ?? "", class: b.class ?? "", amount: b.amount ?? null, note: b.note ?? null });
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  // Reuse the given source_ref on an edit (so it updates in place); mint a stable one on create.
  const sourceRef = typeof b.sourceRef === "string" && b.sourceRef.startsWith("manual:") ? b.sourceRef : `manual:${v.value.eventId}:${randomUUID()}`;
  const actor = await currentActor();
  const entry = upsertManualCostEntry(manualCostEntry(v.value, sourceRef, actor.label));

  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({ actor: actor.label, action: "finance.cost-entry.upsert", entity: "cost_entry", entityId: sourceRef, after: { projectId: v.value.eventId, type: v.value.type, class: v.value.klass, amount: v.value.amount } });
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ ok: true, entry });
}

export async function DELETE(req: Request): Promise<Response> {
  if (!canSeeFinancials(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { sourceRef?: string };
  const sourceRef = typeof body.sourceRef === "string" ? body.sourceRef.trim() : new URL(req.url).searchParams.get("sourceRef")?.trim() ?? "";
  if (!sourceRef || !sourceRef.startsWith("manual:")) return NextResponse.json({ error: "invalid_source_ref" }, { status: 400 });
  const deleted = deleteManualCostEntry(sourceRef);
  if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const { insertAudit } = await import("@/lib/db/repo");
    const actor = await currentActor();
    insertAudit({ actor: actor.label, action: "finance.cost-entry.delete", entity: "cost_entry", entityId: sourceRef });
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ ok: true, deleted: true });
}

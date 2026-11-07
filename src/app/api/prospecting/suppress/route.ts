// The shared do-not-contact list (Radar prospecting AND Sales OS texts). GET lists it (any staff who can
// see Radar); POST adds an email / domain / company / phone; DELETE removes one by id. Adding is open to
// anyone who can work outreach (adding is always the safe direction); removing is owner/admin only.

import { NextResponse } from "next/server";
import { addSuppression, getSuppression, removeSuppression, SUPPRESSION_KINDS, type SuppressionKind } from "@/lib/prospecting/store";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { insertAudit } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({ ok: true, entries: getSuppression() });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { kind?: string; value?: string; reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const kind = body.kind as SuppressionKind | undefined;
  const value = (body.value ?? "").trim().slice(0, 200);
  if (!kind || !SUPPRESSION_KINDS.includes(kind) || !value) {
    return NextResponse.json({ error: `kind (${SUPPRESSION_KINDS.join("|")}) and value required` }, { status: 400 });
  }
  const actor = (await currentActor()).label;
  addSuppression(kind, value, (body.reason ?? "").slice(0, 200) || null, actor, new Date());
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const removed = removeSuppression(id);
  if (removed) {
    try {
      insertAudit({ actor: (await currentActor()).label, action: "prospecting.suppression_removed", entity: "prospect_suppression", entityId: id });
    } catch { /* observability only */ }
  }
  return NextResponse.json({ ok: true, removed });
}

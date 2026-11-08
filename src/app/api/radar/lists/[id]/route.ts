// One purchased list. PATCH = edit its details (name, segment, vendor, cost, purchase date, campaign id,
// notes). DELETE = remove a list imported by mistake (refused once anyone on it was emailed). Owner/admin.

import { NextResponse } from "next/server";
import { updateList, deleteList, isListSegment } from "@/lib/prospecting/lists";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  let b: { name?: string; segment?: string; vendor?: string | null; cost?: number | string | null; purchasedAt?: string | null; campaignId?: string | null; notes?: string | null };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (b.segment !== undefined && !isListSegment(b.segment)) return NextResponse.json({ error: "unknown segment" }, { status: 400 });
  const cost = b.cost === undefined ? undefined : b.cost === "" || b.cost === null ? null : Number(String(b.cost).replace(/[$,\s]/g, ""));
  try {
    const list = updateList(id, {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(isListSegment(b.segment) ? { segment: b.segment } : {}),
      ...(b.vendor !== undefined ? { vendor: b.vendor } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(b.purchasedAt !== undefined ? { purchasedAt: b.purchasedAt || null } : {}),
      ...(b.campaignId !== undefined ? { campaignId: b.campaignId || null } : {}),
      ...(b.notes !== undefined ? { notes: b.notes } : {}),
    });
    if (!list) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, list });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const r = deleteList(id);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === "not found" ? 404 : 409 });
  return NextResponse.json({ ok: true });
}

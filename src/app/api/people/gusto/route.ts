// New in Gusto actions: add a net-new Gusto person to People, or keep them off the list. Owner/admin only
// (canManageUsers; the proxy also gates /api/people). Both are attributed to the signed-in person.

import { NextResponse } from "next/server";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageUsers } from "@/lib/auth/roles";
import { addFromGusto, hideFromGusto } from "@/lib/people/gustoNewHires";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { action?: string; id?: string; policyId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ ok: false, message: "id required" }, { status: 400 });
  const actor = (await currentActor()).label;
  const r =
    body.action === "add" ? addFromGusto(id, (body.policyId ?? "").trim(), actor)
    : body.action === "hide" ? hideFromGusto(id, actor)
    : { ok: false, message: "bad action" };
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}

// Staff matching: run it now, or confirm a link from an exception. Owner/admin only (canManageUsers; the
// proxy also gates /api/people). Confirming a link is a person attesting who an account belongs to; it is
// validated (the account exists, nobody else holds it) and audited with their name.

import { NextResponse } from "next/server";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageUsers } from "@/lib/auth/roles";
import { confirmLink, runStaffMatching } from "@/lib/people/matchRun";
import type { LinkField } from "@/lib/people/match";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { action?: string; employeeId?: string; field?: string; value?: string | number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const actor = (await currentActor()).label;

  if (body.action === "run") {
    const r = await runStaffMatching(actor);
    return NextResponse.json({
      ok: true,
      message: `${r.created.length} added, ${r.linked.length} linked, ${r.exceptions.length} to sort out.`,
    });
  }
  if (body.action === "link") {
    if (!body.employeeId || !body.field || body.value == null) return NextResponse.json({ ok: false, message: "employeeId, field and value required" }, { status: 400 });
    const r = await confirmLink(body.employeeId, body.field as LinkField, body.value, actor);
    return NextResponse.json(r, { status: r.ok ? 200 : 409 });
  }
  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}

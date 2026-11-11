// Dismiss one Goodshuffle write-back that is stuck or dead-lettered, from the Automation page. Owner/admin
// only. A reason is required and the signed-in person is recorded, so every dismissal is on record. The op
// becomes 'dismissed': it never retries and stops counting toward the write-back alarm.
//
// Body: { id: string, reason: string }

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { dismissGsOp } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageSettings(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { id?: string; reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  const reason = (body.reason ?? "").trim().slice(0, 500);
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (reason.length < 3) return NextResponse.json({ error: "Add a short reason so the dismissal is on record." }, { status: 400 });

  const by = (await currentActor()).label;
  const r = dismissGsOp(id, by, reason);
  if (!r.ok && r.reason === "not_found") return NextResponse.json({ error: "write-back not found" }, { status: 404 });
  if (!r.ok) return NextResponse.json({ ok: true, already: true, status: r.from });
  return NextResponse.json({ ok: true, from: r.from });
}

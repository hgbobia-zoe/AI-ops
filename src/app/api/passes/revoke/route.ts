// Revoke a Shift Pass — kills it immediately. Owner/Admin only (proxy gates /api/passes). Takes effect
// on the contractor's next board load/refresh, where the console layout re-checks the pass against the DB.

import { NextResponse } from "next/server";
import { revokeShiftPass } from "@/lib/db/repo";
import { passStatus } from "@/lib/auth/pass";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });

  const pass = revokeShiftPass(id);
  if (!pass) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, pass: { ...pass, status: passStatus(pass) } });
}

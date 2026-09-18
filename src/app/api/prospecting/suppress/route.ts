// Add an email / domain / company to the do-not-contact (suppression) list. Gated to settings managers.

import { NextResponse } from "next/server";
import { addSuppression } from "@/lib/prospecting/store";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { kind?: string; value?: string; reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const kind = body.kind;
  const value = (body.value ?? "").trim();
  if (!["email", "domain", "company"].includes(kind ?? "") || !value) return NextResponse.json({ error: "kind (email|domain|company) and value required" }, { status: 400 });
  addSuppression(kind as "email" | "domain" | "company", value, body.reason ?? null, (await currentActor()).label, new Date());
  return NextResponse.json({ ok: true });
}

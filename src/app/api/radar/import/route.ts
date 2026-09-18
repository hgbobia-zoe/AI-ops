// Manual import of REAL opportunities (CSV paste or JSON rows) → the real pipeline (is_seed=0). The
// zero-setup way to feed real data. Gated to users who can manage settings.

import { NextResponse } from "next/server";
import { importCsv, runImport } from "@/lib/opportunity/import";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { csv?: string; rows?: Record<string, string>[]; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const label = (body.label ?? "paste").slice(0, 60);
  try {
    const result = body.csv != null ? await importCsv(body.csv, label) : Array.isArray(body.rows) ? await runImport(body.rows, label) : null;
    if (!result) return NextResponse.json({ error: "provide csv or rows" }, { status: 400 });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

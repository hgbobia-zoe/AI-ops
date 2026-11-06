// POST /api/payroll/gusto/progress — the extension's Gusto push/submit scripts report each step as it happens
// ("opening the run", "choosing wire", "writing hours 3 of 8"…) so the Run payroll dialog can show live
// progress instead of a bare spinner. Hit cross-origin from the logged-in app.gusto.com tab, so it mirrors
// /api/payroll/gusto/push-result: force-dynamic, CORS to app.gusto.com, GS_INGEST_TOKEN (fail-open), public in
// the proxy. It stores only the latest step (no payroll data, no names); the status endpoint reads it.

import { NextResponse } from "next/server";
import { recordGustoProgress } from "@/lib/payroll/gustoProgress";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://app.gusto.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const str = (v: unknown, max = 120): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function POST(req: Request): Promise<NextResponse> {
  const token = process.env.GS_INGEST_TOKEN;
  if (token && req.headers.get("x-publish-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  const body = (await req.json().catch(() => null)) as { kind?: unknown; stage?: unknown; detail?: unknown } | null;
  const kind = body?.kind === "submit" ? "submit" : "push";
  const stage = str(body?.stage, 40);
  if (!stage) return NextResponse.json({ error: "stage required" }, { status: 400, headers: CORS });
  recordGustoProgress({ kind, stage, detail: str(body?.detail) });
  return NextResponse.json({ ok: true }, { headers: CORS });
}

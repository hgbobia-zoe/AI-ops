// Route-health check on demand — finds routes still open past their delivery date and posts the deduped
// Slack alert (same code the server-side timer runs every 15 min). Token-gated so it can be hit manually
// or by an external cron; the automatic timer means this endpoint is optional. Reuses REANALYZE_TOKEN as
// the shared internal-jobs secret. GET returns the current issues WITHOUT alerting (a read-only preview).

import { NextResponse } from "next/server";
import { findRouteHealthIssues, runRouteHealthCheck } from "@/lib/dispatch/routeHealth";

export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const secret = process.env.REANALYZE_TOKEN?.trim();
  if (!secret) return false; // fail closed
  const url = new URL(req.url);
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return bearer === secret || req.headers.get("x-reanalyze-token")?.trim() === secret || url.searchParams.get("token")?.trim() === secret;
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!process.env.REANALYZE_TOKEN?.trim()) return NextResponse.json({ error: "not configured (set REANALYZE_TOKEN)" }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, issues: findRouteHealthIssues() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!process.env.REANALYZE_TOKEN?.trim()) return NextResponse.json({ error: "not configured (set REANALYZE_TOKEN)" }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const res = await runRouteHealthCheck();
  return NextResponse.json({ ok: true, ...res });
}

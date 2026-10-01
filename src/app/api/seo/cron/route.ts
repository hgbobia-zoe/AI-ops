// SEO Growth — scheduled discovery pull. Point any scheduler (Fly scheduled machine, cron-job.org, GitHub
// Actions, …) at this endpoint to auto-run keyword discovery so opportunities self-populate. Mirrors
// /api/radar/cron.
//
// Auth: SEO_INGEST_TOKEN via ?token= or the x-seo-token header. Fails OPEN only when the token is unset (dev);
// once set, a caller must present it. Public in the proxy (token, not a session). Idempotent — discovery
// upserts by dedupe key, so a scheduler can hit it freely. With no Ubersuggest credential it pulls nothing
// (honest), so this is safe to schedule before the credential is live.

import { NextResponse } from "next/server";
import { discover } from "@/lib/seo/discovery";

export const dynamic = "force-dynamic";

async function run(req: Request): Promise<NextResponse> {
  const token = process.env.SEO_INGEST_TOKEN;
  if (token) {
    const provided = req.headers.get("x-seo-token") || new URL(req.url).searchParams.get("token") || "";
    if (provided !== token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await discover();
  return NextResponse.json({ ok: true, ranAt: result.ranAt, result });
}

export async function GET(req: Request): Promise<NextResponse> {
  return run(req);
}

export async function POST(req: Request): Promise<NextResponse> {
  return run(req);
}

// GET /api/seo/health — the SEO integration health. Owner/admin only (gated in the proxy alongside the rest of
// /api/seo). The SEO source is now the office SERP runner: the SERVER cannot read Google (datacenter IP), so
// health is FRESHNESS-based (derived from the stored ingest diagnostics), NOT a server-side probe. It never
// fabricates a "connected" state — "never" until the runner has pushed, then ok/stale/error from real ingests.

import { NextResponse } from "next/server";
import { serpHealth } from "@/lib/seo/watcher";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ health: serpHealth(), at: new Date().toISOString() });
}

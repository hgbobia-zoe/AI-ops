// Route prune — the sanitize half of the pull. The office pull is authoritative for the horizon it
// sweeps; after a FULL successful sweep it POSTs the routes GS actually has, and this drops any of OUR
// `ready` routes on a swept date that GS no longer returns (moved/cancelled — e.g. a delivery
// reassigned to another truck). The import is additive and never removed anything, so stale routes
// used to linger forever. Safety lives in pruneStaleRoutes (only swept dates, only `ready` routes).
//
// Same auth/CORS as /api/route/import: the bookmarklet/extension runs inside a logged-in Goodshuffle
// tab and carries the ingest token.

import { NextResponse } from "next/server";
import { pruneStaleRoutes } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://pro.goodshuffle.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  const publishToken = process.env.GS_INGEST_TOKEN;
  if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: { dates?: unknown; keepRouteIds?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  const dates = Array.isArray(body.dates) ? body.dates.filter((d): d is string => typeof d === "string") : [];
  const keepRouteIds = Array.isArray(body.keepRouteIds)
    ? body.keepRouteIds.filter((r): r is string => typeof r === "string")
    : [];
  if (dates.length === 0) {
    // Nothing positively swept → prune nothing (never wipe on an empty/failed sweep).
    return NextResponse.json({ deleted: [] }, { headers: CORS });
  }
  const { deleted } = pruneStaleRoutes(dates, keepRouteIds);
  return NextResponse.json({ deleted }, { headers: CORS });
}

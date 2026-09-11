// Warehouse-Desktop team check — CANDIDATE list. The office extension (a logged-in GSPRO session)
// GETs this to learn which upcoming SIGNED projects it should verify. For each, the extension reads
// GSPRO ground truth (initAddTeamPanel.linkedUserMap) and POSTs the ones still MISSING the Warehouse
// Desktop account to /api/gs/wd-check/report. The server can't read GSPRO itself (Cloudflare blocks
// datacenter IPs), so the check has to run inside the browser session — this endpoint just supplies
// the shortlist. CORS-open to the GSPRO origin; same optional GS_INGEST_TOKEN as the other ingest
// endpoints (fail-open until set).

import { NextResponse } from "next/server";
import { listUpcomingSignedForTeamCheck, WAREHOUSE_DESKTOP_USER_ID } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://pro.goodshuffle.com",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

// How far ahead an "upcoming" project reaches (days). The warehouse needs to see signed work with
// enough lead time to stage it; 14 days matches the risk board's near-term horizon.
const WINDOW_DAYS = 14;

export function GET(req: Request): NextResponse {
  const publishToken = process.env.GS_INGEST_TOKEN;
  if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  const projects = listUpcomingSignedForTeamCheck(WINDOW_DAYS);
  // The Warehouse Desktop user id the extension checks each project's team for.
  return NextResponse.json({ ok: true, warehouseUserId: WAREHOUSE_DESKTOP_USER_ID, projects }, { headers: CORS });
}

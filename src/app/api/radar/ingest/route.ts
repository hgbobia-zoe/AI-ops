// Opportunity Radar — browser-agent ingest endpoint (§15). The LOCAL browser agent runs a defined
// per-source workflow on a portal that has no API, extracts rows, and POSTs them here. Same shape as
// the Goodshuffle Auto-Pull ingest: CORS-restricted, token-gated (RADAR_INGEST_TOKEN — fail-open until
// set, like GS_INGEST_TOKEN), never trusts the payload as code. Records flow through the identical
// normalize → classify → dedupe → change-detect → store pipeline.
//
// Body: { sourceId: string, records: RawOpportunity-ish[], capturedAt?: string }

import { NextResponse } from "next/server";
import { runOpportunitySource } from "@/lib/opportunity/ingest";
import { getWorkflow, coerceRecord, buildBrowserSource } from "@/lib/opportunity/sources/browser";

export const dynamic = "force-dynamic";

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-radar-token",
    Vary: "Origin",
  };
}

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: cors(req) });
}

export async function POST(req: Request): Promise<NextResponse> {
  const headers = cors(req);
  const token = process.env.RADAR_INGEST_TOKEN;
  if (token && req.headers.get("x-radar-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  }
  let body: { sourceId?: string; records?: unknown[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers });
  }
  const sourceId = (body.sourceId ?? "").trim();
  const workflow = getWorkflow(sourceId);
  if (!workflow) return NextResponse.json({ error: "unknown sourceId (no registered browser workflow)" }, { status: 400, headers });

  const records = (Array.isArray(body.records) ? body.records : []).map(coerceRecord).filter((r): r is NonNullable<typeof r> => r !== null);
  if (records.length === 0) return NextResponse.json({ error: "no valid records" }, { status: 400, headers });

  const result = await runOpportunitySource(buildBrowserSource(workflow, records));
  return NextResponse.json({ ok: true, ...result }, { headers });
}

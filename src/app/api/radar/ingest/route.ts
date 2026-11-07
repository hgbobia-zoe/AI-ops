// Opportunity Radar — browser-agent ingest endpoint (§15). The LOCAL browser agent runs a defined
// per-source workflow on a portal that has no API, extracts rows, and POSTs them here. Same shape as
// the Goodshuffle Auto-Pull ingest: token-gated by RADAR_INGEST_TOKEN (x-radar-token header), FAIL CLOSED
// (503 when the token is unset, 401 when wrong), never trusts the payload as code. CORS is answered only
// for the Chrome extension's own origin. Records flow through the identical normalize → classify →
// dedupe → change-detect → store pipeline. Capped at MAX_RECORDS per call.
//
// Body: { sourceId: string, records: RawOpportunity-ish[], capturedAt?: string }

import { NextResponse } from "next/server";
import { runOpportunitySource } from "@/lib/opportunity/ingest";
import { getWorkflow, coerceRecord, buildBrowserSource } from "@/lib/opportunity/sources/browser";
import { requireMachineToken } from "@/lib/auth/machineToken";

export const dynamic = "force-dynamic";

const MAX_RECORDS = 500;

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": origin.startsWith("chrome-extension://") ? origin : "null",
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
  const denied = requireMachineToken(req, { env: "RADAR_INGEST_TOKEN", header: "x-radar-token", headers });
  if (denied) return denied;
  let body: { sourceId?: string; records?: unknown[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers });
  }
  const sourceId = (body.sourceId ?? "").trim();
  const workflow = getWorkflow(sourceId);
  if (!workflow) return NextResponse.json({ error: "unknown sourceId (no registered browser workflow)" }, { status: 400, headers });

  if (Array.isArray(body.records) && body.records.length > MAX_RECORDS) {
    return NextResponse.json({ error: `too many records (max ${MAX_RECORDS} per call)` }, { status: 413, headers });
  }
  const records = (Array.isArray(body.records) ? body.records : []).map(coerceRecord).filter((r): r is NonNullable<typeof r> => r !== null);
  if (records.length === 0) return NextResponse.json({ error: "no valid records" }, { status: 400, headers });

  const result = await runOpportunitySource(buildBrowserSource(workflow, records));
  return NextResponse.json({ ok: true, ...result }, { headers });
}

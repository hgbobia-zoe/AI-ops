// Ignition etaLink mint — RESULT sink. The Auto-Pull extension's Ignition content script posts the
// minted link back here, keyed by the mint request id. A `code` (or full `url`) marks the row minted
// (→ the public https://ignition.zonarsystems.com/etaLink/<code> URL); an `error` marks it failed so
// the departure flow stops waiting and the /track fallback stands (never a fabricated link).
//
//   POST /api/etalink/result { id, code? , url?, error? }
//
// CORS-LOCKED to https://ignition.zonarsystems.com only; token-gated by GS_INGEST_TOKEN (fail-open),
// like the other ingest endpoints.

import { NextResponse } from "next/server";
import { recordEtaLinkResult } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://ignition.zonarsystems.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function tokenDenied(req: Request): NextResponse | null {
  const token = process.env.GS_INGEST_TOKEN;
  if (token && req.headers.get("x-publish-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  return null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = tokenDenied(req);
  if (denied) return denied;
  let body: { id?: string; code?: string; url?: string; error?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400, headers: CORS });
  }
  recordEtaLinkResult(body.id, { code: body.code, url: body.url, error: body.error });
  return NextResponse.json({ ok: true }, { headers: CORS });
}

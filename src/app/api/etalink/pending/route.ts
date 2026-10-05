// Ignition etaLink mint — PENDING feed for the Auto-Pull extension's Ignition content script.
// A logged-in ignition.zonarsystems.com tab on the OFFICE MACHINE polls this, replays Zonar's
// createEtaLink for each request, and posts the result to /api/etalink/result. Our server can't call
// Ignition itself (Cloudflare + Cognito-gated AppSync), so this browser-replay is the only path —
// the same model as the Goodshuffle outbox.
//
//   GET /api/etalink/pending?ready=1  → { requests: [ pending mint requests ] }
//
// `ready` tells us whether that tab is SIGNED IN (an IdToken is present → a mint can succeed), which
// gates the departure bounded-wait. CORS-LOCKED to https://ignition.zonarsystems.com only; token-gated
// by GS_INGEST_TOKEN (fail-open until set), exactly like the other ingest endpoints.

import { NextResponse } from "next/server";
import { listPendingEtaLinkMints } from "@/lib/db/repo";
import { markEtaLinkPoller } from "@/lib/pull/state";

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

export function GET(req: Request): NextResponse {
  const denied = tokenDenied(req);
  if (denied) return denied;
  const ready = new URL(req.url).searchParams.get("ready") === "1";
  markEtaLinkPoller(ready);
  return NextResponse.json({ requests: listPendingEtaLinkMints() }, { headers: CORS });
}

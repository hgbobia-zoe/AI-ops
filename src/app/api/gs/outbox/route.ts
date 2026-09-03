// Goodshuffle write-back outbox — the bridge for the DISPATCH → GOODSHUFFLE direction.
// Our server can't call Goodshuffle (Cloudflare blocks server-side requests), so a
// LOGGED-IN session (the kiosk WebView or the office "Pull Zoe Routes" bookmarklet)
// polls this for pending writes, replays each one with its own cookies, and acks it.
//
//   GET  /api/gs/outbox            → { ops: [ pending write-backs ] }
//   POST /api/gs/outbox { id, ok } → mark one done/failed (optional { error })
//
// CORS-open to the Goodshuffle origin so the bookmarklet (running on pro.goodshuffle.com)
// can read + ack. Same trust model as /api/route/import.

import { NextResponse } from "next/server";
import { listPendingGsOps, ackGsOp } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://pro.goodshuffle.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export function GET(): NextResponse {
  return NextResponse.json({ ops: listPendingGsOps() }, { headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { id?: string; ok?: boolean; error?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400, headers: CORS });
  }
  ackGsOp(body.id, body.ok !== false, body.error);
  return NextResponse.json({ ok: true }, { headers: CORS });
}

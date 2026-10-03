// Instawork import — the ingest endpoint the Auto-Pull browser extension POSTs to. The extension's
// content script (extension/instawork.js) runs INSIDE a logged-in app.instawork.com tab, fetches the gig
// groups same-origin (carrying the operator's session), and POSTs { results } here. We parse + save the
// snapshot (src/lib/instawork/store.ts) so every server read stays off Instawork entirely (no datacenter
// IP ever calls it). Mirrors src/app/api/route/import/route.ts: force-dynamic, CORS to the source origin,
// optional ingest-token gate (fail-open until GS_INGEST_TOKEN is set).

import { NextResponse } from "next/server";
import { saveInstaworkSnapshot } from "@/lib/instawork/store";
import { toShift } from "@/lib/instawork/parse";
import { recordPull, logImport } from "@/lib/pull/state";
import type { InstaworkShift } from "@/lib/instawork/types";

export const dynamic = "force-dynamic";

// CORS: allow the content script running INSIDE a logged-in app.instawork.com tab to POST the pulled
// shifts here. Restricted to the Instawork origin so only code running there (the operator's own session)
// can post. CORS is not a security control — the ingest token (below) is.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://app.instawork.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  // Gated by the ingest token once GS_INGEST_TOKEN is set (the extension carries it); fail-open until then.
  const publishToken = process.env.GS_INGEST_TOKEN;
  if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }

  let body: { results?: unknown[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  const rows = Array.isArray(body.results) ? (body.results as Array<Record<string, unknown>>) : [];
  const shifts = rows.map(toShift).filter((s): s is InstaworkShift => s !== null);

  saveInstaworkSnapshot(shifts, new Date().toISOString());
  recordPull("instawork", shifts.length);
  logImport("instawork", true, { detail: `${shifts.length} shifts` });

  return NextResponse.json({ ok: true, stored: shifts.length }, { headers: CORS });
}

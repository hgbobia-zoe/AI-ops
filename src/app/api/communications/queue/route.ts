// Communications queue — the live/recent unified feed of calls (call_events) + SMS (comms timeline),
// enriched with the calculated reason, matched customer/event, identity confidence, and open risk.
// Session-gated (the proxy gate applies). Filtering/sorting is done client-side over these rows.

import { NextResponse } from "next/server";
import { buildQueue } from "@/lib/comms/queue";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 80) || 80));
  return NextResponse.json({ rows: buildQueue(limit), generatedAt: new Date().toISOString() });
}

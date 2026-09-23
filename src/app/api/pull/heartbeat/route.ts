// Auto-Pull extension heartbeat. The office-machine extension posts its status here every cycle so
// the app can tell WHY data is (or isn't) fresh: "ok" (pulled), "no_tab" (no GSPRO tab open),
// "not_logged_in" (GSPRO session expired), or "error". Drives the PullHealthBanner. Same auth model
// as the other ingest endpoints (optional GS_INGEST_TOKEN, fail-open until set); CORS-open because
// the extension posts from the pro.goodshuffle.com origin (and from its own worker).

import { NextResponse } from "next/server";
import { recordAgentHeartbeat, type AgentStatus } from "@/lib/pull/state";
import { slackNotify } from "@/lib/notify/slack";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const VALID: AgentStatus[] = ["ok", "no_tab", "not_logged_in", "error"];

export async function POST(req: Request): Promise<NextResponse> {
  const publishToken = process.env.GS_INGEST_TOKEN;
  if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: { agent?: string; status?: string; detail?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  const status = VALID.includes(body.status as AgentStatus) ? (body.status as AgentStatus) : null;
  if (!status) return NextResponse.json({ error: "bad status" }, { status: 400, headers: CORS });
  const { alert } = recordAgentHeartbeat((body.agent ?? "extension").slice(0, 40), status, (body.detail ?? null)?.toString().slice(0, 200) ?? null);
  if (alert) void slackNotify(alert); // loud, deduped signal so a broken puller is caught fast
  return NextResponse.json({ ok: true }, { headers: CORS });
}

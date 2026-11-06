// New in Gusto ingest: the Auto-Pull extension (extension/gusto.js) posts here from a logged-in
// app.gusto.com tab during an on-demand "Sync Gusto now". Two steps, same endpoint:
//   { kind: "roster", roster, onboarding }  → the delta is worked out; answers { needDetails: [gustoIds] }
//   { kind: "details", details: { [id]: rawResponse } } → personal details, accepted ONLY for net-new ids
// Same gate as /api/payroll/gusto/import: CORS-locked to app.gusto.com, GS_INGEST_TOKEN when set.
// Public in the proxy (cross-origin from the Gusto tab, no app session).

import { NextResponse } from "next/server";
import { ingestGustoDetails, ingestGustoRoster, parseGustoDetails, parseGustoRoster } from "@/lib/people/gustoNewHires";
import { logImport } from "@/lib/pull/state";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://app.gusto.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  const token = process.env.GS_INGEST_TOKEN;
  if (token && req.headers.get("x-publish-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: { kind?: string; roster?: unknown; onboarding?: unknown; details?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  if (body.kind === "roster") {
    const roster = parseGustoRoster(body.roster, body.onboarding);
    // An empty roster is a signed-out or blocked tab, not "nobody works here": keep the last list.
    if (roster.length === 0) {
      logImport("gusto-new-hires", false, { detail: "0 people in the roster, likely signed out" });
      return NextResponse.json({ ok: false, needDetails: [], note: "empty roster, not stored" }, { headers: CORS });
    }
    const r = ingestGustoRoster(roster);
    logImport("gusto-new-hires", true, { detail: `${roster.length} in Gusto, ${r.netNew} new, ${r.linked} linked` });
    return NextResponse.json({ ok: true, ...r }, { headers: CORS });
  }

  if (body.kind === "details") {
    const parsed = Object.entries(body.details ?? {})
      .map(([id, raw]) => parseGustoDetails(id, raw))
      .filter((d): d is NonNullable<typeof d> => d != null);
    const r = ingestGustoDetails(parsed);
    return NextResponse.json({ ok: true, ...r }, { headers: CORS });
  }

  return NextResponse.json({ error: "bad_kind" }, { status: 400, headers: CORS });
}

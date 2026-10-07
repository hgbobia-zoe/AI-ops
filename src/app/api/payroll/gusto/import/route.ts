// Gusto import — the ingest endpoint the Auto-Pull browser extension (extension/gusto.js) POSTs to. The
// content script runs INSIDE a logged-in app.gusto.com tab, replays Gusto's GraphQL operations same-origin
// (carrying the operator's session), and POSTs the raw responses here. We parse + snapshot them, then
// reconcile workers against Connecteam (persisting Gusto mappings). The server NEVER calls Gusto itself.
// Mirrors /api/instawork/import: force-dynamic, CORS to the source origin, GS_INGEST_TOKEN gate (fail-open).
// Must be PUBLIC in the proxy (it's hit cross-origin by the Gusto tab, not an app session).

import { NextResponse } from "next/server";
import { parseGustoMembers, parseGustoPayPeriods, saveGustoSnapshot } from "@/lib/payroll/gustoSnapshot";
import { reconcileGustoFromSnapshot } from "@/lib/payroll/gustoMatch";
import { recordPull, logImport } from "@/lib/pull/state";

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

  let body: { members?: unknown; timeTracking?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  const members = parseGustoMembers(body.members);
  const payPeriods = parseGustoPayPeriods(body.timeTracking);

  // A pull that returned no members is almost certainly a signed-out / blocked tab — don't clobber a good
  // snapshot with an empty one (FACTS ONLY: empty ≠ "no workers").
  if (members.length === 0) {
    logImport("gusto", false, { detail: "0 members — likely signed out" });
    return NextResponse.json({ ok: false, members: 0, note: "no members parsed — not stored" }, { headers: CORS });
  }

  saveGustoSnapshot({ members, payPeriods, fetchedAt: new Date().toISOString() });
  let match: Awaited<ReturnType<typeof reconcileGustoFromSnapshot>> | null = null;
  try {
    match = await reconcileGustoFromSnapshot();
  } catch {
    /* matching is best-effort; the snapshot is still stored */
  }
  recordPull("gusto", members.length);
  logImport("gusto", true, { detail: `${members.length} members, ${payPeriods.length} periods${match ? `, ${match.matched} matched` : ""}` });

  return NextResponse.json({ ok: true, members: members.length, payPeriods: payPeriods.length, match }, { headers: CORS });
}

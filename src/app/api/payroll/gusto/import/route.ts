// Gusto import — the ingest endpoint the Auto-Pull browser extension (extension/gusto.js) POSTs to. The
// content script runs INSIDE a logged-in app.gusto.com tab, replays Gusto's GraphQL operations same-origin
// (carrying the operator's session), and POSTs the raw responses here. We parse + snapshot them, then
// reconcile workers against Connecteam (persisting Gusto mappings). The server NEVER calls Gusto itself.
// Mirrors /api/instawork/import: force-dynamic, CORS to the source origin, GS_INGEST_TOKEN gate (fail-open).
// Must be PUBLIC in the proxy (it's hit cross-origin by the Gusto tab, not an app session).

import { NextResponse } from "next/server";
import { trackStatus, type StatusAlert } from "@/lib/notify/status";
import { parseGustoMembers, parseGustoPayPeriods, attachPayRates, saveGustoSnapshot } from "@/lib/payroll/gustoSnapshot";
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

  let body: { members?: unknown; timeTracking?: unknown; pay?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  const members = attachPayRates(parseGustoMembers(body.members), body.pay);
  const payPeriods = parseGustoPayPeriods(body.timeTracking);

  // A pull that returned no members is almost certainly a signed-out / blocked tab — don't clobber a good
  // snapshot with an empty one (FACTS ONLY: empty ≠ "no workers").
  if (members.length === 0) {
    logImport("gusto", false, { detail: "0 members — likely signed out" });
    await trackStatus("gusto-session", true, gustoSessionAlert, { cooloffMs: 6 * 3_600_000 });
    return NextResponse.json({ ok: false, members: 0, note: "no members parsed — not stored" }, { headers: CORS });
  }

  saveGustoSnapshot({ members, payPeriods, fetchedAt: new Date().toISOString() });
  await trackStatus("gusto-session", false, gustoSessionAlert);
  let match: Awaited<ReturnType<typeof reconcileGustoFromSnapshot>> | null = null;
  try {
    match = await reconcileGustoFromSnapshot();
  } catch {
    /* matching is best-effort; the snapshot is still stored */
  }
  recordPull("gusto", members.length);
  logImport("gusto", true, {
    detail: `${members.length} members, ${payPeriods.length} periods${match ? `, ${match.matched} matched, ${match.ratesApplied} rates, ${match.connecteamRatesWritten}→CT` : ""}`,
  });

  return NextResponse.json({ ok: true, members: members.length, payPeriods: payPeriods.length, match }, { headers: CORS });
}

/** The status card for a signed-out Gusto tab (the import came back with no people). */
function gustoSessionAlert(state: "down" | "recovered", since: string | null): StatusAlert {
  return state === "down"
    ? {
        system: "Gusto",
        level: "down",
        title: "Gusto looks signed out",
        impact: "Payroll people, pay rates, and draft payroll pushes can't sync from Gusto.",
        fix: "Sign in to app.gusto.com in the office Chrome that runs the Auto-Pull extension.",
        since,
        detail: "The Gusto pull returned 0 people",
      }
    : { system: "Gusto", level: "recovered", title: "Gusto is signed in again", impact: "Payroll data is syncing from Gusto again.", since };
}

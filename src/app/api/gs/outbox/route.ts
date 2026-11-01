// Goodshuffle write-back outbox — the bridge for the DISPATCH → GOODSHUFFLE direction.
// Our server can't call Goodshuffle (Cloudflare blocks server-side requests), so a
// LOGGED-IN session (the kiosk WebView or the office "Pull Zoe Routes" bookmarklet)
// polls this for pending writes, replays each one with its own cookies, and acks it.
//
//   GET  /api/gs/outbox            → { ops: [ pending write-backs ] }
//   POST /api/gs/outbox { id, ok } → mark one done/failed (optional { error })
//   POST /api/gs/outbox { id, claim: true, holder } → { claimed }: take a single-runner lease first
//
// CORS-open to the Goodshuffle origin so the bookmarklet (running on pro.goodshuffle.com)
// can read + ack. Same trust model as /api/route/import.

import { NextResponse } from "next/server";
import { listPendingGsOps, ackGsOp, claimGsOp, getGsOpById } from "@/lib/db/repo";
import { getIntake } from "@/lib/intake/store";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://pro.goodshuffle.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

// The pending-write queue carries customer names/phones + GS ids, so gate reads too.
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
  return NextResponse.json({ ops: listPendingGsOps() }, { headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = tokenDenied(req);
  if (denied) return denied;
  let body: { id?: string; ok?: boolean; error?: string; claim?: boolean; holder?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400, headers: CORS });
  }
  // Claim: { id, claim: true, holder } → { claimed }. A drainer must win this BEFORE it acts on an op that
  // must run once (create_project), so several drainers never create the same project twice.
  if (body.claim === true) {
    const op = getGsOpById(body.id);
    if (!op || op.status !== "pending") {
      return NextResponse.json({ ok: true, claimed: false, reason: "not_pending" }, { headers: CORS });
    }
    // Backstop: a create whose intake already has its Goodshuffle project is finished, whatever the op says.
    const intakeId = op.op === "create_project" ? String((op.payload as { intakeId?: string } | undefined)?.intakeId ?? "") : "";
    const intake = intakeId ? getIntake(intakeId) : null;
    if (intake?.gsProjectId) {
      ackGsOp(op.id, true);
      return NextResponse.json({ ok: true, claimed: false, reason: "already_created" }, { headers: CORS });
    }
    const claimed = claimGsOp(body.id, String(body.holder ?? ""));
    return NextResponse.json({ ok: true, claimed, ...(claimed ? {} : { reason: "claimed_elsewhere" }) }, { headers: CORS });
  }
  // Require an EXPLICIT ok. A missing/ambiguous ack must not silently mark a Goodshuffle write-back
  // as done (which would leave our board and Goodshuffle diverged with no error). Absent = failed.
  if (typeof body.ok !== "boolean") {
    return NextResponse.json({ error: "explicit boolean ok required" }, { status: 400, headers: CORS });
  }
  // The ack applies the verification lifecycle: success confirms the linked approval; a failure retries
  // with backoff and dead-letters once the budget is exhausted (then the approval fails). Surface the
  // resulting op status so the drainer/telemetry can see what happened (additive, non-breaking).
  const res = ackGsOp(body.id, body.ok, body.error);
  return NextResponse.json({ ok: true, opStatus: res.status, approvalReconciledTo: res.approvalReconciledTo }, { headers: CORS });
}

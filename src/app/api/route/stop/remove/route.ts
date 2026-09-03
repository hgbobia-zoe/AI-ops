// Remove a stop from a route (dispatch pulls a stop). This is the DISPATCH → GOODSHUFFLE
// direction of the two-way sync: it drops the stop from our board immediately AND queues
// a Goodshuffle write-back (remove_waypoint) that a logged-in session replays, so the
// stop also comes off the Goodshuffle route. Office action on /dispatch (no auth yet;
// the board gates it behind the admin PIN).
//
// Body: { routeId: string, stopId: string }

import { NextResponse } from "next/server";
import { removeStop, enqueueGsOp } from "@/lib/db/repo";
import { slackNotify } from "@/lib/notify/slack";
import { logChange } from "@/lib/history/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { routeId?: string; stopId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { routeId, stopId } = body;
  if (!routeId || !stopId) {
    return NextResponse.json({ error: "routeId and stopId required" }, { status: 400 });
  }

  const removed = removeStop(routeId, stopId);
  if (!removed.ok) {
    return NextResponse.json({ error: "stop not found on that route" }, { status: 404 });
  }

  // Operational History: a stop was pulled off a route (idempotent by stopId — a stop is
  // removed at most once).
  logChange({
    source: "dispatch",
    entity: "stop",
    entityId: stopId,
    eventId: removed.txId || undefined,
    kind: "stop_removed",
    field: "route",
    fromValue: routeId,
    toValue: null,
    changeKey: `stop_removed|${stopId}`,
  });

  // Queue the Goodshuffle write-back only when we know the waypoint (transactionID) and
  // its route on the Goodshuffle side. Routes pulled before we captured those IDs won't
  // have them — the local removal still happens; the GS side is just skipped.
  let queued: ReturnType<typeof enqueueGsOp> | null = null;
  if (removed.txId && removed.gsRouteId) {
    queued = enqueueGsOp({
      op: "remove_waypoint",
      routeId,
      stopId,
      gsRouteId: removed.gsRouteId,
      transactionId: removed.txId,
      label: `Remove ${removed.custName || "stop"} from Goodshuffle route`,
    });
    void slackNotify(
      `↩️ Dispatch pulled *${removed.custName || "a stop"}* off ${routeId} — queued removal from the Goodshuffle route (waypoint ${removed.txId}).`,
    );
  }

  return NextResponse.json({
    ok: true,
    custName: removed.custName,
    gsQueued: Boolean(queued),
    gsSkippedReason: queued ? undefined : "no Goodshuffle ids on this stop/route (older pull)",
    op: queued,
  });
}

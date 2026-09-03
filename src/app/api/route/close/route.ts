// Close a truck's current route from the dispatch board. Used when the driver
// couldn't complete it on the tablet (dead battery / tablet down): the office marks
// the route done so it clears the active board and the truck can load today's route
// fresh. Read-mostly app has no auth yet — this is an office action on /dispatch.
//
// Body: { truckId: string }

import { NextResponse } from "next/server";
import { closeRoute, getRouteById } from "@/lib/db/repo";
import { recordEventOutcome, logChange } from "@/lib/history/store";
import { slackNotify } from "@/lib/notify/slack";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let routeId: string | undefined;
  try {
    routeId = ((await req.json()) as { routeId?: string })?.routeId;
  } catch {
    /* fall through to 400 */
  }
  if (!routeId) {
    return NextResponse.json({ error: "routeId required" }, { status: 400 });
  }
  const result = closeRoute(routeId);
  if (!result.ok) {
    return NextResponse.json({ error: "route not found" }, { status: 404 });
  }

  // Post-event outcome (MVP4 P3): on the first close, record how each event on the route went
  // (completed vs total stops). Grouped by event (tx_id), or route-level when stops lack a tx_id.
  if (!result.already) {
    const route = getRouteById(routeId);
    if (route) {
      const groups = new Map<string, { total: number; done: number }>();
      for (const s of route.stops) {
        const key = s.txId || routeId;
        const g = groups.get(key) ?? { total: 0, done: 0 };
        g.total++;
        if (s.state === "Completed" || s.state === "Returned") g.done++;
        groups.set(key, g);
      }
      for (const [eventId, g] of groups) {
        recordEventOutcome({ eventId, routeId, date: route.date, totalStops: g.total, completedStops: g.done });
        logChange({
          source: "dispatch",
          entity: "event",
          entityId: eventId,
          eventId: eventId === routeId ? undefined : eventId,
          kind: "event_completed",
          field: `${g.done}/${g.total} stops`,
          toValue: g.done >= g.total ? "complete" : "partial",
          changeKey: `outcome|${routeId}|${eventId}`,
        });
      }
    }
  }
  // If the route was closed with stops still unfinished, they need rescheduling — tell
  // dispatch on Slack (only on the first close, not a repeat of an already-closed route).
  if (!result.already && result.incomplete && result.incomplete.length > 0) {
    const list = result.incomplete
      .map((s) => `#${s.sequence} ${s.custName || "—"} (${s.state})`)
      .join(", ");
    void slackNotify(
      `⚠️ *${result.truckId ?? "Route"} route closed with ${result.incomplete.length} unfinished stop${result.incomplete.length === 1 ? "" : "s"}* — needs rescheduling: ${list}`,
    );
  }
  return NextResponse.json(result);
}

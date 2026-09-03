// Close a truck's current route from the dispatch board. Used when the driver
// couldn't complete it on the tablet (dead battery / tablet down): the office marks
// the route done so it clears the active board and the truck can load today's route
// fresh. Read-mostly app has no auth yet — this is an office action on /dispatch.
//
// Body: { truckId: string }

import { NextResponse } from "next/server";
import { closeRoute } from "@/lib/db/repo";
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

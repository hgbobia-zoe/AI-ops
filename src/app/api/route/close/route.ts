// Close a truck's current route from the dispatch board. Used when the driver
// couldn't complete it on the tablet (dead battery / tablet down): the office marks
// the route done so it clears the active board and the truck can load today's route
// fresh. Read-mostly app has no auth yet — this is an office action on /dispatch.
//
// Body: { truckId: string }

import { NextResponse } from "next/server";
import {
  applyCloseResolutions,
  closeOneRoute,
  markedCompletedLine,
  parseCloseResolutions,
  rescheduleAlertLine,
} from "@/lib/dispatch/closeRoute";
import { slackNotify } from "@/lib/notify/slack";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let routeId: string | undefined;
  let rawResolutions: unknown;
  try {
    const body = (await req.json()) as { routeId?: string; stopResolutions?: unknown };
    routeId = body?.routeId;
    rawResolutions = body?.stopResolutions;
  } catch {
    /* fall through to 400 */
  }
  if (!routeId) {
    return NextResponse.json({ error: "routeId required" }, { status: 400 });
  }
  const by = (await currentActor()).label;
  // Stops still open: record the closer's per-stop choice (mark completed now, or a reason) before closing.
  // Never blocks the close; a stop with no choice is recorded as closed with no reason.
  const applied = applyCloseResolutions(routeId, parseCloseResolutions(rawResolutions), by);
  // Close + record the post-event outcome (completed vs total stops) — shared with the bulk close.
  const result = closeOneRoute(routeId);
  if (!result.ok) {
    return NextResponse.json({ error: "route not found" }, { status: 404 });
  }

  // If the route was closed with stops still unfinished, they need rescheduling — tell dispatch on Slack
  // (only on the first close, not a repeat). Same alert the driver/bulk close paths send (shared builder).
  const line = rescheduleAlertLine(result, by);
  if (line) void slackNotify(line);
  const marked = result.already ? null : markedCompletedLine(applied, result.truckId ?? "Route", by);
  if (marked) void slackNotify(marked);
  return NextResponse.json(result);
}

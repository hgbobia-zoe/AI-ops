// Remove a route entirely from the app. For a route CANCELLED in Goodshuffle that the pull can't prune
// on its own (e.g. it was the only route on its date, so that date drops out of the sweep and prune
// never covers it). Office action on /dispatch; distinct from Close (which keeps the route as a done
// record). It will not come back unless Goodshuffle still has it.
//
// Body: { routeId: string }

import { NextResponse } from "next/server";
import { deleteRoute, getRouteById } from "@/lib/db/repo";
import { slackNotify } from "@/lib/notify/slack";
import { currentActor } from "@/lib/auth/getSession";

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

  const route = getRouteById(routeId); // read before delete, for the audit line
  const res = deleteRoute(routeId);
  if (!res.deleted) {
    return NextResponse.json({ ok: true, deleted: false });
  }

  const by = (await currentActor()).label; // who removed it, for the notification
  void slackNotify(`🗑️ *${route?.truckId ?? "Route"} route removed by ${by}*${route?.date ? ` (${route.date})` : ""} — cancelled in Goodshuffle.`);
  return NextResponse.json(res);
}

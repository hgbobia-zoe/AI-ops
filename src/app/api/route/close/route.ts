// Close a truck's current route from the dispatch board. Used when the driver
// couldn't complete it on the tablet (dead battery / tablet down): the office marks
// the route done so it clears the active board and the truck can load today's route
// fresh. Read-mostly app has no auth yet — this is an office action on /dispatch.
//
// Body: { truckId: string }

import { NextResponse } from "next/server";
import { closeRoute } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let truckId: string | undefined;
  try {
    truckId = ((await req.json()) as { truckId?: string })?.truckId;
  } catch {
    /* fall through to 400 */
  }
  if (!truckId) {
    return NextResponse.json({ error: "truckId required" }, { status: 400 });
  }
  const result = closeRoute(truckId);
  if (!result.ok) {
    return NextResponse.json({ error: "no route to close for this truck" }, { status: 404 });
  }
  return NextResponse.json(result);
}

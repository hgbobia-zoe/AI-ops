// TEST/dev-only route reset — puts a route's stops back to "Waiting" (clearing
// timestamps, proof, and tracking) so the driver flow can be walked again during
// testing. Gated behind ROUTE_RESET_ENABLED=1 so it's inert in real production.
//
// Body: { truckId?: string }  — with a truckId, resets that truck's latest route;
// without one, resets every in-progress stop.

import { NextResponse } from "next/server";
import { resetRouteProgress } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.ROUTE_RESET_ENABLED !== "1") {
    return NextResponse.json({ error: "route reset is disabled" }, { status: 403 });
  }
  let truckId: string | undefined;
  try {
    const body = (await req.json()) as { truckId?: string };
    truckId = body?.truckId;
  } catch {
    /* empty body = reset all */
  }
  const changed = resetRouteProgress(truckId);
  return NextResponse.json({ ok: true, ...changed });
}

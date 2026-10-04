// Arm a one-shot "Re-sync from Goodshuffle" for a route. This does NOT call Goodshuffle (the server is
// Cloudflare-blocked): it only marks the route so the NEXT browser pull of it force-applies Goodshuffle's
// current order (forceReconcileStops) instead of the normal progress-protecting merge. The browser pull
// (Dispatch button or kiosk) does the actual fetch + POST back to /api/route/import.
//
// Body: { routeId: string }

import { NextResponse } from "next/server";
import { markForceResync } from "@/lib/ingest/forceResync";

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

  markForceResync(routeId);
  return NextResponse.json({ ok: true });
}

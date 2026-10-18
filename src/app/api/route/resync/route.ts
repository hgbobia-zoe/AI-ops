// Arm a one-shot "Re-sync from Goodshuffle" for a route. This does NOT call Goodshuffle (the server is
// Cloudflare-blocked): it only marks the route so the NEXT browser pull of it force-applies Goodshuffle's
// current order (forceReconcileStops) instead of the normal progress-protecting merge. The browser pull
// (Dispatch button or kiosk) does the actual fetch + POST back to /api/route/import.
//
// Body: { routeId: string } and/or { routeIds: string[] }. The single-route form arms one route
// (per-route "Re-sync from Goodshuffle"); the list form arms every route for the viewed day in one
// call (the Dispatch header "Re-sync all from Goodshuffle"). Both may be sent together; ids are merged
// and de-duped. Returns { ok, armed } with the count of distinct routes armed.

import { NextResponse } from "next/server";
import { markForceResync } from "@/lib/ingest/forceResync";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { routeId?: string; routeIds?: string[] } = {};
  try {
    body = ((await req.json()) as typeof body) ?? {};
  } catch {
    /* fall through to 400 */
  }

  const ids = new Set<string>();
  if (typeof body.routeId === "string" && body.routeId) ids.add(body.routeId);
  if (Array.isArray(body.routeIds)) {
    for (const id of body.routeIds) if (typeof id === "string" && id) ids.add(id);
  }

  if (ids.size === 0) {
    return NextResponse.json({ error: "routeId or routeIds required" }, { status: 400 });
  }

  for (const id of ids) markForceResync(id);
  return NextResponse.json({ ok: true, armed: ids.size });
}

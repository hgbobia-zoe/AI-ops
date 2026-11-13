// Scheduling — create a manual shift. Staff-only (proxy denies guests + requires a session on /api/*).

import { NextResponse } from "next/server";
import { createShift, updateShift, type NewShift } from "@/lib/scheduling/store";
import { crewWindowForRoute } from "@/lib/scheduling/routeCrewWindow";
import { getRouteById } from "@/lib/db/repo";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: NewShift;
  try {
    body = (await req.json()) as NewShift;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return NextResponse.json({ error: "date_required" }, { status: 400 });
  if (!body.role) return NextResponse.json({ error: "role_required" }, { status: 400 });
  if (!Number.isFinite(body.headcount) || body.headcount < 1) return NextResponse.json({ error: "headcount_required" }, { status: 400 });

  // A shift on a route takes the route's crew window unless the person typed a different time (then it is an
  // override from birth). A shift with no route keeps exactly the times the person entered (blank is fine).
  if (body.routeId) {
    const route = getRouteById(body.routeId);
    if (!route) return NextResponse.json({ error: "route_not_found" }, { status: 400 });
    const crew = crewWindowForRoute(body.routeId);
    const typed = Boolean(body.startTime || body.endTime);
    const onRoute = crew.known && (!typed || (Date.parse(body.startTime ?? "") === Date.parse(crew.start ?? "") && Date.parse(body.endTime ?? "") === Date.parse(crew.end ?? "")));
    const startTime = typed ? body.startTime ?? null : crew.start;
    const endTime = typed ? body.endTime ?? null : crew.end;
    const created = createShift({ ...body, truckId: body.truckId ?? route.truckId, startTime, endTime, windowKnown: Boolean(startTime && endTime), source: body.source ?? "manual" });
    const shift = crew.known
      ? updateShift(created.id, {
          routeWindowStart: crew.start,
          routeWindowEnd: crew.end,
          routeOverride: onRoute ? null : { by: (await currentActor()).label, at: new Date().toISOString(), source: "dispatch", routeStart: crew.start, routeEnd: crew.end },
        })
      : created;
    return NextResponse.json({ ok: true, shift });
  }
  const shift = createShift({ ...body, source: body.source ?? "manual" });
  return NextResponse.json({ ok: true, shift });
}

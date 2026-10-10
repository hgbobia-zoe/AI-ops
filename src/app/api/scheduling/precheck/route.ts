// Route Staffing Pre-Check — resolve/reopen a route's staffing hold. Owner/admin only (canManageSettings).
//   • action "mark_done" — the route is handled (old way / solo). Record an ack snapshotting the CURRENT
//     assigned crew; this clears the hold + suppresses re-alerts UNTIL the route's staffing changes (the
//     snapshot stops matching). The other way a gap clears is simply ASSIGNING crew on the board — that
//     needs no call here, the pre-check recomputes to "ok" on its own.
//   • action "reopen" — drop the ack so the route is held/alerted again (e.g. the "done" was a mistake).
// Staff/session-gated by the /api proxy; this adds the owner/admin check on top (a standing suppression).

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getRoutesForDate } from "@/lib/db/repo";
import { getShiftsForDate } from "@/lib/scheduling/store";
import { assignedCrewForRoute } from "@/lib/scheduling/preCheck";
import { setPreCheckAck, clearPreCheckAck, assignedSig } from "@/lib/scheduling/preCheckStore";

export const dynamic = "force-dynamic";

interface Body {
  date?: unknown;
  routeId?: unknown;
  truckId?: unknown;
  action?: unknown;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
  const routeId = typeof body.routeId === "string" && body.routeId ? body.routeId : null;
  const truckId = typeof body.truckId === "string" && body.truckId ? body.truckId : null;
  const action = body.action === "mark_done" || body.action === "reopen" ? body.action : null;
  if (!date || !routeId || !action) return NextResponse.json({ error: "date, routeId and a valid action are required" }, { status: 400 });

  if (action === "reopen") {
    clearPreCheckAck(date, routeId);
    return NextResponse.json({ ok: true });
  }

  // mark_done: snapshot the route's CURRENT explicit assignment so the ack lapses if staffing later changes.
  const routes = truckId ? getRoutesForDate(truckId, date) : [];
  const route = routes.find((r) => r.routeId === routeId);
  if (!route) return NextResponse.json({ error: "route not found" }, { status: 404 });
  const routeShifts = getShiftsForDate(date).filter((s) => s.routeId === routeId);
  const sig = assignedSig(assignedCrewForRoute(route, routeShifts));
  const actor = (await currentActor()).label;
  setPreCheckAck(date, routeId, actor, sig);
  return NextResponse.json({ ok: true });
}

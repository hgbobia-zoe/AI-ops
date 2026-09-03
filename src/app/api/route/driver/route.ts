// Assign (or clear) the driver on a route — the Dispatch side of the staffing model that the
// Event Risk Engine validates against Connecteam. Office action; no auth yet (internal URL).
//
// Body: { routeId: string, driverId?: string|null, driverName?: string|null }

import { NextResponse } from "next/server";
import { setRouteDriver } from "@/lib/db/repo";
import { logChange } from "@/lib/history/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { routeId?: string; driverId?: string | null; driverName?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.routeId) return NextResponse.json({ error: "routeId required" }, { status: 400 });
  const newName = body.driverName || null;
  const { ok, previousName } = setRouteDriver(body.routeId, body.driverId || null, newName);
  if (!ok) return NextResponse.json({ error: "route not found" }, { status: 404 });

  // Operational History: record a genuine driver change (Dispatch-side staffing decision).
  const prev = previousName ?? null;
  if (prev !== newName) {
    const dayKey = new Date().toISOString().slice(0, 10);
    logChange({
      source: "dispatch",
      entity: "route",
      entityId: body.routeId,
      kind: prev == null ? "driver_assigned" : newName == null ? "driver_cleared" : "driver_reassigned",
      field: "driver",
      fromValue: prev,
      toValue: newName,
      // Once per (route, target driver) per day — re-submitting the same assignment is a no-op.
      changeKey: `driver|${body.routeId}|${newName ?? "none"}|${dayKey}`,
    });
  }
  return NextResponse.json({ ok: true });
}

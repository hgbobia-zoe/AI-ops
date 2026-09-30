// Scheduling — build/refresh the day's shifts from routes. Turns the day's routes into a demand
// draft (buildDemand) and materializes it idempotently into staff_shifts (syncDemand). Staff-only
// (proxy denies guests + requires a session on /api/*). Deterministic; no fabrication.

import { NextResponse } from "next/server";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRouteForDate } from "@/lib/db/repo";
import { buildDemand } from "@/lib/scheduling/demand";
import { syncDemand } from "@/lib/scheduling/store";
import type { Route } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { date?: string };
  try {
    body = (await req.json()) as { date?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const date = body.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date_required" }, { status: 400 });

  const routes = getActiveVehicles()
    .map((t) => getRouteForDate(t.truckId, date))
    .filter((r): r is Route => Boolean(r) && r!.status !== "done");

  if (routes.length === 0) return NextResponse.json({ shifts: [], note: "no routes" });

  const demand = buildDemand(routes);
  const shifts = syncDemand(date, demand);
  return NextResponse.json({ shifts });
}

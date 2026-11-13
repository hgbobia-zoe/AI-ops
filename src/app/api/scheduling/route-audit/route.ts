// Route time audit (read only). Every route shift in [start, end] whose time does not match its route, and
// what the policy does with it: override (kept), held (in Connecteam, waits for a person: Reset to route or
// Keep this time), will_correct (not published, the route job fixes it), will_follow (the route changed).
// Owner rule: "Shifts have to match the route unless someone overrides it." Staff only (proxy). No writes.

import { NextResponse } from "next/server";
import { getShiftsForDateRange } from "@/lib/scheduling/store";
import { routeTimeAudit, type CrewWin } from "@/lib/scheduling/routeMatch";
import { crewWindowForRoute } from "@/lib/scheduling/routeCrewWindow";
import { formatClockTime, todayInOpsTz, shiftYmd } from "@/lib/dates";

export const dynamic = "force-dynamic";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const start = url.searchParams.get("start")?.trim() || todayInOpsTz();
  const end = url.searchParams.get("end")?.trim() || shiftYmd(start, 34);
  if (!YMD.test(start) || !YMD.test(end) || start > end) return NextResponse.json({ error: "start/end must be YYYY-MM-DD, start first" }, { status: 400 });
  const cache = new Map<string, CrewWin>();
  const crewOf = (id: string): CrewWin => {
    if (!cache.has(id)) cache.set(id, crewWindowForRoute(id));
    return cache.get(id)!;
  };
  const rows = routeTimeAudit(getShiftsForDateRange(start, end), crewOf).map((r) => ({
    ...r,
    shift: `${formatClockTime(r.shiftStart)} to ${formatClockTime(r.shiftEnd)}`,
    route: `${formatClockTime(r.routeStart)} to ${formatClockTime(r.routeEnd)}`,
  }));
  return NextResponse.json({ start, end, count: rows.length, rows });
}

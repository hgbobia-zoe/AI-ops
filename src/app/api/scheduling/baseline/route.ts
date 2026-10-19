// Scheduling operations BASELINE (read-only). A simple way to collect the scheduling-automation activity
// baseline over several operating cycles, so workload reduction can be MEASURED rather than assumed. Staff-
// only (the proxy requires a session on /api/* and denies guests). Deterministic; aggregates recorded facts
// only and never fabricates a savings figure. See src/lib/scheduling/opsMetrics.ts.

import { NextResponse } from "next/server";
import { computeSchedulingBaseline } from "@/lib/scheduling/opsMetrics";
import { todayInOpsTz, shiftYmd } from "@/lib/dates";

export const dynamic = "force-dynamic";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const today = todayInOpsTz();
  // Default window: the trailing 14 days (two operating weeks) ending today.
  const end = url.searchParams.get("end")?.trim() || today;
  const start = url.searchParams.get("start")?.trim() || shiftYmd(end, -13);
  if (!YMD.test(start) || !YMD.test(end)) {
    return NextResponse.json({ error: "start/end must be YYYY-MM-DD" }, { status: 400 });
  }
  if (start > end) {
    return NextResponse.json({ error: "start must be on or before end" }, { status: 400 });
  }
  const baseline = computeSchedulingBaseline(start, end);
  return NextResponse.json(baseline);
}

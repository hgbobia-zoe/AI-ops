// Sales-hours analysis over Quo history (aggregates only). Owner/admin: /api/integrations is behind the
// proxy's settings gate. POST starts a background run (?days=365), or resumes an interrupted one with the
// same days; ?fresh=1 throws the checkpoint away and starts over. GET returns progress + the report, and
// reports "interrupted" or "stale" when a run died without finishing.

import { NextResponse } from "next/server";
import { getRunState, startRun } from "@/lib/analytics/quoHours";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(getRunState());
}

export async function POST(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;
  const days = Math.min(730, Math.max(7, Number(sp.get("days")) || 365));
  const fresh = sp.get("fresh") === "1" || sp.get("fresh") === "true";
  return NextResponse.json(startRun(days, { fresh }));
}

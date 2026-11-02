// Sales-hours analysis over Quo history (aggregates only). Owner/admin: /api/integrations is behind the
// proxy's settings gate. POST starts a background run (?days=365); GET returns progress + the report.

import { NextResponse } from "next/server";
import { getRunState, startRun } from "@/lib/analytics/quoHours";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(getRunState());
}

export async function POST(req: Request): Promise<NextResponse> {
  const days = Math.min(730, Math.max(7, Number(new URL(req.url).searchParams.get("days")) || 365));
  return NextResponse.json(startRun(days));
}

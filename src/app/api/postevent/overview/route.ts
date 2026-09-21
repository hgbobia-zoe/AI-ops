// Post-Event management funnel + metrics. GET ?days=7|30|90 (default 30), or ?start=&end= for a custom
// range. Every rate carries its numerator + denominator; nothing is fabricated.

import { NextResponse } from "next/server";
import { syncPostEvent } from "@/lib/postevent/engine";
import { computeMetrics } from "@/lib/postevent/metrics";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  syncPostEvent(); // keep eligibility current before measuring
  const url = new URL(req.url);
  const daysRaw = url.searchParams.get("days");
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (start || end) return NextResponse.json(computeMetrics({ start, end }));
  const days = daysRaw === "all" ? null : daysRaw ? Number(daysRaw) : 30;
  return NextResponse.json(computeMetrics({ days: Number.isFinite(days as number) ? (days as number) : 30 }));
}

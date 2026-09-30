// Scheduling — create a manual shift. Staff-only (proxy denies guests + requires a session on /api/*).

import { NextResponse } from "next/server";
import { createShift, type NewShift } from "@/lib/scheduling/store";

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

  const shift = createShift({ ...body, source: body.source ?? "manual" });
  return NextResponse.json({ ok: true, shift });
}

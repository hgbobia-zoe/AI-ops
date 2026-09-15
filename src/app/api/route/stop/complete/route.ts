// Supervisor override — force a stop to Completed from the desktop Dispatch board. For when the
// tablet is down / a stop is stuck and can't be completed in the field. Unlike the tablet flow this
// does NOT re-send customer SMS or run fan-out (the delivery likely already happened; we're just
// un-sticking the record). Owner/admin gated by the proxy.

import { NextResponse } from "next/server";
import { getStop, updateStopState } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { stopId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const stopId = (body.stopId ?? "").trim();
  if (!stopId) return NextResponse.json({ ok: false, error: "missing stopId" }, { status: 400 });

  const stop = getStop(stopId);
  if (!stop) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  if (stop.state === "Completed" || stop.state === "Returned") return NextResponse.json({ ok: true, already: true });

  updateStopState(stopId, "Completed", { completedAt: new Date().toISOString() });
  return NextResponse.json({ ok: true });
}

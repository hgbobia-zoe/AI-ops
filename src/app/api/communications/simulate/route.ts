// Voice Lab — POST a caller + scenario and get back the exact Context Pack the agent would receive, the
// read-only tools that would fire (with real results), the controlled actions the scenario implies
// (returned BLOCKED), and a placeholder AI response. NO real call is placed. Session-gated.

import { NextResponse } from "next/server";
import { simulateCall } from "@/lib/comms/simulate";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { phone?: string | null; scenario?: string; bookingId?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const result = await simulateCall({
    phone: (body.phone ?? "").trim() || null,
    scenario: (body.scenario ?? "").trim(),
    bookingId: body.bookingId ?? null,
  });
  return NextResponse.json(result);
}

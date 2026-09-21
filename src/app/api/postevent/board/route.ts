// Post-Event Kanban data. GET runs a sync (eligibility + auto-contacts + next-action) then returns the
// board columns. Staff-visible (guests are denied by the proxy). Deterministic; no fabrication.

import { NextResponse } from "next/server";
import { buildBoard } from "@/lib/postevent/engine";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(buildBoard());
}

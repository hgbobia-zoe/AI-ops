// Set a lead's Sales OS board status (a drag on the Kanban board, or an archive). Persists a manual
// override that beats the derived default. Proxy-gated to signed-in console users; attributes the move.

import { NextResponse } from "next/server";
import { setLeadStatus, type LeadBoardStatus } from "@/lib/db/repo";
import { currentActor } from "@/lib/auth/getSession";
import { logSalesEventBy } from "@/lib/salesos/audit";

export const dynamic = "force-dynamic";

const VALID: LeadBoardStatus[] = ["new", "quote_sent", "follow_up", "action_needed", "signed", "archived"];

export async function POST(req: Request): Promise<NextResponse> {
  let body: { id?: string; status?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  const status = body.status as LeadBoardStatus;
  if (!id || !VALID.includes(status)) return NextResponse.json({ error: "id and valid status required" }, { status: 400 });

  const actor = (await currentActor()).label;
  setLeadStatus(id, status, actor);
  logSalesEventBy("BOARD_MOVE", id, actor, { status });
  return NextResponse.json({ ok: true, id, status });
}

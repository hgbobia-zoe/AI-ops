// Suggested next outreach for a lead — message copy + call strategy, informed by the real Goodshuffle
// comms history. Authenticated app users (session-gated by the proxy). Returns a suggestion only.

import { NextResponse } from "next/server";
import { draftLeadOutreach } from "@/lib/salesos/outreachService";
import { logSalesEvent } from "@/lib/salesos/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const result = await draftLeadOutreach(id);
  if (!result) return NextResponse.json({ error: "lead not found" }, { status: 404 });
  await logSalesEvent("OUTREACH_DRAFTED", id, { source: result.draft.source, stage: result.stage });
  return NextResponse.json(result);
}

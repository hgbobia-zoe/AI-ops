// Advance an opportunity's lifecycle stage (§6) — a manual override that wins over the derived auto
// stage (same pattern as Sales OS lead_status). Proxy-gated to signed-in console users.

import { NextResponse } from "next/server";
import { setOpportunityStage } from "@/lib/opportunity/store";
import { STAGE_LABEL, type LifecycleStage } from "@/lib/opportunity/types";

export const dynamic = "force-dynamic";

const VALID = new Set(Object.keys(STAGE_LABEL));

export async function POST(req: Request): Promise<NextResponse> {
  let body: { id?: string; stage?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  const stage = body.stage as LifecycleStage;
  if (!id || !VALID.has(stage)) return NextResponse.json({ error: "id and valid stage required" }, { status: 400 });
  const ok = setOpportunityStage(id, stage);
  return ok ? NextResponse.json({ ok: true, id, stage }) : NextResponse.json({ error: "not found" }, { status: 404 });
}

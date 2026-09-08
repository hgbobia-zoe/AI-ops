// Record (or clear) why a quote was lost. Goodshuffle stores no loss reason, so this is how the team
// builds that dataset. Authenticated app users only (enforced by the session proxy for non-public
// paths); the reason must be one of the known vocabulary values, or empty to clear.

import { NextResponse } from "next/server";
import { setLossReason } from "@/lib/db/repo";
import { LOSS_REASONS } from "@/lib/salesos/lostService";
import { logSalesEvent } from "@/lib/salesos/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { id?: string; reason?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const reason = (body.reason ?? "").trim();
  if (reason && !LOSS_REASONS.includes(reason)) {
    return NextResponse.json({ error: "unknown reason" }, { status: 400 });
  }
  setLossReason(id, reason || null);
  await logSalesEvent("LOSS_REASON_TAGGED", id, { reason: reason || "(cleared)" });
  return NextResponse.json({ ok: true, id, reason: reason || null });
}

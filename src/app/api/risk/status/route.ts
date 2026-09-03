// Update a risk's lifecycle status from the /risk queue (acknowledge, start, resolve, dismiss).
// Office action; no auth yet (internal URL).
//
// Body: { id: string, status: "OPEN"|"ACKNOWLEDGED"|"IN_PROGRESS"|"RESOLVED"|"DISMISSED", owner?: string }

import { NextResponse } from "next/server";
import { setRiskStatus, getRiskById } from "@/lib/risk/store";
import { logChange } from "@/lib/history/store";
import type { RiskStatus } from "@/lib/risk/types";

export const dynamic = "force-dynamic";

const VALID: RiskStatus[] = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED", "DISMISSED"];

export async function POST(req: Request): Promise<NextResponse> {
  let body: { id?: string; status?: string; owner?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.id || !body.status || !VALID.includes(body.status as RiskStatus)) {
    return NextResponse.json({ error: "id and valid status required" }, { status: 400 });
  }
  const before = getRiskById(body.id);
  const ok = setRiskStatus(body.id, body.status as RiskStatus, body.owner);
  if (!ok) return NextResponse.json({ error: "risk not found" }, { status: 404 });

  // Record the human decision (acknowledge/dismiss/resolve) in Operational History — only
  // scan-driven transitions were logged before, so management decisions left no trace.
  if (before && before.status !== body.status) {
    const dayKey = new Date().toISOString().slice(0, 10);
    logChange({
      source: "dispatch",
      entity: "risk",
      entityId: before.signature,
      eventId: before.eventId,
      kind: "risk_status_changed",
      field: before.title,
      fromValue: before.status,
      toValue: body.owner ? `${body.status} (by ${body.owner})` : body.status,
      changeKey: `riskstatus|${before.signature}|${body.status}|${dayKey}`,
    });
  }
  return NextResponse.json({ ok: true });
}

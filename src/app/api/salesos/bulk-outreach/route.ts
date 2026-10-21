// Bulk Review-and-Fire — queue the owner's approved Quote-Sent selections. Owner/admin only (this fires
// governed comms approvals, same gate as the Approvals page). Each selected row+channel is pushed through
// the EXISTING approval path (createApproval -> decideApproval): email -> gs_outbox email_send (respecting
// EMAIL_SEND_ENABLED); SMS -> held (no async op, mirrors the single outreach SMS approval). Idempotent on
// the lead+channel+day key, so a re-fire never double-sends. NOTHING is auto-sent: the owner's explicit
// approval click is the only trigger, and every existing comms gate still applies.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { queueBulkOutreach, type BulkQueueItem } from "@/lib/salesos/bulkOutreach";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageSettings(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { items?: BulkQueueItem[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return NextResponse.json({ error: "no_selection", detail: "Select at least one row to queue." }, { status: 400 });

  const actor = (await currentActor()).label;
  try {
    const summary = queueBulkOutreach(items, actor);
    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "queue_failed" }, { status: 500 });
  }
}

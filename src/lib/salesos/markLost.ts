// Mark an unsigned quote lost and archive it in Goodshuffle (owner call 2026-11-03: follow up until 3 days
// before the event, then mark it lost and archive). The server can't reach Goodshuffle, so this queues a
// `mark_lost` gs_outbox op; the logged-in Auto-Pull extension / office bookmarklet replays the captured
// POST /app/vendorTransaction/markAsLost then /archiveProject (form transactionID).
//
// Called by the morning outreach LIVE run for rows the gate marked `lose` (the dry run only reports them).
// Guards: the project must still be unsigned and not already lost, and a project is queued once, ever.

import { getDb } from "@/lib/db";
import { enqueueGsOp, getBookingById } from "@/lib/db/repo";

export type MarkLostResult = { queued: true; opId: string } | { queued: false; reason: "unknown_project" | "signed" | "already_lost" | "already_queued" };

export function queueMarkLost(leadId: string, why: string): MarkLostResult {
  const b = getBookingById(leadId);
  if (!b) return { queued: false, reason: "unknown_project" };
  if (b.signed) return { queued: false, reason: "signed" };
  if (/lost|cancel|dead/i.test(b.statusLabel)) return { queued: false, reason: "already_lost" };
  const seen = getDb().prepare("SELECT 1 FROM gs_outbox WHERE op = 'mark_lost' AND transaction_id = ? AND status != 'failed' LIMIT 1").get(leadId);
  if (seen) return { queued: false, reason: "already_queued" };
  const op = enqueueGsOp({
    op: "mark_lost",
    transactionId: leadId,
    label: `Mark lost and archive: ${b.eventName ?? leadId}`.slice(0, 140),
    payload: { archive: true, why: why.slice(0, 300), by: "Sales Bot" },
  });
  return { queued: true, opId: op.id };
}

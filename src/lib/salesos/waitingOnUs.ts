// "Waiting on us" (owner, 2026-11-14). A quote goes lost at 3 days to the event when it is still unsigned,
// UNLESS the customer is waiting on us. Two ways to know:
//   1. A rep marks it on the lead ("Waiting on us"), and we record who marked it and when. It stays until a
//      person clears it.
//   2. The system detects it from the conversation: the customer wrote last (gateLead), or they asked
//      something that is still open in the customer asks detector (actionItems), or the Sales board flags
//      it Action Needed.
// Either one pauses auto-lost (gateLead returns lose_waiting, and queueMarkLost refuses a marked lead), and
// holds the morning text so a person answers instead.

import { getDb } from "@/lib/db";
import { getOpenActionItems } from "./actionItems";

export interface WaitingMark {
  leadId: string;
  markedBy: string;
  markedAt: string; // ISO
  note: string | null;
}

/** The open rep mark on a lead, or null. Never throws. */
export function getWaitingMark(leadId: string): WaitingMark | null {
  try {
    const r = getDb().prepare("SELECT lead_id, marked_by, marked_at, note FROM sales_waiting_on_us WHERE lead_id = ? AND cleared_at IS NULL").get(leadId) as
      | { lead_id: string; marked_by: string; marked_at: string; note: string | null }
      | undefined;
    return r ? { leadId: r.lead_id, markedBy: r.marked_by, markedAt: r.marked_at, note: r.note } : null;
  } catch {
    return null;
  }
}

/** A rep marks the lead waiting on us. Re-marking updates who and when. */
export function markWaiting(leadId: string, by: string, note: string | null, now: Date = new Date()): WaitingMark {
  const at = now.toISOString();
  const n = note?.trim().slice(0, 300) || null;
  getDb()
    .prepare(
      `INSERT INTO sales_waiting_on_us (lead_id, marked_by, marked_at, note, cleared_by, cleared_at) VALUES (?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(lead_id) DO UPDATE SET marked_by = excluded.marked_by, marked_at = excluded.marked_at, note = excluded.note, cleared_by = NULL, cleared_at = NULL`,
    )
    .run(leadId, by, at, n);
  return { leadId, markedBy: by, markedAt: at, note: n };
}

/** A person clears the mark. Returns false when there was none. */
export function clearWaiting(leadId: string, by: string, now: Date = new Date()): boolean {
  const r = getDb().prepare("UPDATE sales_waiting_on_us SET cleared_by = ?, cleared_at = ? WHERE lead_id = ? AND cleared_at IS NULL").run(by, now.toISOString(), leadId);
  return r.changes > 0;
}

/** The customer's open asks we have not answered (from the asks detector), newest first. */
export function openAsks(leadId: string): { summary: string; quote: string }[] {
  try {
    return getOpenActionItems(leadId).map((i) => ({ summary: i.summary, quote: i.verbatimQuote }));
  } catch {
    return [];
  }
}

const shortDay = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

/** One line for a rep mark: "Jessie marked it waiting on us on Nov 14 (sending a revised quote)". PURE. */
export function markLine(m: Pick<WaitingMark, "markedBy" | "markedAt" | "note">): string {
  return `${m.markedBy} marked it waiting on us on ${shortDay(m.markedAt)}${m.note ? ` (${m.note})` : ""}`;
}

// Sales audit trail — every meaningful sales action, attributed to a person. Built on the existing
// generic audit_logs table (insertAudit) rather than a duplicate store. Identity is part of the record:
// who did it, when, to which lead, and the evidence/detail. Best-effort — logging never breaks the
// action it records.
//
// Actor comes from the session (currentActor). While login is OFF it reads "Unattributed" — honest,
// never a fabricated name — and becomes fully attributable the moment per-person login is enabled.

import { insertAudit, getAuditForEntity, getRecentAudit, auditExistsSince, type AuditRow } from "@/lib/db/repo";
import { currentActor } from "@/lib/auth/getSession";

/** The controlled vocabulary of sales actions (extended as later phases add capabilities). */
export type SalesAction =
  | "LEAD_VIEWED"
  | "OUTREACH_DRAFTED"
  | "MESSAGE_SENT"
  | "LOSS_REASON_TAGGED"
  | "BID_REVIEWED"
  | "CALL_LOGGED"
  | "CALL_DEBRIEF"
  | "INBOUND_SMS";

export const SALES_ACTIONS: SalesAction[] = ["LEAD_VIEWED", "OUTREACH_DRAFTED", "MESSAGE_SENT", "LOSS_REASON_TAGGED", "BID_REVIEWED", "CALL_LOGGED", "CALL_DEBRIEF", "INBOUND_SMS"];

export const ACTION_LABEL: Record<SalesAction, string> = {
  LEAD_VIEWED: "Viewed lead",
  OUTREACH_DRAFTED: "Drafted outreach",
  MESSAGE_SENT: "Sent text",
  LOSS_REASON_TAGGED: "Tagged loss reason",
  BID_REVIEWED: "Reviewed bid",
  CALL_LOGGED: "Logged call",
  CALL_DEBRIEF: "Debriefed call → state",
  INBOUND_SMS: "Customer replied (SMS)",
};

/** Record a sales action against a lead, attributed to the current actor. `actorLabel` overrides the
 *  session actor (e.g. a call handled by a specific Quo rep, not the app viewer). */
export async function logSalesEvent(action: SalesAction, leadId: string, detail?: Record<string, unknown>, actorLabel?: string): Promise<void> {
  try {
    const actor = actorLabel ?? (await currentActor()).label;
    insertAudit({ actor, action, entity: "lead", entityId: leadId, after: detail ?? null });
  } catch {
    /* audit is best-effort — never fail the underlying action */
  }
}

/** Synchronous variant when the actor label is already known (e.g. inside the call pipeline). */
export function logSalesEventBy(action: SalesAction, leadId: string, actorLabel: string, detail?: Record<string, unknown>): void {
  try {
    insertAudit({ actor: actorLabel, action, entity: "lead", entityId: leadId, after: detail ?? null });
  } catch {
    /* best-effort */
  }
}

/** Log a lead view, but at most once per actor per lead per window (avoid audit spam on refresh). */
export async function logLeadView(leadId: string, windowMinutes = 30): Promise<void> {
  try {
    const actor = (await currentActor()).label;
    const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    if (auditExistsSince("lead", leadId, "LEAD_VIEWED", actor, since)) return;
    insertAudit({ actor, action: "LEAD_VIEWED", entity: "lead", entityId: leadId, after: null });
  } catch {
    /* best-effort */
  }
}

export interface SalesActivityEntry {
  actor: string;
  action: SalesAction;
  actionLabel: string;
  leadId: string;
  detail: Record<string, unknown> | null;
  ts: string;
}

const toEntry = (r: AuditRow): SalesActivityEntry => ({
  actor: r.actor,
  action: r.action as SalesAction,
  actionLabel: ACTION_LABEL[r.action as SalesAction] ?? r.action,
  leadId: r.entityId,
  detail: r.detail,
  ts: r.ts,
});

/** The audit trail for one lead (newest first). */
export function leadActivity(leadId: string, limit = 50): SalesActivityEntry[] {
  return getAuditForEntity("lead", leadId, limit)
    .filter((r) => SALES_ACTIONS.includes(r.action as SalesAction))
    .map(toEntry);
}

/** The global recent sales-activity feed. */
export function recentSalesActivity(limit = 100): SalesActivityEntry[] {
  return getRecentAudit(SALES_ACTIONS, limit).map(toEntry);
}

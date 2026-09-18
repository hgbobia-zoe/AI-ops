// Opportunity Radar — outreach persistence (opportunity_outreach). Holds drafts through their
// approve/send/skip lifecycle. Marking a draft "sent" is a RECORDED action (no automated blast) and
// advances the opportunity to CONTACTED.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { setOpportunityStage } from "./store";
import type { OutreachDraft } from "./outreach";

export interface StoredOutreach {
  id: string;
  opportunityId: string;
  entityId: string | null;
  channel: string;
  subject: string | null;
  body: string | null;
  callScript: string | null;
  followUps: string[];
  reason: string | null;
  status: "draft" | "approved" | "sent" | "skipped";
  source: "template" | "ai";
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toOutreach(r: any): StoredOutreach {
  return {
    id: r.id, opportunityId: r.opportunity_id, entityId: r.entity_id ?? null, channel: r.channel,
    subject: r.subject ?? null, body: r.body ?? null, callScript: r.call_script ?? null,
    followUps: r.follow_ups ? JSON.parse(r.follow_ups) : [], reason: r.reason ?? null,
    status: r.status, source: r.source, createdBy: r.created_by ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, sentAt: r.sent_at ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function saveDraft(opportunityId: string, entityId: string | null, draft: OutreachDraft, createdBy: string | null, now: Date = new Date()): StoredOutreach {
  const id = `OUT-${randomUUID()}`;
  const ts = now.toISOString();
  getDb().prepare(
    `INSERT INTO opportunity_outreach (id, opportunity_id, entity_id, channel, subject, body, call_script, follow_ups, reason, status, source, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`,
  ).run(id, opportunityId, entityId, draft.channel, draft.subject, draft.body, draft.callScript, JSON.stringify(draft.followUps), draft.reason, draft.source, createdBy, ts, ts);
  return getOutreach(id)!;
}

export function getOutreach(id: string): StoredOutreach | null {
  const r = getDb().prepare("SELECT * FROM opportunity_outreach WHERE id = ?").get(id);
  return r ? toOutreach(r) : null;
}

export function getOutreachForOpportunity(opportunityId: string): StoredOutreach[] {
  return (getDb().prepare("SELECT * FROM opportunity_outreach WHERE opportunity_id = ? ORDER BY created_at DESC").all(opportunityId) as unknown[]).map(toOutreach);
}

export function setOutreachStatus(id: string, status: StoredOutreach["status"], now: Date = new Date()): StoredOutreach | null {
  const db = getDb();
  const row = getOutreach(id);
  if (!row) return null;
  const sentAt = status === "sent" ? now.toISOString() : row.sentAt;
  db.prepare("UPDATE opportunity_outreach SET status=?, sent_at=?, updated_at=? WHERE id=?").run(status, sentAt, now.toISOString(), id);
  // Recording a send advances the opportunity to CONTACTED (a human just reached out).
  if (status === "sent") setOpportunityStage(row.opportunityId, "CONTACTED", now);
  return getOutreach(id);
}

export function editOutreach(id: string, patch: { subject?: string; body?: string; callScript?: string }, now: Date = new Date()): StoredOutreach | null {
  const row = getOutreach(id);
  if (!row) return null;
  getDb().prepare("UPDATE opportunity_outreach SET subject=?, body=?, call_script=?, updated_at=? WHERE id=?")
    .run(patch.subject ?? row.subject, patch.body ?? row.body, patch.callScript ?? row.callScript, now.toISOString(), id);
  return getOutreach(id);
}

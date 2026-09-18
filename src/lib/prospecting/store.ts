// Prospecting — persistence for enrollments, the materialized task worklist, and the suppression list.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { Channel, EnrollmentStatus, Tier, TaskOutcome, TaskStatus } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface StoredEnrollment {
  id: string;
  opportunityId: string;
  entityId: string | null;
  tier: Tier;
  cadenceKey: string;
  channel: Channel;
  status: EnrollmentStatus;
  owner: string | null;
  nextActionAt: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface StoredTask {
  id: string;
  enrollmentId: string;
  opportunityId: string;
  entityId: string | null;
  channel: Channel;
  stepIndex: number;
  dueAt: string;
  status: TaskStatus;
  subject: string | null;
  body: string | null;
  script: string | null;
  outcome: TaskOutcome | null;
  completedBy: string | null;
  completedAt: string | null;
  exportedAt: string | null;
}

function toEnrollment(r: any): StoredEnrollment {
  return { id: r.id, opportunityId: r.opportunity_id, entityId: r.entity_id ?? null, tier: r.tier, cadenceKey: r.cadence_key, channel: r.channel, status: r.status, owner: r.owner ?? null, nextActionAt: r.next_action_at ?? null, startedAt: r.started_at, updatedAt: r.updated_at };
}
function toTask(r: any): StoredTask {
  return { id: r.id, enrollmentId: r.enrollment_id, opportunityId: r.opportunity_id, entityId: r.entity_id ?? null, channel: r.channel, stepIndex: r.step_index, dueAt: r.due_at, status: r.status, subject: r.subject ?? null, body: r.body ?? null, script: r.script ?? null, outcome: r.outcome ?? null, completedBy: r.completed_by ?? null, completedAt: r.completed_at ?? null, exportedAt: r.exported_at ?? null };
}

// ── Enrollments ───────────────────────────────────────────────────────────────────────────────────
export function getEnrollmentByOpportunity(opportunityId: string): StoredEnrollment | null {
  const r = getDb().prepare("SELECT * FROM prospect_enrollments WHERE opportunity_id = ?").get(opportunityId);
  return r ? toEnrollment(r) : null;
}
export function getEnrollment(id: string): StoredEnrollment | null {
  const r = getDb().prepare("SELECT * FROM prospect_enrollments WHERE id = ?").get(id);
  return r ? toEnrollment(r) : null;
}
export function insertEnrollment(e: Omit<StoredEnrollment, "id" | "startedAt" | "updatedAt">, now: Date): StoredEnrollment {
  const id = `ENR-${randomUUID()}`;
  const ts = now.toISOString();
  getDb().prepare("INSERT INTO prospect_enrollments (id, opportunity_id, entity_id, tier, cadence_key, channel, status, owner, next_action_at, started_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, e.opportunityId, e.entityId, e.tier, e.cadenceKey, e.channel, e.status, e.owner, e.nextActionAt, ts, ts);
  return getEnrollment(id)!;
}
export function updateEnrollment(id: string, patch: Partial<Pick<StoredEnrollment, "status" | "nextActionAt">>, now: Date): void {
  const cur = getEnrollment(id);
  if (!cur) return;
  getDb().prepare("UPDATE prospect_enrollments SET status=?, next_action_at=?, updated_at=? WHERE id=?")
    .run(patch.status ?? cur.status, patch.nextActionAt !== undefined ? patch.nextActionAt : cur.nextActionAt, now.toISOString(), id);
}
export function getActiveEnrollments(): StoredEnrollment[] {
  return (getDb().prepare("SELECT * FROM prospect_enrollments WHERE status = 'active' ORDER BY next_action_at ASC").all() as any[]).map(toEnrollment);
}
export function getAllEnrollments(): StoredEnrollment[] {
  return (getDb().prepare("SELECT * FROM prospect_enrollments ORDER BY started_at DESC").all() as any[]).map(toEnrollment);
}

// ── Tasks ─────────────────────────────────────────────────────────────────────────────────────────
export function insertTask(t: Omit<StoredTask, "id" | "status" | "outcome" | "completedBy" | "completedAt" | "exportedAt"> & { status?: TaskStatus }, now: Date): StoredTask {
  const id = `PT-${randomUUID()}`;
  getDb().prepare("INSERT INTO prospect_tasks (id, enrollment_id, opportunity_id, entity_id, channel, step_index, due_at, status, subject, body, script, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, t.enrollmentId, t.opportunityId, t.entityId, t.channel, t.stepIndex, t.dueAt, t.status ?? "pending", t.subject, t.body, t.script, now.toISOString());
  return getTask(id)!;
}
export function getTask(id: string): StoredTask | null {
  const r = getDb().prepare("SELECT * FROM prospect_tasks WHERE id = ?").get(id);
  return r ? toTask(r) : null;
}
export function getTasksForEnrollment(enrollmentId: string): StoredTask[] {
  return (getDb().prepare("SELECT * FROM prospect_tasks WHERE enrollment_id = ? ORDER BY step_index ASC").all(enrollmentId) as any[]).map(toTask);
}
export function getPendingTasks(): StoredTask[] {
  return (getDb().prepare("SELECT * FROM prospect_tasks WHERE status = 'pending' ORDER BY due_at ASC").all() as any[]).map(toTask);
}
export function completeTask(id: string, outcome: TaskOutcome | null, by: string | null, now: Date): StoredTask | null {
  const t = getTask(id);
  if (!t) return null;
  getDb().prepare("UPDATE prospect_tasks SET status='done', outcome=?, completed_by=?, completed_at=? WHERE id=?").run(outcome, by, now.toISOString(), id);
  return getTask(id);
}
export function skipTask(id: string, now: Date): StoredTask | null {
  const t = getTask(id);
  if (!t) return null;
  getDb().prepare("UPDATE prospect_tasks SET status='skipped', completed_at=? WHERE id=?").run(now.toISOString(), id);
  return getTask(id);
}
export function markExported(ids: string[], now: Date): void {
  const stmt = getDb().prepare("UPDATE prospect_tasks SET exported_at=? WHERE id=?");
  const tx = getDb().transaction(() => { for (const id of ids) stmt.run(now.toISOString(), id); });
  tx();
}

// ── Cross-module signals (for analytics + campaigns) ────────────────────────────────────────────
/** Opportunities that have been routed into prospecting. */
export function enrolledOpportunityIds(): Set<string> {
  return new Set((getDb().prepare("SELECT opportunity_id FROM prospect_enrollments").all() as any[]).map((r) => r.opportunity_id));
}
/** Opportunities with at least one real touch logged (call connected/voicemail, email sent, reply). */
export function contactedOpportunityIds(): Set<string> {
  return new Set((getDb().prepare("SELECT DISTINCT opportunity_id FROM prospect_tasks WHERE status='done' AND outcome IN ('connected','voicemail','sent','replied','meeting')").all() as any[]).map((r) => r.opportunity_id));
}
/** Opportunities whose prospect responded (sequence handed off to a human). */
export function repliedOpportunityIds(): Set<string> {
  return new Set((getDb().prepare("SELECT opportunity_id FROM prospect_enrollments WHERE status='replied'").all() as any[]).map((r) => r.opportunity_id));
}

// ── Suppression ───────────────────────────────────────────────────────────────────────────────────
export interface SuppressionRow { id: string; kind: string; value: string; reason: string | null; createdAt: string }
export function addSuppression(kind: "email" | "domain" | "company", value: string, reason: string | null, by: string | null, now: Date): void {
  getDb().prepare("INSERT OR IGNORE INTO prospect_suppression (id, kind, value, reason, created_by, created_at) VALUES (?,?,?,?,?,?)")
    .run(`SUP-${randomUUID()}`, kind, value.trim().toLowerCase(), reason, by, now.toISOString());
}
export function getSuppression(): SuppressionRow[] {
  return (getDb().prepare("SELECT id, kind, value, reason, created_at FROM prospect_suppression ORDER BY created_at DESC").all() as any[])
    .map((r) => ({ id: r.id, kind: r.kind, value: r.value, reason: r.reason ?? null, createdAt: r.created_at }));
}
/** Is a contact suppressed? Checks email, its domain, and the company name. */
export function isSuppressed(opts: { email?: string | null; company?: string | null }): boolean {
  const db = getDb();
  const email = opts.email?.trim().toLowerCase();
  if (email) {
    if (db.prepare("SELECT 1 FROM prospect_suppression WHERE kind='email' AND value=?").get(email)) return true;
    const domain = email.split("@")[1];
    if (domain && db.prepare("SELECT 1 FROM prospect_suppression WHERE kind='domain' AND value=?").get(domain)) return true;
  }
  const company = opts.company?.trim().toLowerCase();
  if (company && db.prepare("SELECT 1 FROM prospect_suppression WHERE kind='company' AND value=?").get(company)) return true;
  return false;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

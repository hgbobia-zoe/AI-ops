// Prospecting — orchestration. Route an enriched opportunity into the tiered outreach motion, run the
// rep worklist, log outcomes (a reply pauses the sequence and hands to a human for Goodshuffle
// conversion), and export Tier-B email steps to the cold-email sequencer. Goodshuffle is NEVER touched
// here — it is reserved for conversion once a prospect responds.

import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import { opportunityDetail, singleView } from "@/lib/opportunity/service";
import { getOpportunity, setOpportunityStage, getEntity, type StoredOpportunity, type StoredEntity } from "@/lib/opportunity/store";
import { STAGE_ORDER, JURISDICTION_LABEL, type LifecycleStage } from "@/lib/opportunity/types";
import { draftOpportunityOutreach } from "@/lib/opportunity/outreach";
import { tierFor } from "./tiering";
import { defaultCadenceForTier } from "./cadences";
import { enrichEntityContact } from "./enrich";
import { toCsv, pushToSequencer, taskToRow, sequencerConfigured } from "./sequencer";
import {
  getEnrollmentByOpportunity, insertEnrollment, updateEnrollment, getEnrollment, getAllEnrollments,
  insertTask, getTask, getTasksForEnrollment, getPendingTasks, completeTask as completeTaskRow, skipTask as skipTaskRow, markExported,
  isSuppressed, type StoredEnrollment, type StoredTask,
} from "./store";
import type { TaskOutcome, Tier } from "./types";

function firstName(s: string | null): string {
  return (s ?? "").trim().split(/\s+/)[0] || "there";
}

// CAN-SPAM / hygiene footer appended to cold emails (physical identity + opt-out). House voice: no dashes.
function footer(): string {
  const mailing = process.env.ZOE_MAILING_ADDRESS || "Zoe Event Rentals, Washington DC / Maryland / Virginia";
  return `\n\nZoe Event Rentals\n${mailing}\nNot the right contact? Reply with "remove" and we will not reach out again.`;
}

export interface EnrollResult {
  ok: boolean;
  tier?: Tier;
  reasons?: string[];
  enrolled: boolean;
  enrollment?: StoredEnrollment;
  tasksCreated?: number;
  enrichedEmail?: string | null;
  error?: string;
}

/** Route an opportunity into the prospecting motion. Idempotent per opportunity. */
export async function enroll(opportunityId: string, owner: string | null, now: Date = new Date()): Promise<EnrollResult> {
  const today = todayInOpsTz(now);
  const detail = opportunityDetail(opportunityId, today);
  if (!detail) return { ok: false, enrolled: false, error: "opportunity not found" };

  const existing = getEnrollmentByOpportunity(opportunityId);
  if (existing) return { ok: true, enrolled: true, tier: existing.tier, enrollment: existing, tasksCreated: getTasksForEnrollment(existing.id).length };

  const decision = tierFor(detail, { awarded: detail.awarded });
  if (decision.tier === "C") return { ok: true, enrolled: false, tier: "C", reasons: decision.reasons };

  let target = detail.primaryTarget?.edge.entity ?? null;
  let enrichedEmail: string | null = null;
  if (target && !target.email) {
    enrichedEmail = await enrichEntityContact(target.id);
    target = getEntity(target.id) ?? target;
  }

  if (isSuppressed({ email: target?.email, company: target?.name ?? detail.opp.organization })) {
    return { ok: false, enrolled: false, tier: decision.tier, error: "target is on the do-not-contact list" };
  }

  const cadence = defaultCadenceForTier(decision.tier)!;
  const draft = await draftOpportunityOutreach(opportunityId, { repName: owner ?? undefined });

  const enrollment = insertEnrollment(
    { opportunityId, entityId: target?.id ?? null, tier: decision.tier, cadenceKey: cadence.key, channel: decision.channel, status: "active", owner, nextActionAt: today },
    now,
  );

  let first = true;
  for (let i = 0; i < cadence.steps.length; i++) {
    const step = cadence.steps[i];
    const dueAt = shiftYmd(today, step.day);
    const isEmail = step.channel === "email";
    const isCall = step.channel === "call";
    const subject = isEmail ? (first || i === 0 ? draft?.subject ?? `Event rentals for ${detail.opp.name}` : `Re: ${draft?.subject ?? detail.opp.name}`) : null;
    const body = isEmail ? `${draft?.body ?? ""}\n\n(${step.label}: ${step.note ?? ""})${footer()}` : null;
    const script = isCall ? draft?.callScript ?? null : step.channel === "linkedin" ? `Connect and reference ${detail.opp.name}. ${step.note ?? ""}` : null;
    insertTask({ enrollmentId: enrollment.id, opportunityId, entityId: target?.id ?? null, channel: step.channel, stepIndex: i, dueAt, subject, body, script }, now);
    if (isEmail) first = false;
  }

  // Enrolling means we're ready to reach out — advance the lifecycle if it's behind (never drag back).
  if (STAGE_ORDER.indexOf(detail.stage) < STAGE_ORDER.indexOf("OUTREACH_READY")) setOpportunityStage(opportunityId, "OUTREACH_READY", now);

  return { ok: true, enrolled: true, tier: decision.tier, reasons: decision.reasons, enrollment, tasksCreated: cadence.steps.length, enrichedEmail };
}

// ── Worklist ──────────────────────────────────────────────────────────────────────────────────────
export interface WorklistCard {
  task: StoredTask;
  opportunity: StoredOpportunity;
  opportunityScore: number;
  tier: Tier;
  entity: StoredEntity | null;
  overdue: boolean;
}

/** The rep worklist: pending tasks due today or overdue, richest context first. */
export function worklist(now: Date = new Date()): { today: string; overdue: WorklistCard[]; due: WorklistCard[]; counts: { call: number; email: number; total: number } } {
  const today = todayInOpsTz(now);
  const cards: WorklistCard[] = [];
  for (const t of getPendingTasks()) {
    if (t.dueAt > today) continue; // future task, not yet actionable
    const opp = getOpportunity(t.opportunityId);
    if (!opp) continue;
    const enr = getEnrollment(t.enrollmentId);
    if (!enr || enr.status !== "active") continue;
    const v = singleView(t.opportunityId, today);
    cards.push({ task: t, opportunity: opp, opportunityScore: v?.score.opportunityScore ?? 0, tier: enr.tier, entity: t.entityId ? getEntity(t.entityId) : null, overdue: t.dueAt < today });
  }
  cards.sort((a, b) => (a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0) || b.opportunityScore - a.opportunityScore || a.task.dueAt.localeCompare(b.task.dueAt));
  const overdue = cards.filter((c) => c.overdue);
  const due = cards.filter((c) => !c.overdue);
  const counts = { call: cards.filter((c) => c.task.channel === "call").length, email: cards.filter((c) => c.task.channel === "email").length, total: cards.length };
  return { today, overdue, due, counts };
}

// ── Task completion ─────────────────────────────────────────────────────────────────────────────
export function logOutcome(taskId: string, outcome: TaskOutcome | null, by: string | null, now: Date = new Date()): StoredTask | null {
  const task = getTask(taskId);
  if (!task) return null;
  const done = completeTaskRow(taskId, outcome, by, now);
  const enr = getEnrollment(task.enrollmentId);
  if (!enr) return done;

  if (outcome === "replied" || outcome === "meeting") {
    // A response: pause the sequence and hand to a human. Reply → the opportunity is ENGAGED; a human
    // now qualifies it and (only then) converts to a Goodshuffle quote.
    updateEnrollment(enr.id, { status: "replied", nextActionAt: null }, now);
    const opp = getOpportunity(task.opportunityId);
    if (opp && STAGE_ORDER.indexOf(opp.stage as LifecycleStage) < STAGE_ORDER.indexOf("ENGAGED")) setOpportunityStage(task.opportunityId, "ENGAGED", now);
  } else if (outcome === "not_interested" || outcome === "bounced") {
    updateEnrollment(enr.id, { status: "stopped", nextActionAt: null }, now);
  } else {
    const next = getTasksForEnrollment(enr.id).filter((t) => t.status === "pending").sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
    updateEnrollment(enr.id, next ? { nextActionAt: next.dueAt } : { status: "completed", nextActionAt: null }, now);
  }
  return done;
}

export function skipTask(taskId: string, now: Date = new Date()): StoredTask | null {
  const task = getTask(taskId);
  if (!task) return null;
  const done = skipTaskRow(taskId, now);
  const enr = getEnrollment(task.enrollmentId);
  if (enr) {
    const next = getTasksForEnrollment(enr.id).filter((t) => t.status === "pending").sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
    updateEnrollment(enr.id, next ? { nextActionAt: next.dueAt } : { status: "completed", nextActionAt: null }, now);
  }
  return done;
}

// ── Enrollment view (detail page) ─────────────────────────────────────────────────────────────────
export interface EnrollmentView { enrollment: StoredEnrollment; tasks: StoredTask[] }
export function enrollmentFor(opportunityId: string): EnrollmentView | null {
  const enrollment = getEnrollmentByOpportunity(opportunityId);
  if (!enrollment) return null;
  return { enrollment, tasks: getTasksForEnrollment(enrollment.id) };
}

// ── Email export to the sequencer ─────────────────────────────────────────────────────────────────
export interface ExportResult { csv: string; count: number; pushed: number; pushSkipped: boolean; provider?: string }

/** Gather pending email tasks (due on/before `today`) with a resolvable email, build the CSV, mark them
 *  exported, and optionally push to the configured sequencer. */
export async function exportEmailTasks(now: Date = new Date()): Promise<ExportResult> {
  const today = todayInOpsTz(now);
  const rows = [];
  const exportedIds: string[] = [];
  for (const t of getPendingTasks()) {
    if (t.channel !== "email" || t.dueAt > today || t.exportedAt) continue;
    const enr = getEnrollment(t.enrollmentId);
    if (!enr || enr.status !== "active") continue;
    const opp = getOpportunity(t.opportunityId);
    const entity = t.entityId ? getEntity(t.entityId) : null;
    if (!opp || !entity?.email) continue;
    if (isSuppressed({ email: entity.email, company: entity.name })) continue;
    const row = taskToRow(t, { email: entity.email, firstName: firstName(entity.name), company: entity.name, opportunity: opp.name, jurisdiction: JURISDICTION_LABEL[opp.jurisdiction], tier: enr.tier });
    if (row) { rows.push(row); exportedIds.push(t.id); }
  }
  const csv = toCsv(rows);
  let pushed = 0;
  let pushSkipped = true;
  let provider: string | undefined;
  if (sequencerConfigured() && rows.length > 0) {
    const res = await pushToSequencer(rows);
    provider = res.provider;
    pushSkipped = !!res.skipped;
    pushed = res.pushed ?? 0;
  }
  if (exportedIds.length > 0) markExported(exportedIds, now);
  return { csv, count: rows.length, pushed, pushSkipped, provider };
}

export { getAllEnrollments };

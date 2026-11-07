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
import { toCsv, taskToRow, complianceFooter, pushLeadsToSmartlead, smartleadKey, smartleadCampaignId, unsupportedProvider, type SmartleadLead } from "./sequencer";
import {
  getEnrollmentByOpportunity, insertEnrollment, updateEnrollment, getEnrollment, getAllEnrollments,
  insertTask, getTask, getTasksForEnrollment, getPendingTasks, completeTask as completeTaskRow, skipTask as skipTaskRow, markExported,
  isSuppressed, addSuppression, markEnrollmentPushed, type StoredEnrollment, type StoredTask,
} from "./store";
import { contactOwner } from "./contactOwnership";
import { insertAudit } from "@/lib/db/repo";
import type { TaskOutcome, Tier } from "./types";

function firstName(s: string | null): string {
  return (s ?? "").trim().split(/\s+/)[0] || "there";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

  if (isSuppressed({ email: target?.email, company: target?.name ?? detail.opp.organization, phone: target?.phone })) {
    return { ok: false, enrolled: false, tier: decision.tier, error: "target is on the do-not-contact list" };
  }
  // Sales OS wins: an existing Goodshuffle customer or open lead never goes into cold outreach.
  const own = contactOwner({ email: target?.email, phone: target?.phone }, today);
  if (own.owner === "salesos") return { ok: false, enrolled: false, tier: decision.tier, error: own.reason ?? "Sales OS owns this contact" };

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
    // The email the prospect reads: the draft plus the compliance footer. The cadence's coaching note
    // (step.note) is for the rep and never goes into the email.
    const body = isEmail ? `${draft?.body ?? ""}${complianceFooter()}` : null;
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
    if (t.channel === "email" && enr.sequencerPushedAt) continue; // Smartlead sends these steps
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
    // Never contact them again from either system: the email joins the shared do-not-contact list.
    const ent = task.entityId ? getEntity(task.entityId) : null;
    if (ent?.email) addSuppression("email", ent.email, outcome === "bounced" ? "bounced" : "not interested", by, now);
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

// ── Email export (CSV) ──────────────────────────────────────────────────────────────────────────────
export interface ExportResult { csv: string; count: number; skippedOwned: number }

/** Due email steps (on/before today) with a resolvable email, as a CSV for manual sending or another
 *  tool. Skips suppressed contacts, contacts Sales OS owns, and leads already handed to Smartlead. The
 *  exported steps are marked so they are not exported twice. */
export async function exportEmailTasks(now: Date = new Date()): Promise<ExportResult> {
  const today = todayInOpsTz(now);
  const rows = [];
  const exportedIds: string[] = [];
  let skippedOwned = 0;
  for (const t of getPendingTasks()) {
    if (t.channel !== "email" || t.dueAt > today || t.exportedAt) continue;
    const enr = getEnrollment(t.enrollmentId);
    if (!enr || enr.status !== "active" || enr.sequencerPushedAt) continue;
    const opp = getOpportunity(t.opportunityId);
    const entity = t.entityId ? getEntity(t.entityId) : null;
    if (!opp || !entity?.email) continue;
    if (isSuppressed({ email: entity.email, company: entity.name, phone: entity.phone })) continue;
    if (contactOwner({ email: entity.email, phone: entity.phone }, today).owner === "salesos") { skippedOwned++; continue; }
    const row = taskToRow(t, { email: entity.email, firstName: firstName(entity.name), company: entity.name, opportunity: opp.name, jurisdiction: JURISDICTION_LABEL[opp.jurisdiction], tier: enr.tier });
    if (row) { rows.push(row); exportedIds.push(t.id); }
  }
  if (exportedIds.length > 0) markExported(exportedIds, now);
  return { csv: toCsv(rows), count: rows.length, skippedOwned };
}

// ── Smartlead push (human approved) ─────────────────────────────────────────────────────────────────
export interface PushCandidate {
  enrollmentId: string;
  opportunityId: string;
  opportunityName: string;
  company: string;
  email: string | null;
  subject: string;
  body: string;
  dueAt: string;
  eligible: boolean;
  blockers: string[];
}

/** Every active Tier B enrollment whose first email is due and that has not been handed to Smartlead,
 *  with the deterministic reasons it can or cannot be pushed. Read only. */
export function pushCandidates(now: Date = new Date()): PushCandidate[] {
  const today = todayInOpsTz(now);
  const out: PushCandidate[] = [];
  for (const enr of getAllEnrollments()) {
    if (enr.status !== "active" || enr.tier !== "B" || enr.sequencerPushedAt) continue;
    const emails = getTasksForEnrollment(enr.id).filter((t) => t.channel === "email").sort((a, b) => a.stepIndex - b.stepIndex);
    const first = emails[0];
    if (!first || first.dueAt > today) continue;
    const opp = getOpportunity(enr.opportunityId);
    if (!opp) continue;
    const entity = enr.entityId ? getEntity(enr.entityId) : null;
    const blockers: string[] = [];
    const email = entity?.email?.trim() || null;
    if (!entity) blockers.push("no target contact");
    if (!email) blockers.push("no email address");
    else if (!EMAIL_RE.test(email)) blockers.push("email address looks invalid");
    if (isSuppressed({ email, company: entity?.name ?? opp.organization, phone: entity?.phone })) blockers.push("on the do-not-contact list");
    const own = contactOwner({ email, phone: entity?.phone }, today);
    if (own.owner === "salesos") blockers.push(own.reason ?? "Sales OS owns this contact");
    if (emails.some((t) => t.exportedAt)) blockers.push("already exported to CSV");
    out.push({
      enrollmentId: enr.id,
      opportunityId: opp.id,
      opportunityName: opp.name,
      company: entity?.name ?? opp.organization ?? "",
      email,
      subject: first.subject ?? "",
      body: first.body ?? "",
      dueAt: first.dueAt,
      eligible: blockers.length === 0,
      blockers,
    });
  }
  return out.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

export interface PushOutcome {
  ok: boolean;
  approved: number;
  added: number;
  skipped: { enrollmentId: string; reason: string }[];
  errors: string[];
}

/** Push exactly the enrollments a person approved. Re-checks eligibility first (nothing stale goes out),
 *  records each accepted lead, and audits the approval. Leads Smartlead skipped or failed stay unpushed. */
export async function pushApproved(
  enrollmentIds: string[],
  actor: string,
  now: Date = new Date(),
  fetchImpl?: Parameters<typeof pushLeadsToSmartlead>[1]["fetchImpl"],
): Promise<PushOutcome> {
  const out: PushOutcome = { ok: true, approved: enrollmentIds.length, added: 0, skipped: [], errors: [] };
  const bad = unsupportedProvider();
  const key = smartleadKey();
  const campaignId = smartleadCampaignId();
  if (bad) return { ...out, ok: false, errors: [`SEQUENCER_PROVIDER=${bad} is not supported; use Smartlead`] };
  if (!key || !campaignId) return { ...out, ok: false, errors: ["Smartlead is not connected (API key and campaign id)"] };

  const wanted = new Set(enrollmentIds);
  const candidates = pushCandidates(now).filter((c) => wanted.has(c.enrollmentId));
  for (const id of wanted) if (!candidates.some((c) => c.enrollmentId === id)) out.skipped.push({ enrollmentId: id, reason: "no longer due or already handed off" });
  const eligible = candidates.filter((c) => {
    if (!c.eligible) out.skipped.push({ enrollmentId: c.enrollmentId, reason: c.blockers.join("; ") });
    return c.eligible;
  });
  if (eligible.length === 0) return out;

  const leads: SmartleadLead[] = eligible.map((c) => {
    const opp = getOpportunity(c.opportunityId);
    return {
      email: c.email!,
      company_name: c.company,
      location: [opp?.city, opp?.state].filter(Boolean).join(", ") || undefined,
      custom_fields: {
        intro_subject: c.subject,
        intro_body: c.body,
        opportunity: c.opportunityName,
        event_date: opp?.estimatedDate ?? "",
        jurisdiction: opp ? JURISDICTION_LABEL[opp.jurisdiction] : "",
      },
    };
  });
  const res = await pushLeadsToSmartlead(leads, { key, campaignId, fetchImpl });
  out.ok = res.ok;
  out.errors.push(...res.errors);
  const skippedSet = new Set(res.skippedEmails);
  const failedSet = new Set(res.failedEmails);
  for (const c of eligible) {
    const e = c.email!.toLowerCase();
    if (failedSet.has(e)) { out.skipped.push({ enrollmentId: c.enrollmentId, reason: "Smartlead call failed; try again" }); continue; }
    if (skippedSet.has(e)) { out.skipped.push({ enrollmentId: c.enrollmentId, reason: "Smartlead skipped it (block, unsubscribe, bounce or duplicate list)" }); continue; }
    markEnrollmentPushed(c.enrollmentId, "smartlead", actor, now);
    const emailTaskIds = getTasksForEnrollment(c.enrollmentId).filter((t) => t.channel === "email").map((t) => t.id);
    if (emailTaskIds.length) markExported(emailTaskIds, now);
    out.added++;
    try {
      insertAudit({ actor, action: "prospecting.smartlead_push", entity: "prospect_enrollment", entityId: c.enrollmentId, after: { opportunityId: c.opportunityId, email: c.email, campaignId } });
    } catch { /* audit is observability only */ }
  }
  return out;
}

export { getAllEnrollments };

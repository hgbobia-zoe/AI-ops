// Post-Event Customer Experience — persistence layer. Server-only (imports getDb). Deterministic writes;
// no fabrication. The workflow row (postevent_projects) references the Goodshuffle booking by id and never
// copies its commercial data. Every state move writes a structured transition (actor + timestamp).

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/index";
import {
  type PostEventProject,
  type PostEventState,
  type Disposition,
  type NextAction,
  type ClosureReason,
  type ContactAttempt,
  type ContactInput,
  type ContactChannel,
  type ContactOutcome,
  type ReviewRecord,
  type IssueRecord,
  type IssueInput,
  type IssueType,
  type IssueState,
  type EscalationLevel,
  type PostEventConfig,
  defaultConfig,
  DEFAULT_SLA_DAYS,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const now = (): string => new Date().toISOString();
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// ── Config (settings KV) ────────────────────────────────────────────────────────────────────────────
const CONFIG_KEY = "postevent_config";

export function getConfig(): PostEventConfig {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(CONFIG_KEY) as { value: string } | undefined;
  const base = defaultConfig();
  if (!row) return base;
  try {
    const parsed = JSON.parse(row.value) as Partial<PostEventConfig>;
    return {
      reviewDestinationLabel: str(parsed.reviewDestinationLabel),
      reviewDestinationUrl: str(parsed.reviewDestinationUrl),
      reviewTemplate: str(parsed.reviewTemplate) || base.reviewTemplate,
      slaDays: { ...DEFAULT_SLA_DAYS, ...(parsed.slaDays ?? {}) },
    };
  } catch {
    return base;
  }
}

export function saveConfig(input: Partial<PostEventConfig>): PostEventConfig {
  const prev = getConfig();
  const next: PostEventConfig = {
    reviewDestinationLabel: input.reviewDestinationLabel !== undefined ? str(input.reviewDestinationLabel) : prev.reviewDestinationLabel,
    reviewDestinationUrl: input.reviewDestinationUrl !== undefined ? str(input.reviewDestinationUrl) : prev.reviewDestinationUrl,
    reviewTemplate: input.reviewTemplate !== undefined ? str(input.reviewTemplate) || prev.reviewTemplate : prev.reviewTemplate,
    slaDays: { ...prev.slaDays, ...(input.slaDays ?? {}) },
  };
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    )
    .run(CONFIG_KEY, JSON.stringify(next), now());
  return next;
}

// ── Projects ────────────────────────────────────────────────────────────────────────────────────────
function toProject(r: any): PostEventProject {
  return {
    bookingId: String(r.booking_id),
    state: r.state as PostEventState,
    disposition: (r.disposition as Disposition) ?? null,
    nextAction: (r.next_action as NextAction) ?? "none",
    assignedEmployee: r.assigned_employee ?? null,
    eventDate: r.event_date ?? null,
    pickupAt: r.pickup_at ?? null,
    eligibleAt: r.eligible_at,
    stageEnteredAt: r.stage_entered_at,
    closureReason: (r.closure_reason as ClosureReason) ?? null,
    closureNote: r.closure_note ?? null,
    closedAt: r.closed_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getProject(bookingId: string): PostEventProject | null {
  const r = getDb().prepare("SELECT * FROM postevent_projects WHERE booking_id = ?").get(bookingId);
  return r ? toProject(r) : null;
}

export function listProjects(): PostEventProject[] {
  return (getDb().prepare("SELECT * FROM postevent_projects").all() as any[]).map(toProject);
}

/** Insert a newly-eligible project in Needs Follow-Up. No-op if it already exists (idempotent). Records a
 *  'system' transition. Returns true if a new row was created. */
export function ensureProject(input: { bookingId: string; eventDate: string | null; pickupAt: string | null }): boolean {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM postevent_projects WHERE booking_id = ?").get(input.bookingId);
  if (exists) return false;
  const ts = now();
  db.prepare(
    `INSERT INTO postevent_projects (booking_id, state, disposition, next_action, assigned_employee,
       event_date, pickup_at, eligible_at, stage_entered_at, closure_reason, closure_note, closed_at, created_at, updated_at)
     VALUES (@bookingId,'needs_follow_up',NULL,'call',NULL,@eventDate,@pickupAt,@ts,@ts,NULL,NULL,NULL,@ts,@ts)`,
  ).run({ bookingId: input.bookingId, eventDate: input.eventDate, pickupAt: input.pickupAt, ts });
  recordTransition({ bookingId: input.bookingId, from: null, to: "needs_follow_up", actor: "system", note: "Eligible: event + pickup completed" });
  return true;
}

export interface TransitionInput {
  bookingId: string;
  from: PostEventState | null;
  to: PostEventState;
  actor: string;
  note?: string;
}
export function recordTransition(t: TransitionInput): void {
  getDb()
    .prepare(
      `INSERT INTO postevent_transitions (id, booking_id, from_state, to_state, actor, note, ts)
       VALUES (@id,@bookingId,@from,@to,@actor,@note,@ts)`,
    )
    .run({ id: `PT-${randomUUID()}`, bookingId: t.bookingId, from: t.from, to: t.to, actor: t.actor, note: t.note ?? null, ts: now() });
}

export interface TransitionRow {
  id: string;
  bookingId: string;
  fromState: PostEventState | null;
  toState: PostEventState;
  actor: string | null;
  note: string | null;
  ts: string;
}
export function getTransitions(bookingId: string): TransitionRow[] {
  return (getDb().prepare("SELECT * FROM postevent_transitions WHERE booking_id = ? ORDER BY ts").all(bookingId) as any[]).map((r) => ({
    id: String(r.id),
    bookingId: String(r.booking_id),
    fromState: (r.from_state as PostEventState) ?? null,
    toState: r.to_state as PostEventState,
    actor: r.actor ?? null,
    note: r.note ?? null,
    ts: r.ts,
  }));
}

/** Move a project to a new state (drag or programmatic). Sets stage_entered_at + records a transition.
 *  next_action is recomputed by the caller (engine) after the move. No-op if already in that state. */
export function setState(bookingId: string, to: PostEventState, actor: string, note?: string): PostEventProject | null {
  const prev = getProject(bookingId);
  if (!prev) return null;
  if (prev.state === to) return prev;
  const ts = now();
  getDb()
    .prepare("UPDATE postevent_projects SET state=@to, stage_entered_at=@ts, updated_at=@ts WHERE booking_id=@bookingId")
    .run({ to, ts, bookingId });
  recordTransition({ bookingId, from: prev.state, to, actor, note });
  return getProject(bookingId);
}

export function setDisposition(bookingId: string, disposition: Disposition | null): PostEventProject | null {
  const prev = getProject(bookingId);
  if (!prev) return null;
  getDb().prepare("UPDATE postevent_projects SET disposition=@disposition, updated_at=@ts WHERE booking_id=@bookingId").run({ disposition, ts: now(), bookingId });
  return getProject(bookingId);
}

export function setAssignee(bookingId: string, employee: string | null): PostEventProject | null {
  const prev = getProject(bookingId);
  if (!prev) return null;
  getDb().prepare("UPDATE postevent_projects SET assigned_employee=@employee, updated_at=@ts WHERE booking_id=@bookingId").run({ employee: employee || null, ts: now(), bookingId });
  return getProject(bookingId);
}

export function setNextAction(bookingId: string, nextAction: NextAction): void {
  getDb().prepare("UPDATE postevent_projects SET next_action=@nextAction, updated_at=@ts WHERE booking_id=@bookingId").run({ nextAction, ts: now(), bookingId });
}

/** Close a project with a STRUCTURED reason. 'other' requires a note (enforced by the caller too). */
export function closeProject(bookingId: string, reason: ClosureReason, note: string | null, actor: string): PostEventProject | null {
  const prev = getProject(bookingId);
  if (!prev) return null;
  const ts = now();
  getDb()
    .prepare(
      `UPDATE postevent_projects SET state='closed', closure_reason=@reason, closure_note=@note, closed_at=@ts,
         next_action='none', stage_entered_at=@ts, updated_at=@ts WHERE booking_id=@bookingId`,
    )
    .run({ reason, note: note || null, ts, bookingId });
  recordTransition({ bookingId, from: prev.state, to: "closed", actor, note: reason + (note ? `: ${note}` : "") });
  return getProject(bookingId);
}

/** Reopen a closed project (edge case: customer responds after close). Clears closure fields. */
export function reopenProject(bookingId: string, to: PostEventState, actor: string, note?: string): PostEventProject | null {
  const prev = getProject(bookingId);
  if (!prev) return null;
  const ts = now();
  getDb()
    .prepare("UPDATE postevent_projects SET state=@to, closure_reason=NULL, closure_note=NULL, closed_at=NULL, stage_entered_at=@ts, updated_at=@ts WHERE booking_id=@bookingId")
    .run({ to, ts, bookingId });
  recordTransition({ bookingId, from: prev.state, to, actor, note: note ?? "Reopened" });
  return getProject(bookingId);
}

// ── Contacts ────────────────────────────────────────────────────────────────────────────────────────
function toContact(r: any): ContactAttempt {
  return {
    id: String(r.id),
    bookingId: String(r.booking_id),
    occurredAt: r.occurred_at,
    channel: r.channel as ContactChannel,
    employee: r.employee ?? null,
    outcome: r.outcome as ContactOutcome,
    direction: (r.direction as "outbound" | "inbound") ?? null,
    notes: r.notes ?? "",
    source: (r.source as "manual" | "comms") ?? "manual",
    createdAt: r.created_at,
  };
}

export function listContacts(bookingId: string): ContactAttempt[] {
  return (getDb().prepare("SELECT * FROM postevent_contacts WHERE booking_id = ? ORDER BY occurred_at DESC").all(bookingId) as any[]).map(toContact);
}

export function addContact(bookingId: string, input: ContactInput, employee: string | null): ContactAttempt {
  const id = `PC-${randomUUID()}`;
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO postevent_contacts (id, booking_id, occurred_at, channel, employee, outcome, direction, notes, source, dedupe_key, created_at)
       VALUES (@id,@bookingId,@occurredAt,@channel,@employee,@outcome,@direction,@notes,'manual',NULL,@ts)`,
    )
    .run({
      id,
      bookingId,
      occurredAt: input.occurredAt || ts,
      channel: input.channel ?? "phone",
      employee: input.employee !== undefined ? input.employee : employee,
      outcome: input.outcome ?? "other",
      direction: input.direction ?? "outbound",
      notes: str(input.notes),
      ts,
    });
  return toContact(getDb().prepare("SELECT * FROM postevent_contacts WHERE id = ?").get(id));
}

/** Insert an AUTO contact (from comms) if its dedupe_key is new. Idempotent. Returns true if inserted. */
export function addAutoContact(c: {
  bookingId: string;
  occurredAt: string;
  channel: ContactChannel;
  employee: string | null;
  outcome: ContactOutcome;
  direction: "outbound" | "inbound";
  notes: string;
  dedupeKey: string;
}): boolean {
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO postevent_contacts (id, booking_id, occurred_at, channel, employee, outcome, direction, notes, source, dedupe_key, created_at)
       VALUES (@id,@bookingId,@occurredAt,@channel,@employee,@outcome,@direction,@notes,'comms',@dedupeKey,@ts)`,
    )
    .run({
      id: `PC-${randomUUID()}`,
      bookingId: c.bookingId,
      occurredAt: c.occurredAt,
      channel: c.channel,
      employee: c.employee,
      outcome: c.outcome,
      direction: c.direction,
      notes: c.notes,
      dedupeKey: c.dedupeKey,
      ts: now(),
    });
  return info.changes > 0;
}

// ── Reviews ─────────────────────────────────────────────────────────────────────────────────────────
function toReview(r: any): ReviewRecord {
  return {
    id: String(r.id),
    bookingId: String(r.booking_id),
    kind: r.kind as "requested" | "received",
    occurredAt: r.occurred_at,
    employee: r.employee ?? null,
    channel: r.channel ?? null,
    destination: r.destination ?? null,
    message: r.message ?? null,
    rating: r.rating ?? null,
    link: r.link ?? null,
    createdAt: r.created_at,
  };
}

export function listReviews(bookingId: string): ReviewRecord[] {
  return (getDb().prepare("SELECT * FROM postevent_reviews WHERE booking_id = ? ORDER BY occurred_at DESC").all(bookingId) as any[]).map(toReview);
}

export function addReview(r: {
  bookingId: string;
  kind: "requested" | "received";
  employee: string | null;
  channel?: string | null;
  destination?: string | null;
  message?: string | null;
  rating?: number | null;
  link?: string | null;
}): ReviewRecord {
  const id = `PR-${randomUUID()}`;
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO postevent_reviews (id, booking_id, kind, occurred_at, employee, channel, destination, message, rating, link, created_at)
       VALUES (@id,@bookingId,@kind,@ts,@employee,@channel,@destination,@message,@rating,@link,@ts)`,
    )
    .run({
      id,
      bookingId: r.bookingId,
      kind: r.kind,
      employee: r.employee,
      channel: r.channel ?? null,
      destination: r.destination ?? null,
      message: r.message ?? null,
      rating: r.rating == null ? null : Math.max(1, Math.min(5, Math.round(r.rating))),
      link: r.link ?? null,
      ts,
    });
  return toReview(getDb().prepare("SELECT * FROM postevent_reviews WHERE id = ?").get(id));
}

/** Has a review request already been recorded for this project? (idempotency — never double-send.) */
export function hasReviewRequest(bookingId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM postevent_reviews WHERE booking_id = ? AND kind = 'requested' LIMIT 1").get(bookingId);
}

// ── Issues ──────────────────────────────────────────────────────────────────────────────────────────
function toIssue(r: any): IssueRecord {
  return {
    id: String(r.id),
    bookingId: String(r.booking_id),
    issueType: (r.issue_type as IssueType) ?? null,
    description: r.description ?? "",
    state: r.state as IssueState,
    escalationLevel: (r.escalation_level as EscalationLevel) ?? "none",
    assignedEmployee: r.assigned_employee ?? null,
    resolution: r.resolution ?? "",
    refundCredit: r.refund_credit ?? null,
    resolutionAt: r.resolution_at ?? null,
    finalResponse: r.final_response ?? "",
    closureReason: r.closure_reason ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listIssues(bookingId: string): IssueRecord[] {
  return (getDb().prepare("SELECT * FROM postevent_issues WHERE booking_id = ? ORDER BY created_at DESC").all(bookingId) as any[]).map(toIssue);
}

export function listAllOpenIssues(): IssueRecord[] {
  return (getDb().prepare("SELECT * FROM postevent_issues WHERE state != 'closed' ORDER BY created_at DESC").all() as any[]).map(toIssue);
}

/** Open-issue counts per booking (board badge). */
export function openIssueCounts(): Map<string, number> {
  const rows = getDb().prepare("SELECT booking_id, COUNT(*) AS n FROM postevent_issues WHERE state != 'closed' GROUP BY booking_id").all() as { booking_id: string; n: number }[];
  const m = new Map<string, number>();
  for (const r of rows) m.set(String(r.booking_id), r.n);
  return m;
}

export function createIssue(bookingId: string, input: IssueInput, createdBy: string | null): IssueRecord {
  const id = `PI-${randomUUID()}`;
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO postevent_issues (id, booking_id, issue_type, description, state, escalation_level, assigned_employee,
         resolution, refund_credit, resolution_at, final_response, closure_reason, created_by, created_at, updated_at)
       VALUES (@id,@bookingId,@issueType,@description,@state,@escalationLevel,@assignedEmployee,@resolution,@refundCredit,NULL,@finalResponse,NULL,@createdBy,@ts,@ts)`,
    )
    .run({
      id,
      bookingId,
      issueType: input.issueType ?? "other",
      description: str(input.description),
      state: input.state ?? "identified",
      escalationLevel: input.escalationLevel ?? "none",
      assignedEmployee: input.assignedEmployee ?? null,
      resolution: str(input.resolution),
      refundCredit: input.refundCredit ?? null,
      finalResponse: str(input.finalResponse),
      createdBy,
      ts,
    });
  return toIssue(getDb().prepare("SELECT * FROM postevent_issues WHERE id = ?").get(id));
}

export function updateIssue(id: string, input: IssueInput): IssueRecord | null {
  const prev = getDb().prepare("SELECT * FROM postevent_issues WHERE id = ?").get(id) as any;
  if (!prev) return null;
  const merge = <T>(v: T | undefined, fb: T): T => (v === undefined ? fb : v);
  const state = merge(input.state, prev.state as IssueState);
  const ts = now();
  // Stamp resolution_at the first time it reaches a resolved state.
  const resolvedStates: IssueState[] = ["resolution_completed", "customer_follow_up", "closed"];
  const resolutionAt = resolvedStates.includes(state) ? prev.resolution_at ?? ts : prev.resolution_at;
  getDb()
    .prepare(
      `UPDATE postevent_issues SET issue_type=@issueType, description=@description, state=@state, escalation_level=@escalationLevel,
         assigned_employee=@assignedEmployee, resolution=@resolution, refund_credit=@refundCredit, resolution_at=@resolutionAt,
         final_response=@finalResponse, closure_reason=@closureReason, updated_at=@ts WHERE id=@id`,
    )
    .run({
      id,
      issueType: merge(input.issueType, prev.issue_type),
      description: input.description !== undefined ? str(input.description) : prev.description,
      state,
      escalationLevel: merge(input.escalationLevel, prev.escalation_level),
      assignedEmployee: input.assignedEmployee !== undefined ? input.assignedEmployee : prev.assigned_employee,
      resolution: input.resolution !== undefined ? str(input.resolution) : prev.resolution,
      refundCredit: input.refundCredit !== undefined ? input.refundCredit : prev.refund_credit,
      resolutionAt,
      finalResponse: input.finalResponse !== undefined ? str(input.finalResponse) : prev.final_response,
      closureReason: input.closureReason !== undefined ? input.closureReason : prev.closure_reason,
      ts,
    });
  return toIssue(getDb().prepare("SELECT * FROM postevent_issues WHERE id = ?").get(id));
}

/* eslint-enable @typescript-eslint/no-explicit-any */

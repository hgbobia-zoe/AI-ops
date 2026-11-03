// The History feed: the change log PLUS what the platform and people did, merged at read time from the
// records those actions already keep. Nothing new is logged and no other blade is hooked:
//   • history_changes (risk scan, Dispatch, Goodshuffle pull hooks)       → store.queryChanges
//   • gs_outbox       (Goodshuffle write-backs that landed or failed)
//   • ai_approvals    (a person approved / rejected an AI draft)
//   • audit_logs      (an allowlist of operational actions only; payroll, finance and page views stay out)
// Every item says WHO: a named person, "someone" when the record has no name, or the platform.
// Pure parts (classifyChange, describe*, mergePage, parseCursor) are unit tested.

import { getDb } from "@/lib/db";
import type { Tone } from "@/lib/tone";
import { queryChanges, type ChangeRow } from "./store";
import { describeChange, AREA_KINDS, AREA_LABEL as CHANGE_AREA_LABEL, type HistoryArea } from "./describe";

// ── Types ──────────────────────────────────────────────────────────────────────────────────────────

export type FeedArea = HistoryArea | "goodshuffle" | "ai";
export type Who = "person" | "platform";

export const FEED_AREAS: FeedArea[] = ["risk", "crew", "route", "booking", "goodshuffle", "ai"];
export const FEED_AREA_LABEL: Record<FeedArea, string> = {
  ...CHANGE_AREA_LABEL,
  crew: "Crew & drivers",
  goodshuffle: "Goodshuffle write-backs",
  ai: "AI approvals",
};

export interface FeedBy {
  who: Who;
  /** The person's name when the record has one. Null for the platform, or a person the record didn't name. */
  name: string | null;
  /** Where an unnamed person acted ("Dispatch", "the driver app"). */
  where?: string;
}

export interface FeedItem {
  id: string;
  ts: string;
  area: FeedArea | null;
  tone: Tone;
  title: string;
  subject: string | null;
  detail: string | null;
  eventId: string | null;
  by: FeedBy;
}

// ── Change log: who did each kind ──────────────────────────────────────────────────────────────────

// Kinds recorded from a person's action. Everything else in the change log is the platform noticing a
// change (risk scan, Goodshuffle pull) or acting on its own (linen safeguard).
const PERSON_KINDS: Record<string, string> = {
  driver_assigned: "Dispatch",
  driver_reassigned: "Dispatch",
  driver_cleared: "Dispatch",
  stop_removed: "Dispatch",
  event_completed: "Dispatch",
  risk_status_changed: "Event Risk",
};

export function classifyChange(c: Pick<ChangeRow, "kind" | "toValue"> & { actor?: string | null }): FeedBy {
  const where = PERSON_KINDS[c.kind];
  if (!where) return { who: "platform", name: null };
  // The signed-in person recorded with the change (newer rows). Older rows fall back to what they kept.
  if (c.actor) return { who: "person", name: c.actor, where };
  if (c.kind === "risk_status_changed") {
    const m = /\(by (.+)\)\s*$/.exec(c.toValue ?? "");
    if (m) return { who: "person", name: m[1], where };
  }
  return { who: "person", name: null, where };
}

/** PURE. A change's line plus who did it. A risk decision's "(by Jessie)" moves into `by`; if a different
 *  owner was stated than the person who clicked, it stays as "owner Jessie". */
export function changeLine(c: ChangeRow, showMoney: boolean): { line: ReturnType<typeof describeChange>; by: FeedBy } {
  const line = describeChange(c, { showMoney });
  const by = classifyChange(c);
  if (c.kind === "risk_status_changed" && line.detail?.startsWith("by ")) {
    const owner = line.detail.slice(3);
    line.detail = owner === by.name ? null : `owner ${owner}`;
  }
  return { line, by };
}

function changeToItem(c: ChangeRow, showMoney: boolean): FeedItem {
  const { line: d, by } = changeLine(c, showMoney);
  return { id: c.id, ts: c.ts, area: d.area, tone: d.tone, title: d.title, subject: d.subject, detail: d.detail, eventId: c.eventId, by };
}

// ── Goodshuffle write-backs ────────────────────────────────────────────────────────────────────────

const OP_TITLE: Record<string, string> = {
  photo_upload: "Delivery photo uploaded to Goodshuffle",
  add_team_member: "Team member added to a Goodshuffle project",
  set_delivery_fee: "Delivery fee set in Goodshuffle",
  email_send: "Email sent to the client from Goodshuffle",
  email_template: "Template email sent from Goodshuffle",
  create_gs_task: "Task created in Goodshuffle",
  provision_user: "Goodshuffle user added",
  revoke_user: "Goodshuffle user removed",
  create_project: "Goodshuffle project created from a lead",
  remove_waypoint: "Stop removed from the Goodshuffle route",
  disable_esignature: "Online signing turned off in Goodshuffle",
  mark_lost: "Project marked lost and archived in Goodshuffle",
};
// The same ops as a task, for the failure line ("Goodshuffle write-back failed: upload a delivery photo").
const OP_TASK: Record<string, string> = {
  photo_upload: "upload a delivery photo",
  add_team_member: "add a team member",
  set_delivery_fee: "set the delivery fee",
  email_send: "send an email to the client",
  email_template: "send a template email",
  create_gs_task: "create a task",
  provision_user: "add a user",
  revoke_user: "remove a user",
  create_project: "create a project from a lead",
  remove_waypoint: "remove a stop from the route",
  disable_esignature: "turn off online signing",
  mark_lost: "mark the project lost and archive it",
};
// Note copies mirror every synced text and call; they live in the Sales timeline and would bury the feed.
export const FEED_SKIPPED_OPS = ["note_append"];
const MONEY_OPS = new Set(["set_delivery_fee"]);

export interface OutboxFeedRow {
  id: string;
  op: string;
  label: string | null;
  transaction_id: string | null;
  status: string;
  last_error: string | null;
  updated_at: string;
  decided_by: string | null;
}

export function describeWriteBack(r: OutboxFeedRow, showMoney: boolean): FeedItem {
  const landed = r.status === "done";
  const base = OP_TITLE[r.op] ?? `Goodshuffle ${r.op.replace(/_/g, " ")}`;
  const subject = !showMoney && MONEY_OPS.has(r.op) ? null : r.label || null;
  return {
    id: `OB:${r.id}`,
    ts: r.updated_at,
    area: "goodshuffle",
    tone: landed ? "positive" : "critical",
    title: landed ? base : `Goodshuffle write-back failed, needs a person: ${OP_TASK[r.op] ?? r.op.replace(/_/g, " ")}`,
    subject,
    detail: landed ? null : r.last_error ? r.last_error.slice(0, 140) : null,
    eventId: r.transaction_id || null,
    by: r.decided_by ? { who: "person", name: r.decided_by } : { who: "platform", name: null },
  };
}

// ── AI approvals ───────────────────────────────────────────────────────────────────────────────────

export interface ApprovalFeedRow {
  id: string;
  title: string;
  status: string;
  decided_by: string | null;
  decided_at: string;
  financial: number;
  decision_note: string | null;
}

const APPROVAL_VERB: Record<string, { verb: string; tone: Tone }> = {
  approved: { verb: "Approved an AI draft", tone: "positive" },
  executed: { verb: "Approved an AI draft", tone: "positive" },
  queued: { verb: "Approved an AI draft", tone: "positive" },
  confirmed: { verb: "Approved an AI draft", tone: "positive" },
  failed: { verb: "Approved an AI draft, but it failed to send", tone: "critical" },
  rejected: { verb: "Rejected an AI draft", tone: "neutral" },
  info_requested: { verb: "Asked the AI for more info", tone: "info" },
};

export function describeApproval(r: ApprovalFeedRow, showMoney: boolean): FeedItem {
  const v = APPROVAL_VERB[r.status] ?? { verb: `AI draft ${r.status.replace(/_/g, " ")}`, tone: "neutral" as Tone };
  return {
    id: `AP:${r.id}`,
    ts: r.decided_at,
    area: "ai",
    tone: v.tone,
    title: v.verb,
    subject: r.financial && !showMoney ? "a draft with dollar amounts" : r.title,
    detail: r.status === "rejected" && r.decision_note ? r.decision_note.slice(0, 140) : null,
    eventId: null,
    by: r.decided_by ? { who: "person", name: r.decided_by } : { who: "person", name: null, where: "AI approvals" },
  };
}

// ── Audit log allowlist ────────────────────────────────────────────────────────────────────────────

export interface AuditFeedRow {
  audit_id: string;
  ts: string;
  actor: string | null;
  action: string;
  entity_id: string | null;
  after: string | null;
}

type AuditRule = { area: FeedArea; tone: Tone; who: Who; title: (a: Record<string, unknown>) => string; subject?: (r: AuditFeedRow, a: Record<string, unknown>) => string | null; detail?: (a: Record<string, unknown>) => string | null; named?: boolean; where?: string };

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export const AUDIT_RULES: Record<string, AuditRule> = {
  SHIFT_PUBLISH_SENT: { area: "crew", tone: "info", who: "person", named: true, title: () => "Shift published to Connecteam", detail: (a) => (a.notified ? `${str(a.notified)} crew notified` : null) },
  SHIFT_PUBLISH_UPDATED: { area: "crew", tone: "info", who: "person", named: true, title: () => "Published shift updated in Connecteam", detail: (a) => (a.notified ? `${str(a.notified)} crew notified` : null) },
  ROUTE_SEAT_REMOVED_NOT_TRUCK_CREW: { area: "crew", tone: "attention", who: "platform", title: () => "Asset prep worker taken off a truck route", detail: (a) => (a.crewRole ? `role ${str(a.crewRole)}` : null) },
  ROUTE_AUTO_FINALIZED: { area: "route", tone: "positive", who: "platform", title: () => "Route closed on its own for the next route", subject: (r) => (r.entity_id ? `route ${r.entity_id}` : null), detail: (a) => str(a.reason) || null },
  ROUTE_HANDOFF_FLAGGED: { area: "route", tone: "attention", who: "platform", title: () => "Route flagged: still open when its truck is needed", subject: (r) => (r.entity_id ? `route ${r.entity_id}` : null), detail: (a) => (a.incompleteStops ? `${str(a.incompleteStops)} stops unfinished` : null) },
  ROUTE_HANDOFF_CONFLICT_ALERT: { area: "route", tone: "critical", who: "platform", title: () => "Dispatch alerted: open route blocks the next one", subject: (r) => (r.entity_id ? `route ${r.entity_id}` : null) },
  ROUTE_CLOSEOUT: { area: "route", tone: "positive", who: "person", where: "the driver app", title: (a) => (a.hasIssue ? "Driver closed out the route and reported an issue" : "Driver closed out the route"), subject: (r) => (r.entity_id ? `route ${r.entity_id}` : null), detail: (a) => (a.hasIssue && a.issueNote ? str(a.issueNote).slice(0, 140) : null) },
  REPORT_EXCEPTION: { area: "route", tone: "attention", who: "person", where: "the driver app", title: (a) => `Driver reported a problem${a.type ? `: ${str(a.type)}` : ""}`, detail: (a) => str(a.reason).slice(0, 140) || null },
  AI_AGENT_PAUSED: { area: "ai", tone: "attention", who: "person", named: true, title: () => "Paused an AI employee", subject: (r) => r.entity_id },
  AI_AGENT_RESUMED: { area: "ai", tone: "info", who: "person", named: true, title: () => "Resumed an AI employee", subject: (r) => r.entity_id },
};

export function describeAudit(r: AuditFeedRow): FeedItem | null {
  const rule = AUDIT_RULES[r.action];
  if (!rule) return null;
  let a: Record<string, unknown> = {};
  try {
    a = r.after ? (JSON.parse(r.after) as Record<string, unknown>) : {};
  } catch {
    a = {};
  }
  const by: FeedBy = rule.who === "platform" ? { who: "platform", name: null } : { who: "person", name: rule.named && r.actor ? r.actor : null, where: rule.where };
  return {
    id: `AU:${r.audit_id}`,
    ts: r.ts,
    area: rule.area,
    tone: rule.tone,
    title: rule.title(a),
    subject: rule.subject ? rule.subject(r, a) : null,
    detail: rule.detail ? rule.detail(a) : null,
    eventId: null,
    by,
  };
}

// ── Paging ─────────────────────────────────────────────────────────────────────────────────────────

/** "ts|id" → parts. Items sort newest first, ties broken by id descending, across every source. */
export function parseCursor(c: string | undefined | null): { ts: string; id: string } | null {
  if (!c) return null;
  const i = c.lastIndexOf("|");
  return i < 0 ? { ts: c, id: "" } : { ts: c.slice(0, i), id: c.slice(i + 1) };
}

const after = (x: { ts: string; id: string }, cur: { ts: string; id: string } | null): boolean => !cur || x.ts < cur.ts || (x.ts === cur.ts && x.id < cur.id);

/** PURE. Merge per-source pages (each newest first, each fetched with limit+1) into one page. */
export function mergePage(lists: FeedItem[][], limit: number, cursor: string | null = null): { items: FeedItem[]; nextBefore: string | null } {
  const cur = parseCursor(cursor);
  const all = lists
    .flat()
    .filter((x) => after(x, cur))
    .sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.ts < b.ts ? 1 : -1));
  const items = all.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextBefore: all.length > limit && last ? `${last.ts}|${last.id}` : null };
}

// ── Live sources ───────────────────────────────────────────────────────────────────────────────────

export interface FeedQuery {
  area?: FeedArea | null;
  who?: Who | null;
  q?: string | null;
  before?: string | null;
  limit?: number;
  showMoney: boolean;
}

const likeOf = (q: string): string => `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;

/**
 * PURE. Translate the feed cursor into one source's own (ts, raw id). Feed ids are prefix + raw id
 * (CH- change log ids already carry theirs; OB:, AP:, AU: for the others). At the cursor's timestamp a
 * source's rows come after the cursor when prefix+raw < cursor id: when the cursor is from the same
 * source compare raw ids, otherwise the prefix alone decides (all rows or none).
 */
export function cursorFor(prefix: string, cursor: string | null): { ts: string; id: string } | null {
  const c = parseCursor(cursor);
  if (!c) return null;
  if (c.id.startsWith(prefix)) return { ts: c.ts, id: c.id.slice(prefix.length) };
  return { ts: c.ts, id: prefix < c.id ? "￿" : "" };
}

function writeBackRows(opts: { q: string | null; before: string | null; who: Who | null; limit: number; eventId?: string }): OutboxFeedRow[] {
  const where = ["o.status IN ('done','dead','failed')", `o.op NOT IN (${FEED_SKIPPED_OPS.map(() => "?").join(",")})`];
  const args: unknown[] = [...FEED_SKIPPED_OPS];
  if (opts.who === "person") where.push("a.decided_by IS NOT NULL");
  if (opts.who === "platform") where.push("a.decided_by IS NULL");
  if (opts.eventId) {
    where.push("o.transaction_id = ?");
    args.push(opts.eventId);
  }
  if (opts.q) {
    const l = likeOf(opts.q);
    where.push("(o.label LIKE ? ESCAPE '\\' OR o.transaction_id LIKE ? ESCAPE '\\' OR o.op LIKE ? ESCAPE '\\' OR a.decided_by LIKE ? ESCAPE '\\')");
    args.push(l, l, l, l);
  }
  const c = cursorFor("OB:", opts.before);
  if (c) {
    where.push("(o.updated_at < ? OR (o.updated_at = ? AND o.id < ?))");
    args.push(c.ts, c.ts, c.id);
  }
  return getDb()
    .prepare(
      `SELECT o.id, o.op, o.label, o.transaction_id, o.status, o.last_error, o.updated_at, a.decided_by
       FROM gs_outbox o LEFT JOIN ai_approvals a ON a.outbox_op_id = o.id
       WHERE ${where.join(" AND ")} ORDER BY o.updated_at DESC, o.id DESC LIMIT ?`,
    )
    .all(...args, opts.limit + 1) as OutboxFeedRow[];
}

function approvalRows(opts: { q: string | null; before: string | null; limit: number }): ApprovalFeedRow[] {
  const where = ["decided_at IS NOT NULL", "status NOT IN ('pending','edited')"];
  const args: unknown[] = [];
  if (opts.q) {
    const l = likeOf(opts.q);
    where.push("(title LIKE ? ESCAPE '\\' OR decided_by LIKE ? ESCAPE '\\')");
    args.push(l, l);
  }
  const c = cursorFor("AP:", opts.before);
  if (c) {
    where.push("(decided_at < ? OR (decided_at = ? AND id < ?))");
    args.push(c.ts, c.ts, c.id);
  }
  return getDb()
    .prepare(`SELECT id, title, status, decided_by, decided_at, financial, decision_note FROM ai_approvals WHERE ${where.join(" AND ")} ORDER BY decided_at DESC, id DESC LIMIT ?`)
    .all(...args, opts.limit + 1) as ApprovalFeedRow[];
}

function auditRows(opts: { actions: string[]; q: string | null; before: string | null; limit: number }): AuditFeedRow[] {
  if (opts.actions.length === 0) return [];
  const where = [`action IN (${opts.actions.map(() => "?").join(",")})`];
  const args: unknown[] = [...opts.actions];
  if (opts.q) {
    const l = likeOf(opts.q);
    where.push("(actor LIKE ? ESCAPE '\\' OR entity_id LIKE ? ESCAPE '\\' OR after LIKE ? ESCAPE '\\')");
    args.push(l, l, l);
  }
  const c = cursorFor("AU:", opts.before);
  if (c) {
    where.push("(ts < ? OR (ts = ? AND audit_id < ?))");
    args.push(c.ts, c.ts, c.id);
  }
  return getDb()
    .prepare(`SELECT audit_id, ts, actor, action, entity_id, after FROM audit_logs WHERE ${where.join(" AND ")} ORDER BY ts DESC, audit_id DESC LIMIT ?`)
    .all(...args, opts.limit + 1) as AuditFeedRow[];
}

/** One page of the History feed across every source, newest first. */
export function historyFeed(opts: FeedQuery): { items: FeedItem[]; nextBefore: string | null } {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 150));
  const area = opts.area ?? null;
  const who = opts.who ?? null;
  const q = opts.q?.trim() || null;
  const before = opts.before ?? null;
  const lists: FeedItem[][] = [];

  // Change log: area kinds, narrowed by who did them.
  if (!area || area in AREA_KINDS) {
    const areaKinds = area ? AREA_KINDS[area as HistoryArea] : null;
    let kinds: string[] | undefined = areaKinds ?? undefined;
    if (who) {
      const base = areaKinds ?? Object.values(AREA_KINDS).flat();
      kinds = base.filter((k) => (k in PERSON_KINDS) === (who === "person"));
    }
    if (!kinds || kinds.length > 0) {
      const c = cursorFor("CH-", before); // change log ids are "CH-<uuid>"
      const page = queryChanges({ kinds, q: q ?? undefined, before: c ? `${c.ts}|CH-${c.id}` : undefined, limit: limit + 1 });
      lists.push(page.rows.map((r) => changeToItem(r, opts.showMoney)));
    }
  }
  if (!area || area === "goodshuffle") lists.push(writeBackRows({ q, before, who, limit }).map((r) => describeWriteBack(r, opts.showMoney)));
  if ((!area || area === "ai") && who !== "platform") lists.push(approvalRows({ q, before, limit }).map((r) => describeApproval(r, opts.showMoney)));
  const actions = Object.entries(AUDIT_RULES)
    .filter(([, r]) => (!area || r.area === area) && (!who || r.who === who))
    .map(([k]) => k);
  lists.push(
    auditRows({ actions, q, before, limit })
      .map(describeAudit)
      .filter((x): x is FeedItem => x !== null),
  );

  return mergePage(lists, limit, before);
}

/** Goodshuffle write-backs for one event (its transactionID), for the per-event timeline. */
export function eventWriteBacks(eventId: string, showMoney: boolean): FeedItem[] {
  return writeBackRows({ q: null, before: null, who: null, limit: 200, eventId }).map((r) => describeWriteBack(r, showMoney));
}

/** "by Jessie" · "by someone on Dispatch" · "by the platform". */
export function byLabel(b: FeedBy): string {
  if (b.who === "platform") return "by the platform";
  if (b.name) return `by ${b.name}`;
  return b.where ? `by someone on ${b.where}` : "by someone";
}

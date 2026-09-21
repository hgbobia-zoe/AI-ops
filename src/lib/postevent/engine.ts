// Post-Event Customer Experience — the deterministic engine. RULES CALCULATE. This computes eligibility
// ("completed event + pickup completed"), keeps every project in a known state, AUTO-populates contact
// attempts from real comms, advances the mechanical early states from facts only, derives the next action,
// and assembles the board. It never fabricates a contact, a review, sentiment or a metric.
//
// Eligibility (verified against the real schema):
//   • "event completed"  = an event_outcomes row exists (written when a dispatch route is CLOSED).
//   • "pickup completed" = a stop with kind='pickup' for that event reached a terminal state
//     (Completed/Returned). If the event has NO pickup stop (delivery-only / pickup not separately
//     tracked), we fall back to the route being fully completed (event_outcomes.all_completed = 1).
//   • Anchor time (pickup_at) = the pickup stop's completed_at when known, else the route close time.

import { getDb } from "@/lib/db/index";
import { getCommsForLead } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";
import {
  ensureProject,
  listProjects,
  addAutoContact,
  setState,
  setNextAction,
  openIssueCounts,
  getProject,
  getConfig,
  getTransitions,
  listContacts,
  listReviews,
  listIssues,
} from "./store";
import {
  type PostEventProject,
  type PostEventState,
  type PostEventCard,
  type BoardColumns,
  type NextAction,
  type Disposition,
  type ContactChannel,
  type ContactOutcome,
  POSTEVENT_STATE_ORDER,
  POSTEVENT_STATE_LABEL,
  CONTACT_CHANNEL_LABEL,
  CONTACT_OUTCOME_LABEL,
  isPositiveDisposition,
  isIssueDisposition,
} from "./types";

const STATE_LABEL: Record<string, string> = POSTEVENT_STATE_LABEL;
const CHANNEL_LABEL = CONTACT_CHANNEL_LABEL;
const OUTCOME_LABEL = CONTACT_OUTCOME_LABEL;

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Booking facts (referenced, not owned) ───────────────────────────────────────────────────────────
interface BookingFacts {
  eventName: string;
  customer: string;
  venue: string | null;
  eventDate: string | null;
  status: string;
}
function bookingFactsFor(ids: string[]): Map<string, BookingFacts> {
  const out = new Map<string, BookingFacts>();
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT booking_id, event_name, client_name, venue, event_date, status_label FROM bookings WHERE booking_id IN (${ph})`)
    .all(...ids) as any[];
  for (const r of rows)
    out.set(String(r.booking_id), {
      eventName: String(r.event_name ?? ""),
      customer: String(r.client_name ?? ""),
      venue: (r.venue as string) ?? null,
      eventDate: (r.event_date as string) ?? null,
      status: String(r.status_label ?? "").toLowerCase(),
    });
  return out;
}

// ── Eligibility ─────────────────────────────────────────────────────────────────────────────────────
export interface EligibleEvent {
  bookingId: string;
  eventDate: string | null;
  pickupAt: string;
}

/** Completed events (closed routes) whose pickup is completed, aggregated per event id. */
export function computeEligible(): EligibleEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT eo.event_id AS event_id,
              MIN(eo.date) AS date,
              MAX(eo.closed_at) AS closed_at,
              MAX(eo.all_completed) AS any_all_completed,
              (SELECT MAX(s.completed_at) FROM stops s JOIN routes r ON s.route_id = r.route_id
                 WHERE s.tx_id = eo.event_id AND s.kind = 'pickup' AND s.state IN ('Completed','Returned')) AS pickup_completed_at,
              (SELECT COUNT(*) FROM stops s2 JOIN routes r2 ON s2.route_id = r2.route_id
                 WHERE s2.tx_id = eo.event_id AND s2.kind = 'pickup') AS pickup_stop_count
         FROM event_outcomes eo
        GROUP BY eo.event_id`,
    )
    .all() as any[];

  const out: EligibleEvent[] = [];
  for (const r of rows) {
    const pickupCompletedAt = r.pickup_completed_at as string | null;
    const pickupStopCount = Number(r.pickup_stop_count ?? 0);
    const anyAllCompleted = Number(r.any_all_completed ?? 0) === 1;
    let pickupAt: string | null = null;
    if (pickupCompletedAt) pickupAt = pickupCompletedAt;
    else if (pickupStopCount === 0 && anyAllCompleted) pickupAt = (r.closed_at as string) ?? null;
    if (!pickupAt) continue; // pickup exists but not completed → not yet eligible
    out.push({ bookingId: String(r.event_id), eventDate: (r.date as string) ?? null, pickupAt });
  }
  return out;
}

// ── Next action (deterministic, per state + disposition + open issues) ───────────────────────────────
export function deriveNextAction(state: PostEventState, disposition: Disposition | null, openIssues: number): NextAction {
  switch (state) {
    case "needs_follow_up":
      return "call";
    case "follow_up_in_progress":
      return "await_response";
    case "customer_responded":
      return "review_feedback";
    case "experience_confirmed":
      if (isPositiveDisposition(disposition)) return "send_review_request";
      if (isIssueDisposition(disposition)) return openIssues > 0 ? "follow_resolution" : "escalate";
      if (disposition === "mixed_neutral") return "follow_resolution";
      if (disposition === "unable") return "close";
      return "review_feedback"; // confirmed but no disposition set yet
    case "review_requested":
      return "await_response";
    case "review_completed":
      return "close";
    case "closed":
      return "none";
  }
}

// ── Sync (idempotent; safe to run on every board/overview load) ──────────────────────────────────────
export interface SyncResult {
  newlyEligible: number;
  autoContacts: number;
  autoAdvanced: number;
}

const EARLY_STATES: PostEventState[] = ["needs_follow_up", "follow_up_in_progress", "customer_responded"];

export function syncPostEvent(): SyncResult {
  const result: SyncResult = { newlyEligible: 0, autoContacts: 0, autoAdvanced: 0 };

  // 1) Create workflow rows for newly-eligible events (skip cancelled bookings).
  const eligible = computeEligible();
  const facts = bookingFactsFor(eligible.map((e) => e.bookingId));
  for (const e of eligible) {
    const f = facts.get(e.bookingId);
    if (f && /cancel|lost|dead/.test(f.status)) continue; // cancelled/lost → not a post-event candidate
    const eventDate = f?.eventDate ?? e.eventDate;
    if (ensureProject({ bookingId: e.bookingId, eventDate, pickupAt: e.pickupAt })) result.newlyEligible++;
  }

  // 2) For every non-closed project: auto-populate contacts from comms, advance early states from facts,
  //    recompute the next action.
  const openIssues = openIssueCounts();
  for (const p of listProjects()) {
    if (p.state === "closed") continue;

    // Auto-populate contact attempts from real comms that happened AFTER the pickup (post-event only).
    const comms = getCommsForLead(p.bookingId, 60);
    let hasOutbound = false;
    let hasInbound = false;
    for (const c of comms) {
      const at = c.occurredAt ?? c.ts;
      if (p.pickupAt && at < p.pickupAt) continue; // pre-event comms are not post-event contacts
      const channel: ContactChannel = c.channel === "sms" ? "sms" : c.channel === "call" ? "phone" : "other";
      const direction = c.direction === "inbound" ? "inbound" : "outbound";
      const outcome: ContactOutcome = direction === "inbound" ? "customer_responded" : "other";
      if (direction === "inbound") hasInbound = true;
      else hasOutbound = true;
      if (
        addAutoContact({
          bookingId: p.bookingId,
          occurredAt: at,
          channel,
          employee: direction === "outbound" ? c.actor ?? null : null,
          outcome,
          direction,
          notes: (c.body ?? "").slice(0, 200),
          dedupeKey: `comms:${c.providerId || c.id}`,
        })
      )
        result.autoContacts++;
    }

    // Advance the mechanical early states from FACTS only (forward-only; never past customer_responded).
    let state = p.state;
    if (state === "needs_follow_up" && hasOutbound) {
      setState(p.bookingId, "follow_up_in_progress", "system", "Outbound contact detected");
      state = "follow_up_in_progress";
      result.autoAdvanced++;
    }
    if (EARLY_STATES.includes(state) && state !== "customer_responded" && hasInbound) {
      setState(p.bookingId, "customer_responded", "system", "Customer response detected");
      state = "customer_responded";
      result.autoAdvanced++;
    }

    // Recompute + cache the next action.
    const fresh = getProject(p.bookingId)!;
    const next = deriveNextAction(fresh.state, fresh.disposition, openIssues.get(p.bookingId) ?? 0);
    if (fresh.nextAction !== next) setNextAction(p.bookingId, next);
  }

  return result;
}

// ── Per-project derived stats (batched) ──────────────────────────────────────────────────────────────
interface ContactStat {
  count: number;
  responded: number;
  lastAt: string | null;
}
function contactStats(): Map<string, ContactStat> {
  const rows = getDb()
    .prepare(
      `SELECT booking_id,
              COUNT(*) AS n,
              SUM(CASE WHEN direction='inbound' OR outcome IN ('customer_responded','requested_callback','positive','issue_reported') THEN 1 ELSE 0 END) AS responded,
              MAX(occurred_at) AS last_at
         FROM postevent_contacts GROUP BY booking_id`,
    )
    .all() as any[];
  const m = new Map<string, ContactStat>();
  for (const r of rows) m.set(String(r.booking_id), { count: Number(r.n ?? 0), responded: Number(r.responded ?? 0), lastAt: (r.last_at as string) ?? null });
  return m;
}

function daysSince(iso: string | null, today: string): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  const nowMs = new Date(`${today}T23:59:59Z`).getTime();
  return Math.max(0, Math.floor((nowMs - then) / 86400000));
}

function toCard(p: PostEventProject, facts: Map<string, BookingFacts>, stats: Map<string, ContactStat>, issues: Map<string, number>, slaDays: Record<PostEventState, number>, today: string): PostEventCard {
  const f = facts.get(p.bookingId);
  const st = stats.get(p.bookingId) ?? { count: 0, responded: 0, lastAt: null };
  const daysInStage = daysSince(p.stageEnteredAt, today);
  const sla = slaDays[p.state] ?? 0;
  return {
    bookingId: p.bookingId,
    state: p.state,
    disposition: p.disposition,
    nextAction: p.nextAction,
    assignedEmployee: p.assignedEmployee,
    customer: f?.customer || "Unknown customer",
    eventName: f?.eventName || `Project ${p.bookingId}`,
    eventDate: p.eventDate ?? f?.eventDate ?? null,
    venue: f?.venue ?? null,
    pickupAt: p.pickupAt,
    lastContactAt: st.lastAt,
    contactCount: st.count,
    respondedCount: st.responded,
    openIssues: issues.get(p.bookingId) ?? 0,
    daysInStage,
    stale: sla > 0 && daysInStage > sla && p.state !== "closed",
  };
}

// ── Board ─────────────────────────────────────────────────────────────────────────────────────────────
export interface BoardData {
  columns: BoardColumns;
  totals: Record<PostEventState, number>;
}

/** Build the Kanban. Runs a sync first so eligibility + auto-contacts are current. Closed cards are
 *  limited to the most recent so the terminal column doesn't grow without bound. */
export function buildBoard(closedLimit = 40): BoardData {
  syncPostEvent();
  const today = todayInOpsTz();
  const cfg = getConfig();
  const projects = listProjects();
  const facts = bookingFactsFor(projects.map((p) => p.bookingId));
  const stats = contactStats();
  const issues = openIssueCounts();

  const columns = Object.fromEntries(POSTEVENT_STATE_ORDER.map((s) => [s, [] as PostEventCard[]])) as BoardColumns;
  const totals = Object.fromEntries(POSTEVENT_STATE_ORDER.map((s) => [s, 0])) as Record<PostEventState, number>;

  for (const p of projects) {
    columns[p.state].push(toCard(p, facts, stats, issues, cfg.slaDays, today));
    totals[p.state]++;
  }
  // Sort active columns by urgency (stale first, then oldest-in-stage). Closed by most-recently closed.
  for (const s of POSTEVENT_STATE_ORDER) {
    if (s === "closed") {
      columns[s].sort((a, b) => (b.pickupAt ?? "").localeCompare(a.pickupAt ?? ""));
      columns[s] = columns[s].slice(0, closedLimit);
    } else {
      columns[s].sort((a, b) => Number(b.stale) - Number(a.stale) || b.daysInStage - a.daysInStage);
    }
  }
  return { columns, totals };
}

// ── Project detail (workflow row + Goodshuffle facts + timeline pieces) ───────────────────────────────
export interface ProjectDetailFacts {
  bookingId: string;
  eventName: string;
  customer: string;
  venue: string | null;
  eventDate: string | null;
  status: string;
}
export function projectFacts(bookingId: string): ProjectDetailFacts {
  const f = bookingFactsFor([bookingId]).get(bookingId);
  return {
    bookingId,
    eventName: f?.eventName || `Project ${bookingId}`,
    customer: f?.customer || "Unknown customer",
    venue: f?.venue ?? null,
    eventDate: f?.eventDate ?? null,
    status: f?.status ?? "",
  };
}

/** Reconstruct the whole journey as an ordered timeline for the project detail: pickup, follow-up
 *  attempts, conversation, experience, issue/resolution, review request, review, closure. Assembled
 *  deterministically from the real records — nothing is invented. */
export interface TimelineEntry {
  ts: string;
  kind: "pickup" | "transition" | "contact" | "review_requested" | "review_received" | "issue";
  title: string;
  detail: string;
  actor: string | null;
}

export function buildTimeline(bookingId: string): TimelineEntry[] {
  const p = getProject(bookingId);
  if (!p) return [];
  const entries: TimelineEntry[] = [];

  if (p.pickupAt) entries.push({ ts: p.pickupAt, kind: "pickup", title: "Pickup completed", detail: "Event and pickup completed; eligible for follow-up.", actor: null });

  for (const t of getTransitions(bookingId)) {
    entries.push({
      ts: t.ts,
      kind: "transition",
      title: `${STATE_LABEL[t.fromState ?? ""] ?? "Start"} → ${STATE_LABEL[t.toState] ?? t.toState}`,
      detail: t.note ?? "",
      actor: t.actor,
    });
  }
  for (const c of listContacts(bookingId)) {
    entries.push({
      ts: c.occurredAt,
      kind: "contact",
      title: `${CHANNEL_LABEL[c.channel] ?? c.channel} (${c.direction ?? "outbound"}): ${OUTCOME_LABEL[c.outcome] ?? c.outcome}`,
      detail: c.notes || "",
      actor: c.employee,
    });
  }
  for (const r of listReviews(bookingId)) {
    if (r.kind === "requested")
      entries.push({ ts: r.occurredAt, kind: "review_requested", title: `Review requested${r.channel ? ` via ${r.channel}` : ""}`, detail: r.destination ? `Destination: ${r.destination}` : "", actor: r.employee });
    else entries.push({ ts: r.occurredAt, kind: "review_received", title: `Review received${r.rating ? ` (${r.rating} of 5)` : ""}`, detail: r.link || "", actor: r.employee });
  }
  for (const i of listIssues(bookingId)) {
    entries.push({ ts: i.createdAt, kind: "issue", title: `Issue: ${i.issueType ?? "other"} (${i.state})`, detail: i.description || "", actor: i.assignedEmployee });
  }

  return entries.sort((a, b) => a.ts.localeCompare(b.ts));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

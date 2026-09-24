// Persistence for the NEW Communications tables only — the immutable communication event log and the
// human reason-overrides — plus a couple of read helpers over EXISTING tables (dispatch stops,
// post-event issues) that the Context Engine needs. Everything customer/event/order/call already has a
// home (bookings, call_events, comms_events, risk_items); this module never duplicates those.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { CallReason } from "./reasons";
import type { ContextLogistics, LogisticsAvailability, IdentityMatch } from "./types";

// ── Immutable communication event log (append-only) ───────────────────────────────────────────────
// One row per canonical event in a conversation (call.started, transcript.available, sms.received, …).
// Rows are NEVER updated or deleted — this is the audit/debug/analytics spine. Idempotent on the
// provider's event id so a retried webhook doesn't double-append.

export interface CommsLogInput {
  conversationId: string;
  providerEventId?: string | null;
  source: "quo" | "sona" | "system" | "manual";
  channel?: string | null;
  eventType: string; // canonical type from the adapter
  direction?: "inbound" | "outbound" | null;
  fromPhone?: string | null;
  toPhone?: string | null;
  occurredAt?: string | null;
  payload?: unknown;
}

export interface CommsLogRow {
  id: string;
  conversationId: string;
  providerEventId: string | null;
  source: string;
  channel: string | null;
  eventType: string;
  direction: string | null;
  fromPhone: string | null;
  toPhone: string | null;
  occurredAt: string | null;
  payload: unknown;
  ts: string;
}

function toLogRow(r: Record<string, unknown>): CommsLogRow {
  let payload: unknown = null;
  try {
    payload = r.payload ? JSON.parse(String(r.payload)) : null;
  } catch {
    payload = null;
  }
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    providerEventId: (r.provider_event_id as string) ?? null,
    source: String(r.source),
    channel: (r.channel as string) ?? null,
    eventType: String(r.event_type),
    direction: (r.direction as string) ?? null,
    fromPhone: (r.from_phone as string) ?? null,
    toPhone: (r.to_phone as string) ?? null,
    occurredAt: (r.occurred_at as string) ?? null,
    payload,
    ts: String(r.ts),
  };
}

/** Append one canonical event to the immutable log. Idempotent on provider_event_id; returns the row
 *  id, or null when the event was already logged (a provider retry). */
export function appendCommsLog(e: CommsLogInput): string | null {
  const id = `CL-${randomUUID()}`;
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO comms_log (id, conversation_id, provider_event_id, source, channel,
        event_type, direction, from_phone, to_phone, occurred_at, payload, ts)
       VALUES (@id,@conversationId,@providerEventId,@source,@channel,@eventType,@direction,
        @fromPhone,@toPhone,@occurredAt,@payload,@ts)`,
    )
    .run({
      id,
      conversationId: e.conversationId,
      providerEventId: e.providerEventId ?? `${e.conversationId}:${e.eventType}:${Date.now()}`,
      source: e.source,
      channel: e.channel ?? null,
      eventType: e.eventType,
      direction: e.direction ?? null,
      fromPhone: e.fromPhone ?? null,
      toPhone: e.toPhone ?? null,
      occurredAt: e.occurredAt ?? null,
      payload: e.payload == null ? null : JSON.stringify(e.payload),
      ts: new Date().toISOString(),
    });
  return info.changes > 0 ? id : null;
}

/** The full append-only stream for one conversation, oldest-first (the natural narrative order). */
export function getConversationLog(conversationId: string, limit = 200): CommsLogRow[] {
  return (
    getDb()
      .prepare("SELECT * FROM comms_log WHERE conversation_id = ? ORDER BY COALESCE(occurred_at, ts) ASC LIMIT ?")
      .all(conversationId, limit) as Record<string, unknown>[]
  ).map(toLogRow);
}

/** Most-recent events across all conversations (integration-health "last event" + debug view). */
export function getRecentCommsLog(limit = 50): CommsLogRow[] {
  return (
    getDb().prepare("SELECT * FROM comms_log ORDER BY ts DESC LIMIT ?").all(limit) as Record<string, unknown>[]
  ).map(toLogRow);
}

// ── Human reason overrides (reversible) ───────────────────────────────────────────────────────────
// The reason is CALCULATED deterministically at read time (never stale). A human can override it; that
// override is the only thing persisted, and it can be cleared to fall back to the calculated value.

export function getReasonOverride(callId: string): { reason: CallReason; actor: string | null; ts: string } | null {
  const r = getDb().prepare("SELECT reason, actor, ts FROM comms_reason_overrides WHERE call_id = ?").get(callId) as
    | { reason: string; actor: string | null; ts: string }
    | undefined;
  return r ? { reason: r.reason as CallReason, actor: r.actor ?? null, ts: r.ts } : null;
}

export function getAllReasonOverrides(): Map<string, CallReason> {
  const out = new Map<string, CallReason>();
  for (const r of getDb().prepare("SELECT call_id, reason FROM comms_reason_overrides").all() as { call_id: string; reason: string }[]) {
    out.set(r.call_id, r.reason as CallReason);
  }
  return out;
}

export function setReasonOverride(callId: string, reason: CallReason, actor: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO comms_reason_overrides (call_id, reason, actor, ts)
       VALUES (@callId,@reason,@actor,@ts)
       ON CONFLICT(call_id) DO UPDATE SET reason=@reason, actor=@actor, ts=@ts`,
    )
    .run({ callId, reason, actor, ts: new Date().toISOString() });
}

export function clearReasonOverride(callId: string): void {
  getDb().prepare("DELETE FROM comms_reason_overrides WHERE call_id = ?").run(callId);
}

// ── Read helpers over EXISTING dispatch + post-event tables (for the Context Engine) ──────────────

const digitsOf = (p: string | null | undefined): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

interface StopRow {
  route_id: string | null;
  kind: string | null;
  state: string | null;
  planned_window: string | null;
  eta: string | null;
  address: string | null;
  completed_at: string | null;
  arrived_at: string | null;
}

function stopToLogistics(r: StopRow | undefined): ContextLogistics {
  if (!r) return { availability: "UNAVAILABLE", window: null, eta: null, state: null, address: null, routeId: null };
  let availability: LogisticsAvailability = "SCHEDULED";
  if (r.completed_at) availability = "COMPLETE";
  else if (r.arrived_at || (r.state && /progress|arriv|en_?route|heading/i.test(r.state))) availability = "IN_PROGRESS";
  return {
    availability,
    window: r.planned_window ?? null,
    eta: r.eta ?? null,
    state: r.state ?? null,
    address: r.address ?? null,
    routeId: r.route_id ?? null,
  };
}

/** Best-effort delivery + pickup status for a caller, matched from the dispatch layer by phone (the
 *  stop's customer or day-of number). Returns UNAVAILABLE blocks when no matching stop exists — we
 *  never claim a delivery window we don't actually have on a route. */
export function getLogisticsByPhone(phone: string | null): { delivery: ContextLogistics; pickup: ContextLogistics } {
  const d10 = digitsOf(phone);
  if (!d10) return { delivery: stopToLogistics(undefined), pickup: stopToLogistics(undefined) };
  const like = `%${d10}`;
  const norm = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(%COL%,''),'(',''),')',''),'-',''),' ',''),'+',''),'.','')";
  const clause = `(${norm.replace("%COL%", "cust_phone")} LIKE ? OR ${norm.replace("%COL%", "day_of_phone")} LIKE ?)`;
  const pick = (kind: "delivery" | "pickup"): StopRow | undefined =>
    getDb()
      .prepare(
        `SELECT route_id, kind, state, planned_window, eta, address, completed_at, arrived_at
           FROM stops
          WHERE ${clause} AND LOWER(COALESCE(kind,'')) = ?
          ORDER BY COALESCE(completed_at, arrived_at, '') DESC LIMIT 1`,
      )
      .get(like, like, kind) as StopRow | undefined;
  return { delivery: stopToLogistics(pick("delivery")), pickup: stopToLogistics(pick("pickup")) };
}

/** Every booking whose stored phone matches these 10 digits — the basis for identity confidence
 *  (0 = UNKNOWN, 1 = CONFIRMED, ≥2 = MULTIPLE_MATCHES). Light fields only; the full record is fetched
 *  by id once a single customer is confirmed. Open leads first, then most recent event. */
export function findIdentityMatchesByPhone(digits10: string): IdentityMatch[] {
  if (!/^\d{10}$/.test(digits10)) return [];
  const norm =
    "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(client_phone,''),'(',''),')',''),'-',''),' ',''),'+',''),'.','')";
  const rows = getDb()
    .prepare(
      `SELECT booking_id, client_name, client_email, client_phone, event_date, status_label, signed
         FROM bookings
        WHERE ${norm} LIKE '%' || ?
        ORDER BY (signed = 0) DESC, COALESCE(event_date,'') DESC
        LIMIT 25`,
    )
    .all(digits10) as {
    booking_id: string;
    client_name: string | null;
    client_email: string | null;
    client_phone: string | null;
    event_date: string | null;
    status_label: string | null;
    signed: number | null;
  }[];
  return rows.map((r) => ({
    bookingId: String(r.booking_id),
    name: (r.client_name ?? "").trim() || "Unnamed customer",
    email: r.client_email ?? null,
    phone: r.client_phone ?? null,
    eventDate: r.event_date ?? null,
    status: r.status_label ?? "",
    signed: Number(r.signed ?? 0) === 1,
  }));
}

/** Recent SMS from the unified timeline (both directions), for the Communications queue. Calls live in
 *  call_events; this surfaces the text side of the same conversation feed. */
export function getRecentSmsEvents(limit = 60): {
  id: string;
  providerId: string;
  leadId: string | null;
  direction: "inbound" | "outbound";
  fromPhone: string | null;
  toPhone: string | null;
  body: string | null;
  actor: string | null;
  occurredAt: string | null;
  ts: string;
}[] {
  return (
    getDb()
      .prepare("SELECT * FROM comms_events WHERE channel = 'sms' ORDER BY COALESCE(occurred_at, ts) DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[]
  ).map((r) => ({
    id: String(r.id),
    providerId: String(r.provider_id ?? ""),
    leadId: (r.lead_id as string) ?? null,
    direction: (r.direction as "inbound" | "outbound") ?? "inbound",
    fromPhone: (r.from_phone as string) ?? null,
    toPhone: (r.to_phone as string) ?? null,
    body: (r.body as string) ?? null,
    actor: (r.actor as string) ?? null,
    occurredAt: (r.occurred_at as string) ?? null,
    ts: String(r.ts),
  }));
}

/** Open post-event service-recovery issues for a booking — real "open items" for the context panel. */
export function getOpenIssuesForBooking(bookingId: string): { label: string; detail: string | null }[] {
  const rows = getDb()
    .prepare("SELECT issue_type, description, state FROM postevent_issues WHERE booking_id = ? AND state <> 'closed' ORDER BY created_at DESC")
    .all(bookingId) as { issue_type: string | null; description: string | null; state: string }[];
  return rows.map((r) => ({
    label: `${(r.issue_type ?? "issue").replace(/_/g, " ")} · ${r.state.replace(/_/g, " ")}`,
    detail: r.description ?? null,
  }));
}

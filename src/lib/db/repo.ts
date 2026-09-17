// Typed data access over the SQLite DB. All server-side reads/writes for routes,
// stops, events, messages, exceptions, audit, and tracking links go through here.

import { randomUUID } from "node:crypto";
import { getDb } from "./index";
import { logChange } from "@/lib/history/store";
import type { Route, RouteStatus, Stop, StopState } from "@/lib/types";
import type { CallRecap } from "@/lib/coach/recap";
import { computeCallMetrics } from "@/lib/coach/metrics";

interface StopRow {
  stop_id: string;
  route_id: string;
  customer_id: string | null;
  sequence: number;
  state: string;
  cust_name: string | null;
  cust_first_name: string | null;
  cust_last_name: string | null;
  kind: string | null;
  cust_phone: string | null;
  address: string | null;
  day_of_name: string | null;
  day_of_phone: string | null;
  planned_window: string | null;
  eta: string | null;
  items: string | null;
  tx_id: string | null;
  contact_id: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  tracking_token: string | null;
  photos_ref: string | null;
  signature_ref: string | null;
}

interface RouteRow {
  route_id: string;
  truck_id: string;
  date: string;
  driver_id: string | null;
  driver_name: string | null;
  status: string;
  gs_route_id: string | null;
  updated_at: string;
}

function toStop(r: StopRow): Stop {
  return {
    stopId: r.stop_id,
    routeId: r.route_id,
    customerId: r.customer_id ?? "",
    sequence: r.sequence,
    state: r.state as StopState,
    custName: r.cust_name ?? "",
    custFirstName: r.cust_first_name ?? undefined,
    custLastName: r.cust_last_name ?? undefined,
    kind: r.kind === "pickup" ? "pickup" : r.kind === "delivery" ? "delivery" : undefined,
    custPhone: r.cust_phone ?? "",
    address: r.address ?? "",
    dayOfName: r.day_of_name ?? undefined,
    dayOfPhone: r.day_of_phone ?? undefined,
    plannedWindow: r.planned_window ?? undefined,
    eta: r.eta ?? undefined,
    items: r.items ? (safeJson(r.items) as Stop["items"]) : undefined,
    txId: r.tx_id ?? undefined,
    contactId: r.contact_id ?? undefined,
    arrivedAt: r.arrived_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
    trackingLinkId: r.tracking_token ?? undefined,
    photoIds: r.photos_ref ? (safeJson(r.photos_ref) as string[]) : undefined,
    signatureId: r.signature_ref ?? undefined,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function buildRoute(row: RouteRow): Route {
  const stops = (
    getDb()
      .prepare("SELECT * FROM stops WHERE route_id = ? ORDER BY sequence")
      .all(row.route_id) as StopRow[]
  ).map(toStop);
  return {
    routeId: row.route_id,
    truckId: row.truck_id,
    date: row.date,
    driverId: row.driver_id ?? undefined,
    driverName: row.driver_name ?? undefined,
    status: row.status as RouteStatus,
    gsRouteId: row.gs_route_id ?? undefined,
    stops,
  };
}

/** The current route for a truck (latest), with its stops in order. */
export function getRoute(truckId: string): Route | null {
  const row = getDb()
    .prepare("SELECT * FROM routes WHERE truck_id = ? ORDER BY updated_at DESC LIMIT 1")
    .get(truckId) as RouteRow | undefined;
  return row ? buildRoute(row) : null;
}

/** A route by its id, with stops. */
export function getRouteById(routeId: string): Route | null {
  const row = getDb().prepare("SELECT * FROM routes WHERE route_id = ?").get(routeId) as RouteRow | undefined;
  return row ? buildRoute(row) : null;
}

/** A truck's route for a specific calendar day (YYYY-MM-DD), or null if none. */
export function getRouteForDate(truckId: string, date: string): Route | null {
  const row = getDb()
    .prepare("SELECT * FROM routes WHERE truck_id = ? AND date = ? ORDER BY updated_at DESC LIMIT 1")
    .get(truckId, date) as RouteRow | undefined;
  return row ? buildRoute(row) : null;
}

/** Distinct route dates, newest first — for the dispatch history picker. */
export function getRouteDates(): string[] {
  return (
    getDb().prepare("SELECT DISTINCT date FROM routes ORDER BY date DESC").all() as {
      date: string;
    }[]
  ).map((r) => r.date);
}

export function upsertRoute(r: {
  routeId: string;
  truckId: string;
  date: string;
  driverId?: string;
  driverName?: string;
  status: RouteStatus;
  gsRouteId?: string;
}): void {
  // driver_id/driver_name and gs_route_id are PRESERVED on re-pull (COALESCE) — a route pull
  // carries no driver, so it must not wipe the Dispatch-assigned driver.
  getDb()
    .prepare(
      `INSERT INTO routes (route_id, truck_id, date, driver_id, driver_name, status, gs_route_id, updated_at)
       VALUES (@routeId, @truckId, @date, @driverId, @driverName, @status, @gsRouteId, @now)
       ON CONFLICT(route_id) DO UPDATE SET
         truck_id=@truckId, date=@date, status=@status,
         driver_id=COALESCE(@driverId, driver_id),
         driver_name=COALESCE(@driverName, driver_name),
         gs_route_id=COALESCE(@gsRouteId, gs_route_id), updated_at=@now`,
    )
    .run({
      ...r,
      driverId: r.driverId ?? null,
      driverName: r.driverName ?? null,
      gsRouteId: r.gsRouteId ?? null,
      now: new Date().toISOString(),
    });
}

/** Assign (or clear) the driver on a route. Returns the PREVIOUS driver name so the caller can
 *  log the change (Operational History). */
export function setRouteDriver(
  routeId: string,
  driverId: string | null,
  driverName: string | null,
): { ok: boolean; previousName?: string } {
  const db = getDb();
  const prev = db.prepare("SELECT driver_name FROM routes WHERE route_id = ?").get(routeId) as
    | { driver_name: string | null }
    | undefined;
  const info = db
    .prepare("UPDATE routes SET driver_id = ?, driver_name = ?, updated_at = ? WHERE route_id = ?")
    .run(driverId, driverName, new Date().toISOString(), routeId);
  return { ok: info.changes > 0, previousName: prev?.driver_name ?? undefined };
}

export function setRouteStatus(routeId: string, status: RouteStatus): void {
  getDb()
    .prepare("UPDATE routes SET status = ?, updated_at = ? WHERE route_id = ?")
    .run(status, new Date().toISOString(), routeId);
}

/**
 * Force-close a truck's current route from the office. For when the driver couldn't
 * finish it on the tablet (dead battery, tablet down): sets the route status to "done"
 * so it drops off the active board and the tablet re-prompts to load today's route.
 * It does NOT fabricate stop completions — it preserves where the driver actually got to.
 */
export interface IncompleteStop {
  stopId: string;
  sequence: number;
  custName: string;
  state: StopState;
}

const TERMINAL: StopState[] = ["Completed", "Returned"];

export function closeRoute(routeId: string): {
  ok: boolean;
  routeId?: string;
  truckId?: string;
  already?: boolean;
  incomplete?: IncompleteStop[];
} {
  const row = getDb().prepare("SELECT * FROM routes WHERE route_id = ?").get(routeId) as RouteRow | undefined;
  if (!row) return { ok: false };
  const route = buildRoute(row);
  const incomplete: IncompleteStop[] = route.stops
    .filter((s) => !TERMINAL.includes(s.state))
    .map((s) => ({ stopId: s.stopId, sequence: s.sequence, custName: s.custName, state: s.state }));
  if (route.status === "done")
    return { ok: true, routeId, truckId: route.truckId, already: true, incomplete };
  setRouteStatus(routeId, "done");
  return { ok: true, routeId, truckId: route.truckId, incomplete };
}

/**
 * Reopen a route the office had closed (status "done") so its stops become actionable
 * again — to remove/adjust a stop after a Goodshuffle change. Restores it to "active" if a
 * stop was already worked, else "ready". No-op if the route isn't closed.
 */
export function reopenRoute(routeId: string): { ok: boolean; status?: RouteStatus } {
  const db = getDb();
  const row = db.prepare("SELECT status FROM routes WHERE route_id = ?").get(routeId) as
    | { status: string }
    | undefined;
  if (!row) return { ok: false };
  if (row.status !== "done") return { ok: true, status: row.status as RouteStatus };
  const stops = db.prepare("SELECT state FROM stops WHERE route_id = ?").all(routeId) as { state: string }[];
  const status: RouteStatus = stops.some((s) => s.state !== "Waiting") ? "active" : "ready";
  setRouteStatus(routeId, status);
  return { ok: true, status };
}

/** Every route that isn't closed yet (status != 'done'), oldest date first. For the route-health
 *  check: routes past their scheduled delivery date, or still carrying stops that aren't completed,
 *  that need the team's action. */
export function getOpenRoutes(): Route[] {
  const rows = getDb()
    .prepare("SELECT * FROM routes WHERE status != 'done' ORDER BY date ASC, truck_id")
    .all() as RouteRow[];
  return rows.map(buildRoute);
}

export interface UnfinishedStop {
  stopId: string;
  routeId: string;
  truckId: string;
  date: string;
  sequence: number;
  custName: string;
  address: string;
  state: StopState;
}

/**
 * Stops that need rescheduling: on a CLOSED route (status "done") but never finished
 * (not Completed/Returned) — e.g. the driver hit an issue and the route was closed with a
 * stop still open. Newest first. Powers the Event Risk "needs rescheduling" list.
 */
export function getUnfinishedStops(sinceDays = 14): UnfinishedStop[] {
  const cutoff = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString().slice(0, 10);
  const rows = getDb()
    .prepare(
      `SELECT s.stop_id, s.route_id, r.truck_id, r.date, s.sequence, s.cust_name, s.address, s.state
       FROM stops s JOIN routes r ON s.route_id = r.route_id
       WHERE r.status = 'done' AND s.state NOT IN ('Completed','Returned') AND r.date >= ?
       ORDER BY r.date DESC, r.truck_id, s.sequence`,
    )
    .all(cutoff) as Array<{
    stop_id: string;
    route_id: string;
    truck_id: string;
    date: string;
    sequence: number;
    cust_name: string | null;
    address: string | null;
    state: string;
  }>;
  return rows.map((r) => ({
    stopId: r.stop_id,
    routeId: r.route_id,
    truckId: r.truck_id,
    date: r.date,
    sequence: r.sequence,
    custName: r.cust_name ?? "",
    address: r.address ?? "",
    state: r.state as StopState,
  }));
}

/**
 * Remove a stop from a route (dispatch pruning a stop). Returns the removed stop's
 * customer name + its Goodshuffle transactionID and the route's Goodshuffle routeID so
 * the caller can also drive Goodshuffle to drop the waypoint (two-way sync). Resequences
 * the remaining stops so the board stays 1..N.
 */
export function removeStop(
  routeId: string,
  stopId: string,
): { ok: boolean; custName?: string; txId?: string; gsRouteId?: string } {
  const db = getDb();
  const stop = db
    .prepare("SELECT cust_name, tx_id FROM stops WHERE stop_id = ? AND route_id = ?")
    .get(stopId, routeId) as { cust_name: string | null; tx_id: string | null } | undefined;
  if (!stop) return { ok: false };
  const route = db.prepare("SELECT gs_route_id FROM routes WHERE route_id = ?").get(routeId) as
    | { gs_route_id: string | null }
    | undefined;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM stops WHERE stop_id = ?").run(stopId);
    // resequence remaining stops 1..N by current order
    const remaining = db
      .prepare("SELECT stop_id FROM stops WHERE route_id = ? ORDER BY sequence")
      .all(routeId) as { stop_id: string }[];
    const upd = db.prepare("UPDATE stops SET sequence = ? WHERE stop_id = ?");
    remaining.forEach((r, i) => upd.run(i + 1, r.stop_id));
  });
  tx();
  return {
    ok: true,
    custName: stop.cust_name ?? undefined,
    txId: stop.tx_id ?? undefined,
    gsRouteId: route?.gs_route_id ?? undefined,
  };
}

// ── Event Risk Engine (MVP2) ─────────────────────────────────────────────────

export interface EventRow {
  eventId: string; // Goodshuffle transactionID
  date: string;
  label: string;
  routeId: string;
}

/** Distinct events (Goodshuffle projects) on the given dates, for readiness scoring. */
export function getEventsInRange(dates: string[]): EventRow[] {
  if (dates.length === 0) return [];
  const ph = dates.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT s.tx_id, r.date, r.route_id,
              COALESCE(NULLIF(TRIM(COALESCE(s.cust_first_name,'')||' '||COALESCE(s.cust_last_name,'')),''), s.cust_name) AS label
       FROM stops s JOIN routes r ON s.route_id = r.route_id
       WHERE s.tx_id IS NOT NULL AND r.status != 'done' AND r.date IN (${ph})
       GROUP BY s.tx_id, r.date`,
    )
    .all(...dates) as Array<{ tx_id: string; date: string; route_id: string; label: string | null }>;
  return rows.map((r) => ({ eventId: r.tx_id, date: r.date, routeId: r.route_id, label: r.label ?? "" }));
}

export interface ReadinessRecord {
  eventId: string;
  date: string;
  label: string;
  routeId?: string;
  score: number;
  riskLevel: string;
  components: {
    staffing: number;
    driver: number;
    warehouse: number;
    schedule: number;
    information: number;
    communication: number;
    payment: number;
    special: number;
  };
}

export interface ReadinessView {
  eventId: string;
  date: string;
  label: string;
  routeId?: string;
  score: number;
  riskLevel: string;
}

/** Readiness rows for display (soonest first). */
export function getEventReadiness(): ReadinessView[] {
  const rows = getDb()
    .prepare("SELECT event_id, date, label, route_id, score, risk_level FROM event_readiness ORDER BY date ASC")
    .all() as Array<{ event_id: string; date: string | null; label: string | null; route_id: string | null; score: number; risk_level: string | null }>;
  return rows.map((r) => ({
    eventId: r.event_id,
    date: r.date ?? "",
    label: r.label ?? "",
    routeId: r.route_id ?? undefined,
    score: r.score,
    riskLevel: r.risk_level ?? "READY",
  }));
}

// ── Financial Intelligence (MVP3) ────────────────────────────────────────────

export interface EventFinancialRecord {
  eventId: string;
  date: string;
  label?: string;
  routeId?: string;
  revenue: number | null;
  revenueStatus: string; // SIGNED | SCHEDULED | COLLECTED | UNAVAILABLE
  collected?: number | null;
}

/** Upsert an event's revenue (from Goodshuffle) — keyed by transactionID, no duplicates.
 *  The per-event payment fetch is best-effort, so a re-pull can arrive with `collected` null even
 *  though we previously knew the event was paid. NEVER downgrade: keep the prior collected amount
 *  (COALESCE) and re-derive COLLECTED from the effective collected, so a paid event can't flap back
 *  to unpaid on a transient payment-endpoint hiccup. */
export function saveEventRevenue(items: EventFinancialRecord[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const up = db.prepare(
    `INSERT INTO event_financials (event_id, date, label, route_id, revenue, revenue_status, collected, calculated_at)
     VALUES (@eventId,@date,@label,@routeId,@revenue,@revenueStatus,@collected,@now)
     ON CONFLICT(event_id) DO UPDATE SET date=@date, label=COALESCE(@label,label),
       route_id=COALESCE(@routeId,route_id), revenue=@revenue,
       collected=COALESCE(@collected, collected),
       revenue_status=CASE
         WHEN COALESCE(@collected, collected) IS NOT NULL AND COALESCE(@collected, collected) >= @revenue THEN 'COLLECTED'
         ELSE @revenueStatus END,
       calculated_at=@now`,
  );
  const tx = db.transaction(() => {
    for (const i of items)
      up.run({ eventId: i.eventId, date: i.date, label: i.label ?? null, routeId: i.routeId ?? null, revenue: i.revenue, revenueStatus: i.revenueStatus, collected: i.collected ?? null, now });
  });
  tx();
}

/** Signed revenue for events dated in [start,end]. revenue null when no priced events exist. */
export function getRevenueInRange(start: string, end: string): { revenue: number | null; events: number } {
  const row = getDb()
    .prepare("SELECT SUM(revenue) AS total, COUNT(revenue) AS n FROM event_financials WHERE date >= ? AND date <= ? AND revenue IS NOT NULL")
    .get(start, end) as { total: number | null; n: number };
  return { revenue: row.n > 0 ? row.total : null, events: row.n };
}

export interface EventFinancialView {
  eventId: string;
  date: string;
  label: string;
  revenue: number | null;
  revenueStatus: string;
}

/** Per-event financial rows for a period (for the profitability table). */
export function getEventFinancialsInRange(start: string, end: string): EventFinancialView[] {
  const rows = getDb()
    .prepare("SELECT event_id, date, label, revenue, revenue_status FROM event_financials WHERE date >= ? AND date <= ? ORDER BY date")
    .all(start, end) as Array<{ event_id: string; date: string | null; label: string | null; revenue: number | null; revenue_status: string | null }>;
  return rows.map((r) => ({ eventId: r.event_id, date: r.date ?? "", label: r.label ?? "", revenue: r.revenue, revenueStatus: r.revenue_status ?? "UNAVAILABLE" }));
}

// ── Sales & Customer Intelligence (MVP5/MVP6) ────────────────────────────────
// COUNT-based views only. $ pipeline and customer $ value need Goodshuffle revenue
// (event_financials), and stable customer identity needs the renter id — both are
// TODO captures. Until then these read real bookings by count/recency, never faked $.

export interface BookedEvent {
  eventId: string; // Goodshuffle transactionID (one row per event)
  date: string; // the event's earliest scheduled date on/after the cutoff
  label: string;
}

/** Distinct booked events whose earliest stop is on/after `startYmd`, soonest first.
 *  The forward booking pipeline by COUNT (the $ pipeline is separate — needs revenue). */
export function getBookedEventsFrom(startYmd: string): BookedEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT s.tx_id AS event_id, MIN(r.date) AS date,
              COALESCE(NULLIF(TRIM(COALESCE(s.cust_first_name,'')||' '||COALESCE(s.cust_last_name,'')),''), s.cust_name) AS label
       FROM stops s JOIN routes r ON s.route_id = r.route_id
       WHERE s.tx_id IS NOT NULL AND r.date >= ?
       GROUP BY s.tx_id
       ORDER BY date ASC`,
    )
    .all(startYmd) as Array<{ event_id: string; date: string; label: string | null }>;
  return rows.map((r) => ({ eventId: r.event_id, date: r.date, label: r.label ?? "" }));
}

export interface CustomerEventRow {
  eventId: string;
  name: string; // best available renter name (display + name-based fallback identity)
  date: string; // the event's earliest scheduled date
  contactId?: string; // Goodshuffle client contactID — stable identity when present
}

/** One row per event across ALL history, carrying the customer name + date + contactID. The
 *  service aggregates by contactID when present (stable), else by normalized name (approximate). */
export function getCustomerEvents(): CustomerEventRow[] {
  const rows = getDb()
    .prepare(
      `SELECT s.tx_id AS event_id, MIN(r.date) AS date, MAX(s.contact_id) AS contact_id,
              COALESCE(NULLIF(TRIM(COALESCE(s.cust_first_name,'')||' '||COALESCE(s.cust_last_name,'')),''), s.cust_name) AS name
       FROM stops s JOIN routes r ON s.route_id = r.route_id
       WHERE s.tx_id IS NOT NULL
       GROUP BY s.tx_id`,
    )
    .all() as Array<{ event_id: string; date: string; name: string | null; contact_id: string | null }>;
  return rows.map((r) => ({ eventId: r.event_id, date: r.date, name: (r.name ?? "").trim(), contactId: r.contact_id ?? undefined }));
}

/** Resolve an event's date/label/route from our stored stops, given its Goodshuffle transactionID.
 *  Lets the revenue ingest derive authoritative context instead of trusting the caller. */
export function getEventStub(txId: string): { date: string; label: string; routeId?: string } | null {
  const row = getDb()
    .prepare(
      `SELECT MIN(r.date) AS date, r.route_id,
              COALESCE(NULLIF(TRIM(COALESCE(s.cust_first_name,'')||' '||COALESCE(s.cust_last_name,'')),''), s.cust_name) AS label
       FROM stops s JOIN routes r ON s.route_id = r.route_id
       WHERE s.tx_id = ?`,
    )
    .get(txId) as { date: string | null; route_id: string | null; label: string | null } | undefined;
  if (!row || !row.date) return null;
  return { date: row.date, label: row.label ?? "", routeId: row.route_id ?? undefined };
}

// ── Bookings (Goodshuffle projects — the commercial pipeline) ────────────────

export interface BookingRecord {
  bookingId: string;
  eventName?: string;
  eventDate?: string | null; // YYYY-MM-DD
  statusLabel?: string;
  signed?: boolean;
  contractTotal?: number | null; // dollars
  grandTotal?: number | null; // dollars (revenue)
  amountPaid?: number | null;
  amountDue?: number | null;
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  quoteSentDate?: string | null; // YYYY-MM-DD
  dateCreated?: string | null; // YYYY-MM-DD
  venue?: string | null;
  location?: string | null; // city/state/zip/county string
}

export interface BookingView {
  bookingId: string;
  eventName: string;
  eventDate: string | null;
  statusLabel: string;
  signed: boolean;
  grandTotal: number | null;
  amountPaid: number | null;
  amountDue: number | null;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  quoteSentDate: string | null;
  dateCreated: string | null;
  lossReason: string | null;
  venue: string | null;
  location: string | null;
  internalNotes: string | null;
  clientNotes: string | null;
  lastSentDate: string | null;
  lineItems: string[] | null; // captured line-item titles (event-type signal); null = never captured
}

function parseLineItems(raw: unknown): string[] | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

function toBookingView(r: Record<string, unknown>): BookingView {
  return {
    bookingId: String(r.booking_id),
    eventName: String(r.event_name ?? ""),
    eventDate: (r.event_date as string) ?? null,
    statusLabel: String(r.status_label ?? ""),
    signed: Number(r.signed ?? 0) === 1,
    grandTotal: r.grand_total == null ? null : Number(r.grand_total),
    amountPaid: r.amount_paid == null ? null : Number(r.amount_paid),
    amountDue: r.amount_due == null ? null : Number(r.amount_due),
    clientName: String(r.client_name ?? ""),
    clientEmail: String(r.client_email ?? ""),
    clientPhone: String(r.client_phone ?? ""),
    quoteSentDate: (r.quote_sent_date as string) ?? null,
    dateCreated: (r.date_created as string) ?? null,
    lossReason: (r.loss_reason as string) ?? null,
    venue: (r.venue as string) ?? null,
    location: (r.location as string) ?? null,
    internalNotes: (r.internal_notes as string) ?? null,
    clientNotes: (r.client_notes as string) ?? null,
    lastSentDate: (r.last_sent_date as string) ?? null,
    lineItems: parseLineItems(r.line_items),
  };
}

export interface LeadNotesRecord {
  bookingId: string;
  internalNotes?: string | null;
  clientNotes?: string | null;
  lastSentDate?: string | null; // YYYY-MM-DD
  lineItems?: string[] | null; // captured line-item titles (event-type signal)
  quoteSentAt?: string | null; // ISO — precise quote-email send time
  quoteOpenedAt?: string | null; // ISO — latest client open of the quote email
}

/** Attach captured Goodshuffle notes (comms history) to existing bookings, keyed by project id. Only
 *  updates rows that already exist — notes ride on top of the projects pull. */
export function saveLeadNotes(items: LeadNotesRecord[]): number {
  const db = getDb();
  const now = new Date().toISOString();
  const up = db.prepare(
    `UPDATE bookings SET internal_notes=@internalNotes, client_notes=@clientNotes,
       last_sent_date=@lastSentDate,
       line_items=CASE WHEN @lineItemsProvided=1 THEN @lineItems ELSE line_items END,
       quote_sent_at=COALESCE(@quoteSentAt, quote_sent_at),
       quote_opened_at=COALESCE(@quoteOpenedAt, quote_opened_at),
       notes_updated_at=@now WHERE booking_id=@bookingId`,
  );
  let n = 0;
  const tx = db.transaction(() => {
    for (const i of items) {
      const provided = i.lineItems !== undefined;
      const r = up.run({
        bookingId: i.bookingId,
        internalNotes: i.internalNotes ?? null,
        clientNotes: i.clientNotes ?? null,
        lastSentDate: i.lastSentDate ?? null,
        lineItemsProvided: provided ? 1 : 0,
        lineItems: provided ? JSON.stringify(i.lineItems ?? []) : null,
        quoteSentAt: i.quoteSentAt ?? null,
        quoteOpenedAt: i.quoteOpenedAt ?? null,
        now,
      });
      n += r.changes;
    }
  });
  tx();
  return n;
}

/** A quote a client has opened that we may want to Slack about. Filters to opens that landed at least an
 *  hour after the quote was sent (so we don't ping while they're glancing at the just-sent confirmation),
 *  and that we haven't already alerted for (opened_at newer than the last alerted open). */
export interface QuoteOpenCandidate {
  bookingId: string;
  clientName: string | null;
  eventName: string | null;
  eventDate: string | null;
  location: string | null;
  quoteSentAt: string;
  quoteOpenedAt: string;
}
export function pendingQuoteOpenAlerts(): QuoteOpenCandidate[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT booking_id, client_name, event_name, event_date, location, quote_sent_at, quote_opened_at
         FROM bookings
        WHERE quote_opened_at IS NOT NULL AND quote_sent_at IS NOT NULL
          AND (quote_open_alerted_at IS NULL OR quote_opened_at > quote_open_alerted_at)
          AND (julianday(quote_opened_at) - julianday(quote_sent_at)) * 86400 >= 3600`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    bookingId: String(r.booking_id),
    clientName: (r.client_name as string) ?? null,
    eventName: (r.event_name as string) ?? null,
    eventDate: (r.event_date as string) ?? null,
    location: (r.location as string) ?? null,
    quoteSentAt: r.quote_sent_at as string,
    quoteOpenedAt: r.quote_opened_at as string,
  }));
}

/** Record that we've handled a quote-open at `openedAt` (whether we alerted or intentionally suppressed a
 *  stale one), so we never re-alert for the same open. */
export function markQuoteOpenAlerted(bookingId: string, openedAt: string): void {
  getDb().prepare(`UPDATE bookings SET quote_open_alerted_at=@openedAt WHERE booking_id=@bookingId`).run({ bookingId, openedAt });
}

/** Upsert bookings (from a searchProjects pull), keyed by Goodshuffle project id. Logs a
 *  financial-plan change to Operational History when an existing booking's revenue changes. */
export function saveBookings(items: BookingRecord[]): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Prior revenue + status per booking, for change detection (revenue change + cancellation).
  const prior = new Map<string, number | null>();
  const priorStatus = new Map<string, string>();
  const ids = items.map((i) => i.bookingId);
  if (ids.length > 0) {
    const ph = ids.map(() => "?").join(",");
    for (const r of db.prepare(`SELECT booking_id, grand_total, status_label FROM bookings WHERE booking_id IN (${ph})`).all(...ids) as {
      booking_id: string;
      grand_total: number | null;
      status_label: string | null;
    }[]) {
      prior.set(String(r.booking_id), r.grand_total == null ? null : Number(r.grand_total));
      priorStatus.set(String(r.booking_id), (r.status_label ?? "").toLowerCase());
    }
  }

  const up = db.prepare(
    `INSERT INTO bookings (booking_id, event_name, event_date, status_label, signed, contract_total,
       grand_total, amount_paid, amount_due, client_name, client_email, client_phone, quote_sent_date,
       date_created, venue, location, updated_at)
     VALUES (@bookingId,@eventName,@eventDate,@statusLabel,@signed,@contractTotal,@grandTotal,
       @amountPaid,@amountDue,@clientName,@clientEmail,@clientPhone,@quoteSentDate,@dateCreated,@venue,@location,@now)
     ON CONFLICT(booking_id) DO UPDATE SET event_name=@eventName, event_date=@eventDate,
       status_label=@statusLabel, signed=@signed, contract_total=@contractTotal, grand_total=@grandTotal,
       amount_paid=@amountPaid, amount_due=@amountDue, client_name=@clientName, client_email=@clientEmail,
       client_phone=@clientPhone, quote_sent_date=@quoteSentDate, date_created=@dateCreated,
       venue=@venue, location=@location, updated_at=@now`,
  );
  const tx = db.transaction(() => {
    for (const i of items)
      up.run({
        bookingId: i.bookingId,
        eventName: i.eventName ?? null,
        eventDate: i.eventDate ?? null,
        statusLabel: i.statusLabel ?? null,
        signed: i.signed ? 1 : 0,
        contractTotal: i.contractTotal ?? null,
        grandTotal: i.grandTotal ?? null,
        amountPaid: i.amountPaid ?? null,
        amountDue: i.amountDue ?? null,
        clientName: i.clientName ?? null,
        clientEmail: i.clientEmail ?? null,
        clientPhone: i.clientPhone ?? null,
        quoteSentDate: i.quoteSentDate ?? null,
        dateCreated: i.dateCreated ?? null,
        venue: i.venue ?? null,
        location: i.location ?? null,
        now,
      });
  });
  tx();

  // Log meaningful changes to Operational History.
  const isCancelled = (s: string): boolean => s.includes("cancel") || s.includes("lost") || s.includes("dead");
  for (const i of items) {
    const before = prior.get(i.bookingId);
    const after = i.grandTotal ?? null;
    // Revenue change (financial-plan change) on a known booking.
    if (before != null && after != null && before !== after) {
      logChange({
        source: "goodshuffle",
        entity: "financial",
        entityId: i.bookingId,
        eventId: i.bookingId,
        kind: "booking_value_changed",
        field: i.eventName,
        fromValue: String(before),
        toValue: String(after),
        changeKey: `bookingval|${i.bookingId}|${after}`,
      });
    }
    // Cancellation: a known booking flipped to a cancelled/lost status.
    const wasCancelled = priorStatus.has(i.bookingId) && isCancelled(priorStatus.get(i.bookingId)!);
    const nowCancelled = isCancelled((i.statusLabel ?? "").toLowerCase());
    if (priorStatus.has(i.bookingId) && !wasCancelled && nowCancelled) {
      logChange({
        source: "goodshuffle",
        entity: "event",
        entityId: i.bookingId,
        eventId: i.bookingId,
        kind: "booking_cancelled",
        field: i.eventName,
        toValue: i.statusLabel ?? "cancelled",
        changeKey: `cancelled|${i.bookingId}`,
      });
    }
  }
}

/** Booked events on/after `startYmd`, soonest first (the forward pipeline). Dated only. Excludes
 *  cancelled/lost — those aren't pipeline. Each row carries `signed` so the UI can split committed
 *  contracts from open quotes. */
export function getUpcomingBookings(startYmd: string): BookingView[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM bookings
         WHERE event_date IS NOT NULL AND event_date >= ?
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%cancel%'
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%lost%'
         ORDER BY event_date ASC`,
      )
      .all(startYmd) as Record<string, unknown>[]
  ).map(toBookingView);
}

/** Booked events in [start,end], soonest first, EXCLUDING cancelled/lost (the live pipeline).
 *  Ranged sibling of getUpcomingBookings — used for a full-year (or any-period) pipeline view. */
export function getPipelineBookingsInRange(start: string, end: string): BookingView[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM bookings
         WHERE event_date IS NOT NULL AND event_date >= ? AND event_date <= ?
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%cancel%'
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%lost%'
         ORDER BY event_date ASC`,
      )
      .all(start, end) as Record<string, unknown>[]
  ).map(toBookingView);
}

/** Distinct calendar years that have at least one non-cancelled/lost booking, ascending — for the
 *  Sales year navigator so we only offer years that actually hold data. */
export function getBookingYears(): number[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT CAST(substr(event_date,1,4) AS INTEGER) AS yr
         FROM bookings
        WHERE event_date IS NOT NULL AND length(event_date) >= 4
          AND LOWER(COALESCE(status_label,'')) NOT LIKE '%cancel%'
          AND LOWER(COALESCE(status_label,'')) NOT LIKE '%lost%'
        ORDER BY yr ASC`,
    )
    .all() as { yr: number }[];
  return rows.map((r) => r.yr).filter((y) => y > 1900);
}

export interface RevenueSplit {
  signed: number | null; // committed revenue — signed contracts only ($). null if none.
  signedCount: number;
  pipeline: number | null; // unsigned quotes ($) — potential, NOT revenue. null if none.
  pipelineCount: number;
}

/** Revenue for bookings dated in [start,end], split into SIGNED (committed) vs PIPELINE (unsigned
 *  quotes) — a quote is not revenue. Cancelled/lost bookings are excluded from both. Dollars. */
export function getBookingsRevenueInRange(start: string, end: string): RevenueSplit {
  const row = getDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN signed = 1 THEN grand_total ELSE 0 END) AS signed_total,
         COUNT(CASE WHEN signed = 1 THEN grand_total END) AS signed_n,
         SUM(CASE WHEN signed = 0 THEN grand_total ELSE 0 END) AS pipeline_total,
         COUNT(CASE WHEN signed = 0 THEN grand_total END) AS pipeline_n
       FROM bookings
       WHERE event_date >= ? AND event_date <= ? AND grand_total IS NOT NULL
         AND LOWER(COALESCE(status_label,'')) NOT LIKE '%cancel%'
         AND LOWER(COALESCE(status_label,'')) NOT LIKE '%lost%'
         AND LOWER(COALESCE(status_label,'')) NOT LIKE '%dead%'
         AND LOWER(COALESCE(status_label,'')) NOT LIKE '%archiv%'`,
    )
    .get(start, end) as { signed_total: number | null; signed_n: number; pipeline_total: number | null; pipeline_n: number };
  return {
    signed: row.signed_n > 0 ? row.signed_total : null,
    signedCount: row.signed_n,
    pipeline: row.pipeline_n > 0 ? row.pipeline_total : null,
    pipelineCount: row.pipeline_n,
  };
}

export interface PipelineBreakdown {
  signed: { count: number; value: number | null }; // committed contracts
  quote: { count: number; value: number | null }; // open quotes — action needed
  lost: { count: number; value: number | null }; // lost/cancelled
}

/** The real 3-way status split for upcoming bookings (event_date >= today): committed contracts vs
 *  open quotes vs lost/cancelled. Goodshuffle exposes only these status classes — NOT finer sales
 *  stages — so the command center shows this honest split, not fabricated pipeline stages. */
export function getPipelineBreakdown(today: string): PipelineBreakdown {
  const rows = getDb()
    .prepare(
      `SELECT
         CASE
           WHEN LOWER(COALESCE(status_label,'')) LIKE '%lost%'
             OR LOWER(COALESCE(status_label,'')) LIKE '%cancel%' THEN 'lost'
           WHEN signed = 1 THEN 'signed'
           ELSE 'quote'
         END AS cls,
         COUNT(*) AS n,
         SUM(grand_total) AS total,
         COUNT(grand_total) AS priced
       FROM bookings
       WHERE event_date IS NOT NULL AND event_date >= ?
       GROUP BY cls`,
    )
    .all(today) as { cls: string; n: number; total: number | null; priced: number }[];
  const out: PipelineBreakdown = {
    signed: { count: 0, value: null },
    quote: { count: 0, value: null },
    lost: { count: 0, value: null },
  };
  for (const r of rows) {
    const bucket = r.cls === "signed" ? out.signed : r.cls === "lost" ? out.lost : out.quote;
    bucket.count = r.n;
    bucket.value = r.priced > 0 ? r.total : null;
  }
  return out;
}

/** Per-booking rows dated in [start,end] (for the finance event table). */
export function getBookingsInRange(start: string, end: string): BookingView[] {
  // Exclude lost / cancelled / dead / archived — those are not revenue we're going to make.
  return (
    getDb()
      .prepare(
        `SELECT * FROM bookings
         WHERE event_date >= ? AND event_date <= ?
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%cancel%'
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%lost%'
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%dead%'
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%archiv%'
         ORDER BY event_date`,
      )
      .all(start, end) as Record<string, unknown>[]
  ).map(toBookingView);
}

/** Revenue ($ grand_total) by booking id, for a set of ids — the single revenue source of truth.
 *  Event tx_id === booking id (same Goodshuffle id space), so risk/history snapshots read revenue
 *  from here rather than the separate event_financials table (which diverged). */
export function getBookingRevenueByIds(ids: string[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(",");
  for (const r of getDb().prepare(`SELECT booking_id, grand_total FROM bookings WHERE booking_id IN (${ph})`).all(...ids) as {
    booking_id: string;
    grand_total: number | null;
  }[]) {
    out.set(String(r.booking_id), r.grand_total == null ? null : Number(r.grand_total));
  }
  return out;
}

/** All bookings (for Customer Intelligence aggregation). */
export function getAllBookings(): BookingView[] {
  return (getDb().prepare("SELECT * FROM bookings ORDER BY event_date").all() as Record<string, unknown>[]).map(toBookingView);
}

/** Open leads for the Sales OS — UNSIGNED, non-cancelled/lost bookings whose event is still ahead
 *  (or undated). These are the quotes a human still has to win. Soonest event first; undated last. */
export function getOpenLeads(todayYmd: string): BookingView[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM bookings
         WHERE signed = 0
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%cancel%'
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%lost%'
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%dead%'
           AND (event_date IS NULL OR event_date >= ?)
         ORDER BY COALESCE(event_date,'9999-12-31') ASC`,
      )
      .all(todayYmd) as Record<string, unknown>[]
  ).map(toBookingView);
}

/** Pipeline leads for the Sales OS table + board: everything not lost/cancelled with an upcoming (or
 *  undated) event — INCLUDING signed wins (so the board's Signed column + the table can show them).
 *  Newest-created first (matches the GSPRO Projects table default). */
export function getPipelineLeads(todayYmd: string): BookingView[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM bookings
         WHERE LOWER(COALESCE(status_label,'')) NOT LIKE '%cancel%'
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%lost%'
           AND LOWER(COALESCE(status_label,'')) NOT LIKE '%dead%'
           AND (event_date IS NULL OR event_date >= ?)
         ORDER BY COALESCE(date_created, event_date, '') DESC`,
      )
      .all(todayYmd) as Record<string, unknown>[]
  ).map(toBookingView);
}

/** Lost/cancelled quotes (the post-mortem set for the Lost Quotes tracker), most recent event first. */
export function getLostQuotes(): BookingView[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM bookings
         WHERE LOWER(COALESCE(status_label,'')) LIKE '%lost%'
            OR LOWER(COALESCE(status_label,'')) LIKE '%cancel%'
            OR LOWER(COALESCE(status_label,'')) LIKE '%dead%'
         ORDER BY COALESCE(event_date, date_created, '') DESC`,
      )
      .all() as Record<string, unknown>[]
  ).map(toBookingView);
}

/** Team-tag (or clear, with null) why a quote was lost. Goodshuffle stores no reason, so this is how
 *  the loss-reason dataset gets built. */
export function setLossReason(id: string, reason: string | null): void {
  getDb()
    .prepare("UPDATE bookings SET loss_reason = ?, loss_reason_at = ? WHERE booking_id = ?")
    .run(reason && reason.trim() ? reason.trim() : null, reason && reason.trim() ? new Date().toISOString() : null, id);
}

/** A single booking by Goodshuffle project id — for the Sales OS lead detail. */
export function getBookingById(id: string): BookingView | null {
  const r = getDb().prepare("SELECT * FROM bookings WHERE booking_id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? toBookingView(r) : null;
}

/** Best booking match for a phone number (last 10 digits), preferring an open lead then the most
 *  recent — so a call can be attached to the right project. Null if no booking has that number. */
export function getBookingByPhoneDigits(digits10: string): BookingView | null {
  if (!/^\d{10}$/.test(digits10)) return null;
  const r = getDb()
    .prepare(
      `SELECT * FROM bookings
       WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(client_phone,''),'(',''),')',''),'-',''),' ',''),'+',''),'.','') LIKE '%' || ?
       ORDER BY (signed = 0) DESC, COALESCE(event_date,'') DESC
       LIMIT 1`,
    )
    .get(digits10) as Record<string, unknown> | undefined;
  return r ? toBookingView(r) : null;
}

/** Row counts for the Data Health view — so "no freshness signal" isn't shown as "no data at all"
 *  when the tables actually hold (stale) rows from an earlier pull. */
export function getDataCounts(): { bookings: number; routes: number } {
  const db = getDb();
  return {
    bookings: (db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n,
    routes: (db.prepare("SELECT COUNT(*) AS n FROM routes").get() as { n: number }).n,
  };
}

// ── Direct cost entries + event-level economics ──────────────────────────────

/** Upsert cost entries, idempotent by source_ref (a re-scan re-derives the same driver-labor rows). */
export function saveCostEntries(items: import("@/lib/finance/allocation").CostEntryInput[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const up = db.prepare(
    `INSERT INTO cost_entries (id, type, class, event_id, route_id, day, amount, amount_status, hours, rate, source, source_ref, note, captured_at)
     VALUES (@id,@type,@klass,@eventId,@routeId,@day,@amount,@amountStatus,@hours,@rate,@source,@sourceRef,@note,@now)
     ON CONFLICT(source_ref) DO UPDATE SET amount=@amount, amount_status=@amountStatus, hours=@hours, rate=@rate, note=@note, captured_at=@now`,
  );
  const tx = db.transaction(() => {
    for (const i of items)
      up.run({
        id: `CE-${randomUUID()}`,
        type: i.type,
        klass: i.class,
        eventId: i.eventId ?? null,
        routeId: i.routeId ?? null,
        day: i.day ?? null,
        amount: i.amount,
        amountStatus: i.amountStatus,
        hours: i.hours ?? null,
        rate: i.rate ?? null,
        source: i.source,
        sourceRef: i.sourceRef,
        note: i.note ?? null,
        now,
      });
  });
  tx();
}

export interface EventCost {
  labor: number | null; // ACTUAL direct labor ($), or null when unknown
  laborStatus: "ACTUAL" | "UNAVAILABLE" | "NONE";
}

/** Per-event direct cost (labor only, today). ACTUAL when resolved; UNAVAILABLE when labor was
 *  expected but a rate/shift was missing; NONE when no cost data exists for the event. */
export function getEventDirectCosts(ids: string[]): Map<string, EventCost> {
  const out = new Map<string, EventCost>();
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT event_id, amount, amount_status FROM cost_entries WHERE class='DIRECT' AND event_id IN (${ph})`)
    .all(...ids) as { event_id: string; amount: number | null; amount_status: string }[];
  const agg = new Map<string, { sum: number; anyActual: boolean; anyUnavail: boolean }>();
  for (const r of rows) {
    const a = agg.get(r.event_id) ?? { sum: 0, anyActual: false, anyUnavail: false };
    if (r.amount_status === "ACTUAL" && r.amount != null) {
      a.sum += r.amount;
      a.anyActual = true;
    } else if (r.amount_status === "UNAVAILABLE") {
      a.anyUnavail = true;
    }
    agg.set(r.event_id, a);
  }
  for (const [id, a] of agg)
    out.set(id, a.anyActual ? { labor: Math.round(a.sum * 100) / 100, laborStatus: "ACTUAL" } : a.anyUnavail ? { labor: null, laborStatus: "UNAVAILABLE" } : { labor: null, laborStatus: "NONE" });
  for (const id of ids) if (!out.has(id)) out.set(id, { labor: null, laborStatus: "NONE" });
  return out;
}

// ── Inventory demand (booked line items) ─────────────────────────────────────

export interface ItemStop {
  date: string;
  eventId: string; // tx_id — so an event's items count once even across delivery+pickup
  items: { name: string; quantity?: number }[];
}

/** Delivery stops carrying line items, dated on/after `startYmd` — the raw booked-demand signal.
 *  Pickup stops are excluded so an event's items aren't counted twice. */
export function getUpcomingItemStops(startYmd: string): ItemStop[] {
  const rows = getDb()
    .prepare(
      `SELECT r.date AS date, s.tx_id AS event_id, s.items AS items
       FROM stops s JOIN routes r ON s.route_id = r.route_id
       WHERE r.date >= ? AND s.items IS NOT NULL AND s.items != '' AND (s.kind IS NULL OR s.kind != 'pickup')`,
    )
    .all(startYmd) as Array<{ date: string; event_id: string | null; items: string }>;
  return rows.map((r) => ({
    date: r.date,
    eventId: r.event_id ?? "",
    items: (safeJson(r.items) as { name: string; quantity?: number }[]) ?? [],
  }));
}

// ── Capacity (per-day verdict) ───────────────────────────────────────────────

export interface DayCapacityRecord {
  date: string;
  verdict: string;
  reasons: string[];
}

export function saveDayCapacity(items: DayCapacityRecord[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const up = db.prepare(
    `INSERT INTO day_capacity (date, verdict, reasons, computed_at) VALUES (@date,@verdict,@reasons,@now)
     ON CONFLICT(date) DO UPDATE SET verdict=@verdict, reasons=@reasons, computed_at=@now`,
  );
  const tx = db.transaction(() => {
    for (const i of items) up.run({ date: i.date, verdict: i.verdict, reasons: JSON.stringify(i.reasons), now });
  });
  tx();
}

export interface DayCapacityView {
  date: string;
  verdict: string;
  reasons: string[];
}

/** Capacity verdicts for upcoming dates (>= today), soonest first. */
export function getUpcomingCapacity(today: string): DayCapacityView[] {
  return (getDb().prepare("SELECT * FROM day_capacity WHERE date >= ? ORDER BY date").all(today) as Record<string, unknown>[]).map((r) => ({
    date: String(r.date),
    verdict: String(r.verdict),
    reasons: (safeJson(String(r.reasons ?? "[]")) as string[]) ?? [],
  }));
}

export function saveEventReadiness(items: ReadinessRecord[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const up = db.prepare(
    `INSERT INTO event_readiness (event_id, date, label, route_id, score, staffing_score, driver_score,
       warehouse_score, schedule_score, information_score, communication_score, payment_score,
       special_requirements_score, risk_level, calculated_at)
     VALUES (@eventId,@date,@label,@routeId,@score,@staffing,@driver,@warehouse,@schedule,@information,
       @communication,@payment,@special,@riskLevel,@now)
     ON CONFLICT(event_id) DO UPDATE SET date=@date, label=@label, route_id=@routeId, score=@score,
       staffing_score=@staffing, driver_score=@driver, warehouse_score=@warehouse,
       schedule_score=@schedule, information_score=@information, communication_score=@communication,
       payment_score=@payment, special_requirements_score=@special, risk_level=@riskLevel,
       calculated_at=@now`,
  );
  const tx = db.transaction(() => {
    for (const i of items)
      up.run({ ...i.components, eventId: i.eventId, date: i.date, label: i.label, routeId: i.routeId ?? null, score: i.score, riskLevel: i.riskLevel, now });
  });
  tx();
}

// ── Goodshuffle write-back outbox ────────────────────────────────────────────
// Writes our server can't make directly (Cloudflare blocks server-side Goodshuffle
// calls) are queued here for a logged-in session (kiosk WebView / office bookmarklet)
// to drain and replay. See gs_outbox in db/index.ts.

export interface GsOutboxItem {
  id: string;
  op: string;
  routeId?: string;
  stopId?: string;
  gsRouteId?: string;
  transactionId?: string;
  label?: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  lastError?: string;
  /** Structured op data (e.g. { photoIds } for a photo_upload). */
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface GsOutboxRow {
  id: string;
  op: string;
  route_id: string | null;
  stop_id: string | null;
  gs_route_id: string | null;
  transaction_id: string | null;
  label: string | null;
  payload: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toGsItem(r: GsOutboxRow): GsOutboxItem {
  return {
    id: r.id,
    op: r.op,
    routeId: r.route_id ?? undefined,
    stopId: r.stop_id ?? undefined,
    gsRouteId: r.gs_route_id ?? undefined,
    transactionId: r.transaction_id ?? undefined,
    label: r.label ?? undefined,
    payload: r.payload ? safeJson(r.payload) : undefined,
    status: r.status as GsOutboxItem["status"],
    attempts: r.attempts,
    lastError: r.last_error ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function enqueueGsOp(op: {
  op: string;
  routeId?: string;
  stopId?: string;
  gsRouteId?: string;
  transactionId?: string;
  label?: string;
  payload?: unknown;
}): GsOutboxItem {
  const now = new Date().toISOString();
  const id = `GO-${randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO gs_outbox (id, op, route_id, stop_id, gs_route_id, transaction_id, label,
        payload, status, attempts, created_at, updated_at)
       VALUES (@id, @op, @routeId, @stopId, @gsRouteId, @transactionId, @label, @payload,
        'pending', 0, @now, @now)`,
    )
    .run({
      id,
      op: op.op,
      routeId: op.routeId ?? null,
      stopId: op.stopId ?? null,
      gsRouteId: op.gsRouteId ?? null,
      transactionId: op.transactionId ?? null,
      label: op.label ?? null,
      payload: op.payload != null ? JSON.stringify(op.payload) : null,
      now,
    });
  return toGsItem(getDb().prepare("SELECT * FROM gs_outbox WHERE id = ?").get(id) as GsOutboxRow);
}

// The "Warehouse Desktop" Crew user in Zoe's Goodshuffle account — added to every SIGNED project's
// team so the warehouse tablet/workstation sees it in its queue. Id + linkType captured live from
// GSPRO's addNewTeamMember call (POST /app/project/addNewTeamMember: transactionID, userID, linkType).
export const WAREHOUSE_DESKTOP_USER_ID = "983882714";

/** Queue "add Warehouse Desktop to the team" for SIGNED projects it hasn't been added to yet
 *  (add-once via the wd_member_added flag). Batched (default 50/run) so the initial backfill spreads
 *  across pulls instead of flooding GSPRO with hundreds of writes at once; newest events first.
 *  Called after a bookings pull. Returns how many were queued. */
export function enqueueWarehouseTeamAdds(limit = 50): number {
  const db = getDb();
  const rows = db
    .prepare("SELECT booking_id FROM bookings WHERE signed = 1 AND (wd_member_added IS NULL OR wd_member_added = '') ORDER BY COALESCE(event_date,'') DESC LIMIT ?")
    .all(limit) as { booking_id: string }[];
  if (rows.length === 0) return 0;
  const now = new Date().toISOString();
  const mark = db.prepare("UPDATE bookings SET wd_member_added = ? WHERE booking_id = ?");
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      enqueueGsOp({ op: "add_team_member", transactionId: String(r.booking_id), label: "add Warehouse Desktop", payload: { userID: WAREHOUSE_DESKTOP_USER_ID, linkType: "OTHER" } });
      mark.run(now, r.booking_id);
      n++;
    }
  });
  tx();
  return n;
}

/** Pending write-backs, oldest first — what a logged-in session should replay. */
export function listPendingGsOps(limit = 50): GsOutboxItem[] {
  return (
    getDb()
      .prepare("SELECT * FROM gs_outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?")
      .all(limit) as GsOutboxRow[]
  ).map(toGsItem);
}

/** All write-backs (any status), newest first — for the dispatch sync panel. */
export function listGsOps(limit = 50): GsOutboxItem[] {
  return (
    getDb()
      .prepare("SELECT * FROM gs_outbox ORDER BY created_at DESC LIMIT ?")
      .all(limit) as GsOutboxRow[]
  ).map(toGsItem);
}

/** Mark a queued write-back done or failed once a session has (or hasn't) applied it. */
export function ackGsOp(id: string, ok: boolean, error?: string): void {
  getDb()
    .prepare(
      `UPDATE gs_outbox SET status = ?, attempts = attempts + 1,
        last_error = ?, updated_at = ? WHERE id = ?`,
    )
    .run(ok ? "done" : "failed", ok ? null : (error ?? "unknown"), new Date().toISOString(), id);
}

/** Write a fully-scraped route: upsert the route row and replace its stops. */
export function writeRoute(route: Route): void {
  const db = getDb();
  const tx = db.transaction((rt: Route) => {
    upsertRoute({
      routeId: rt.routeId,
      truckId: rt.truckId,
      date: rt.date,
      driverId: rt.driverId,
      status: rt.status,
      gsRouteId: rt.gsRouteId,
    });
    db.prepare("DELETE FROM stops WHERE route_id = ?").run(rt.routeId);
    const ins = db.prepare(
      `INSERT INTO stops (stop_id, route_id, customer_id, sequence, state, cust_name,
        cust_first_name, cust_last_name, kind, cust_phone, address, day_of_name, day_of_phone,
        planned_window, eta, items, tx_id, contact_id, arrived_at, completed_at, tracking_token)
       VALUES (@stopId, @routeId, @customerId, @sequence, @state, @custName,
        @custFirstName, @custLastName, @kind, @custPhone, @address, @dayOfName, @dayOfPhone,
        @plannedWindow, @eta, @items, @txId, @contactId, @arrivedAt, @completedAt, @trackingToken)`,
    );
    for (const s of rt.stops) {
      ins.run({
        stopId: s.stopId,
        routeId: rt.routeId,
        customerId: s.customerId ?? null,
        sequence: s.sequence,
        state: s.state,
        custName: s.custName ?? null,
        custFirstName: s.custFirstName ?? null,
        custLastName: s.custLastName ?? null,
        kind: s.kind ?? null,
        custPhone: s.custPhone ?? null,
        address: s.address ?? null,
        dayOfName: s.dayOfName ?? null,
        dayOfPhone: s.dayOfPhone ?? null,
        plannedWindow: s.plannedWindow ?? null,
        eta: s.eta ?? null,
        items: s.items?.length ? JSON.stringify(s.items) : null,
        txId: s.txId ?? null,
        contactId: s.contactId ?? null,
        arrivedAt: s.arrivedAt ?? null,
        completedAt: s.completedAt ?? null,
        trackingToken: s.trackingLinkId ?? null,
      });
    }
  });
  tx(route);
}

export interface MessageRow {
  toPhone: string | null;
  body: string | null;
  status: string | null;
  sentAt: string;
  stopId: string | null;
  /** Who the message went to, resolved from the stop it belongs to — the customer's name,
   *  or the day-of coordinator's when the message went to their number. Null if unknown. */
  recipientName: string | null;
}

const onlyDigits = (s: string | null | undefined): string => (s ?? "").replace(/\D/g, "");

/** Build a "First Last" display name from the customer's first name (Goodshuffle renter)
 *  and their `custName` — which for Goodshuffle events is usually just the last-name segment
 *  of the event title. Prepend the first name unless `custName` already contains it (so a
 *  full name or a first-name-only label isn't doubled up). */
function displayCustomerName(first: string | null, name: string | null): string | null {
  const f = (first ?? "").trim();
  const n = (name ?? "").trim();
  if (!n) return f || null;
  if (!f) return n;
  const tokens = n.toLowerCase().split(/\s+/);
  return tokens.includes(f.toLowerCase()) ? n : `${f} ${n}`;
}

/** Recent outbound messages, newest first — for the dispatch dashboard. Resolves each
 *  message's recipient to a human name via its stop (customer, or day-of coordinator when
 *  the number matches theirs), so the log reads as names instead of phone numbers. */
export function getRecentMessages(limit = 40): MessageRow[] {
  const rows = getDb()
    .prepare(
      `SELECT m.to_phone, m.body, m.status, m.sent_at, m.stop_id,
              s.cust_name, s.cust_first_name, s.cust_last_name, s.day_of_name, s.cust_phone, s.day_of_phone
       FROM messages m LEFT JOIN stops s ON m.stop_id = s.stop_id
       ORDER BY m.sent_at DESC LIMIT ?`,
    )
    .all(limit) as {
    to_phone: string | null;
    body: string | null;
    status: string | null;
    sent_at: string;
    stop_id: string | null;
    cust_name: string | null;
    cust_first_name: string | null;
    cust_last_name: string | null;
    day_of_name: string | null;
    cust_phone: string | null;
    day_of_phone: string | null;
  }[];
  return rows.map((r) => {
    const to = onlyDigits(r.to_phone);
    // Prefer the coordinator's name only when the message actually went to their number.
    const isCoordinator = Boolean(r.day_of_name) && to.length > 0 && onlyDigits(r.day_of_phone) === to;
    // Renter's real First + Last (when we captured it) reads best; otherwise fall back to
    // the first name + the event-label custName, then custName alone.
    const renterFull = [r.cust_first_name, r.cust_last_name].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
    const recipientName = isCoordinator
      ? r.day_of_name
      : renterFull || displayCustomerName(r.cust_first_name, r.cust_name);
    return {
      toPhone: r.to_phone,
      body: r.body,
      status: r.status,
      sentAt: r.sent_at,
      stopId: r.stop_id,
      recipientName,
    };
  });
}

export interface ExceptionRow {
  exceptionId: string;
  stopId: string | null;
  type: string | null;
  reason: string | null;
  truckId: string | null;
  ts: string;
  resolved: boolean;
}

/** Unresolved exceptions, newest first — for the dispatch dashboard. */
export function getOpenExceptions(): ExceptionRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM exceptions WHERE resolved = 0 ORDER BY ts DESC")
    .all() as {
    exception_id: string;
    stop_id: string | null;
    type: string | null;
    reason: string | null;
    truck_id: string | null;
    ts: string;
    resolved: number;
  }[];
  return rows.map((r) => ({
    exceptionId: r.exception_id,
    stopId: r.stop_id,
    type: r.type,
    reason: r.reason,
    truckId: r.truck_id,
    ts: r.ts,
    resolved: Boolean(r.resolved),
  }));
}

export function getStop(stopId: string): Stop | null {
  const row = getDb()
    .prepare("SELECT * FROM stops WHERE stop_id = ?")
    .get(stopId) as StopRow | undefined;
  return row ? toStop(row) : null;
}

export function updateStopState(
  stopId: string,
  toState: StopState,
  opts: { arrivedAt?: string; completedAt?: string } = {},
): void {
  const db = getDb();
  db.prepare("UPDATE stops SET state = ? WHERE stop_id = ?").run(toState, stopId);
  if (opts.arrivedAt)
    db.prepare("UPDATE stops SET arrived_at = ? WHERE stop_id = ?").run(opts.arrivedAt, stopId);
  if (opts.completedAt)
    db.prepare("UPDATE stops SET completed_at = ? WHERE stop_id = ?").run(opts.completedAt, stopId);
}

/** Attach proof-of-delivery references (captured at completion) to a stop. */
export function setStopProof(
  stopId: string,
  proof: { photoIds?: string[]; signatureId?: string },
): void {
  getDb()
    .prepare("UPDATE stops SET photos_ref = ?, signature_ref = ? WHERE stop_id = ?")
    .run(
      proof.photoIds?.length ? JSON.stringify(proof.photoIds) : null,
      proof.signatureId ?? null,
      stopId,
    );
}

/**
 * TEST/dev helper: reset a route's progress back to the start — every stop to
 * "Waiting", with arrival/completion timestamps, proof refs, and the tracking
 * token cleared, and the route status back to "ready". The stops themselves
 * (customer, address, phone, window) are untouched. Returns the rows changed.
 * With a truckId, resets that truck's most recent route; without one, resets
 * every non-Waiting stop (only used behind the ROUTE_RESET_ENABLED gate).
 */
export function resetRouteProgress(truckId?: string): { stops: number; routes: number } {
  const db = getDb();
  const clearStops =
    "UPDATE stops SET state='Waiting', arrived_at=NULL, completed_at=NULL, " +
    "photos_ref=NULL, signature_ref=NULL, tracking_token=NULL";
  if (truckId) {
    const route = db
      .prepare("SELECT route_id FROM routes WHERE truck_id = ? ORDER BY date DESC LIMIT 1")
      .get(truckId) as { route_id: string } | undefined;
    if (!route) return { stops: 0, routes: 0 };
    const s = db.prepare(`${clearStops} WHERE route_id = ?`).run(route.route_id);
    const r = db
      .prepare("UPDATE routes SET status='ready', updated_at=? WHERE route_id = ?")
      .run(new Date().toISOString(), route.route_id);
    return { stops: s.changes, routes: r.changes };
  }
  const s = db.prepare(`${clearStops} WHERE state != 'Waiting'`).run();
  const r = db
    .prepare("UPDATE routes SET status='ready', updated_at=? WHERE status != 'ready'")
    .run(new Date().toISOString());
  return { stops: s.changes, routes: r.changes };
}

/** Move the next stop (by sequence) of a route into EnRoute; return it. */
export function advanceNextStop(routeId: string, currentSequence: number): Stop | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM stops WHERE route_id = ? AND sequence > ? ORDER BY sequence LIMIT 1",
    )
    .get(routeId, currentSequence) as StopRow | undefined;
  if (!row) return null;
  db.prepare("UPDATE stops SET state = 'EnRoute' WHERE stop_id = ?").run(row.stop_id);
  return toStop({ ...row, state: "EnRoute" });
}

/** Insert an event; returns false if the idempotency key was already seen. */
export function insertEventIfNew(e: {
  eventId: string;
  idempotencyKey: string;
  stopId?: string;
  routeId?: string;
  truckId?: string;
  driverId?: string;
  action: string;
  fromState?: string;
  toState?: string;
  ts: string;
  gps?: unknown;
  payload?: unknown;
}): boolean {
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO events (event_id, idempotency_key, stop_id, route_id, truck_id,
        driver_id, action, from_state, to_state, ts, gps, payload)
       VALUES (@eventId, @idempotencyKey, @stopId, @routeId, @truckId, @driverId, @action,
        @fromState, @toState, @ts, @gps, @payload)`,
    )
    .run({
      eventId: e.eventId,
      idempotencyKey: e.idempotencyKey,
      stopId: e.stopId ?? null,
      routeId: e.routeId ?? null,
      truckId: e.truckId ?? null,
      driverId: e.driverId ?? null,
      action: e.action,
      fromState: e.fromState ?? null,
      toState: e.toState ?? null,
      ts: e.ts,
      gps: e.gps ? JSON.stringify(e.gps) : null,
      payload: e.payload ? JSON.stringify(e.payload) : null,
    });
  return info.changes > 0;
}

/** Guard against accidental double-sends: was an identical SMS to this number sent very recently? */
export function smsRecentlySent(toPhone: string, body: string, sinceIso: string): boolean {
  const r = getDb()
    .prepare("SELECT 1 FROM messages WHERE channel='sms' AND to_phone=? AND body=? AND sent_at > ? LIMIT 1")
    .get(toPhone, body, sinceIso);
  return !!r;
}

export function insertMessage(m: {
  stopId?: string;
  channel: string;
  provider: string;
  toPhone?: string;
  body: string;
  providerMsgId?: string;
  status: string;
  error?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO messages (message_id, stop_id, channel, provider, to_phone, body,
        provider_msg_id, status, error, sent_at)
       VALUES (@id, @stopId, @channel, @provider, @toPhone, @body, @providerMsgId, @status, @error, @now)`,
    )
    .run({
      id: `M-${randomUUID()}`,
      stopId: m.stopId ?? null,
      channel: m.channel,
      provider: m.provider,
      toPhone: m.toPhone ?? null,
      body: m.body,
      providerMsgId: m.providerMsgId ?? null,
      status: m.status,
      error: m.error ?? null,
      now: new Date().toISOString(),
    });
}

/** Mark an exception resolved — dispatch cleared it from the board. */
export function resolveException(exceptionId: string): boolean {
  const info = getDb()
    .prepare("UPDATE exceptions SET resolved = 1 WHERE exception_id = ?")
    .run(exceptionId);
  return info.changes > 0;
}

export function insertException(x: {
  stopId?: string;
  type: string;
  reason: string;
  driverId?: string;
  truckId?: string;
  gps?: unknown;
}): void {
  getDb()
    .prepare(
      `INSERT INTO exceptions (exception_id, stop_id, type, reason, driver_id, truck_id, gps, ts, resolved)
       VALUES (@id, @stopId, @type, @reason, @driverId, @truckId, @gps, @now, 0)`,
    )
    .run({
      id: `X-${randomUUID()}`,
      stopId: x.stopId ?? null,
      type: x.type,
      reason: x.reason,
      driverId: x.driverId ?? null,
      truckId: x.truckId ?? null,
      gps: x.gps ? JSON.stringify(x.gps) : null,
      now: new Date().toISOString(),
    });
}

export function insertAudit(a: {
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}): void {
  getDb()
    .prepare(
      `INSERT INTO audit_logs (audit_id, actor, action, entity, entity_id, before, after, ts)
       VALUES (@id, @actor, @action, @entity, @entityId, @before, @after, @now)`,
    )
    .run({
      id: `A-${randomUUID()}`,
      actor: a.actor,
      action: a.action,
      entity: a.entity,
      entityId: a.entityId,
      before: a.before ? JSON.stringify(a.before) : null,
      after: a.after ? JSON.stringify(a.after) : null,
      now: new Date().toISOString(),
    });
}

export interface AuditRow {
  auditId: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  detail: Record<string, unknown> | null; // parsed from `after`
  ts: string;
}

function toAudit(r: Record<string, unknown>): AuditRow {
  let detail: Record<string, unknown> | null = null;
  try {
    detail = r.after ? (JSON.parse(String(r.after)) as Record<string, unknown>) : null;
  } catch {
    detail = null;
  }
  return {
    auditId: String(r.audit_id),
    actor: String(r.actor ?? ""),
    action: String(r.action ?? ""),
    entity: String(r.entity ?? ""),
    entityId: String(r.entity_id ?? ""),
    detail,
    ts: String(r.ts),
  };
}

/** Audit entries for one entity (e.g. a lead), newest first — the per-lead activity trail. */
export function getAuditForEntity(entity: string, entityId: string, limit = 50): AuditRow[] {
  return (
    getDb()
      .prepare("SELECT * FROM audit_logs WHERE entity = ? AND entity_id = ? ORDER BY ts DESC LIMIT ?")
      .all(entity, entityId, limit) as Record<string, unknown>[]
  ).map(toAudit);
}

/** Recent audit entries across a set of actions (the global sales activity feed). */
export function getRecentAudit(actions: string[], limit = 100): AuditRow[] {
  if (actions.length === 0) return [];
  const ph = actions.map(() => "?").join(",");
  return (
    getDb()
      .prepare(`SELECT * FROM audit_logs WHERE action IN (${ph}) ORDER BY ts DESC LIMIT ?`)
      .all(...actions, limit) as Record<string, unknown>[]
  ).map(toAudit);
}

/** Was this action already logged for this entity by this actor recently? (view-spam dedupe). */
export function auditExistsSince(entity: string, entityId: string, action: string, actor: string, sinceIso: string): boolean {
  const r = getDb()
    .prepare("SELECT 1 FROM audit_logs WHERE entity=? AND entity_id=? AND action=? AND actor=? AND ts > ? LIMIT 1")
    .get(entity, entityId, action, actor, sinceIso);
  return !!r;
}

export function createTracking(stopId: string, routeId: string, baseUrl: string): { token: string; url: string } {
  const token = randomUUID().replace(/-/g, "").slice(0, 20);
  const url = `${baseUrl.replace(/\/$/, "")}/track/${token}`;
  const expiresAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO tracking_links (token, stop_id, route_id, url, expires_at, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(token, stopId, routeId, url, expiresAt, new Date().toISOString());
  getDb().prepare("UPDATE stops SET tracking_token = ? WHERE stop_id = ?").run(token, stopId);
  return { token, url };
}

export interface TrackingView {
  token: string;
  active: boolean;
  expiresAt: string | null;
  stop: Stop | null;
  truckId: string | null;
}

export function getTracking(token: string): TrackingView | null {
  const db = getDb();
  const link = db
    .prepare("SELECT * FROM tracking_links WHERE token = ?")
    .get(token) as
    | { token: string; stop_id: string; route_id: string; active: number; expires_at: string }
    | undefined;
  if (!link) return null;
  const stop = getStop(link.stop_id);
  const route = db
    .prepare("SELECT truck_id FROM routes WHERE route_id = ?")
    .get(link.route_id) as { truck_id: string } | undefined;
  return {
    token: link.token,
    active: Boolean(link.active),
    expiresAt: link.expires_at ?? null,
    stop,
    truckId: route?.truck_id ?? null,
  };
}

export function expireTracking(stopId: string): void {
  getDb().prepare("UPDATE tracking_links SET active = 0 WHERE stop_id = ?").run(stopId);
}

// ── Comms events — unified inbound/outbound SMS (+ calls later) timeline per lead (Phase 3/4) ──

export interface CommsEventInput {
  providerId: string; // OpenPhone message/call id (idempotency)
  leadId?: string | null;
  direction: "inbound" | "outbound";
  channel: "sms" | "call";
  fromPhone?: string | null;
  toPhone?: string | null;
  body?: string | null;
  actor?: string | null;
  occurredAt?: string | null;
}

export interface CommsEventView {
  id: string;
  providerId: string;
  leadId: string | null;
  direction: "inbound" | "outbound";
  channel: string;
  fromPhone: string | null;
  toPhone: string | null;
  body: string | null;
  actor: string | null;
  occurredAt: string | null;
  ts: string;
}

function toCommsEvent(r: Record<string, unknown>): CommsEventView {
  return {
    id: String(r.id),
    providerId: String(r.provider_id ?? ""),
    leadId: (r.lead_id as string) ?? null,
    direction: (r.direction as "inbound" | "outbound") ?? "inbound",
    channel: String(r.channel ?? ""),
    fromPhone: (r.from_phone as string) ?? null,
    toPhone: (r.to_phone as string) ?? null,
    body: (r.body as string) ?? null,
    actor: (r.actor as string) ?? null,
    occurredAt: (r.occurred_at as string) ?? null,
    ts: String(r.ts),
  };
}

/** Record a comms event if its provider id is new (idempotent — providers retry webhooks). Returns
 *  the row id, or null if it was a duplicate. */
export function insertCommsEventIfNew(e: CommsEventInput): string | null {
  const id = `CM-${randomUUID()}`;
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO comms_events (id, provider_id, lead_id, direction, channel, from_phone,
        to_phone, body, actor, occurred_at, ts)
       VALUES (@id,@providerId,@leadId,@direction,@channel,@fromPhone,@toPhone,@body,@actor,@occurredAt,@ts)`,
    )
    .run({
      id,
      providerId: e.providerId,
      leadId: e.leadId ?? null,
      direction: e.direction,
      channel: e.channel,
      fromPhone: e.fromPhone ?? null,
      toPhone: e.toPhone ?? null,
      body: e.body ?? null,
      actor: e.actor ?? null,
      occurredAt: e.occurredAt ?? null,
      ts: new Date().toISOString(),
    });
  return info.changes > 0 ? id : null;
}

/** The conversation for one lead (inbound + outbound), newest first. */
export function getCommsForLead(leadId: string, limit = 30): CommsEventView[] {
  return (
    getDb()
      .prepare("SELECT * FROM comms_events WHERE lead_id = ? ORDER BY COALESCE(occurred_at, ts) DESC LIMIT ?")
      .all(leadId, limit) as Record<string, unknown>[]
  ).map(toCommsEvent);
}

/** Most recent inbound comms across all leads with a lead match — the "customers who just replied"
 *  feed foundation (Phase 7 command center). */
export function getRecentInboundComms(limit = 50): CommsEventView[] {
  return (
    getDb()
      .prepare("SELECT * FROM comms_events WHERE direction = 'inbound' AND lead_id IS NOT NULL ORDER BY COALESCE(occurred_at, ts) DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[]
  ).map(toCommsEvent);
}

/** The most recent inbound message for a lead (the customer's latest words), or null. */
export function getLatestInboundForLead(leadId: string): CommsEventView | null {
  const r = getDb()
    .prepare("SELECT * FROM comms_events WHERE lead_id = ? AND direction = 'inbound' ORDER BY COALESCE(occurred_at, ts) DESC LIMIT 1")
    .get(leadId) as Record<string, unknown> | undefined;
  return r ? toCommsEvent(r) : null;
}

/** Timestamp of the most recent comms of any direction for a lead (for dormancy), or null. */
export function getLastCommsAt(leadId: string): string | null {
  const r = getDb()
    .prepare("SELECT COALESCE(occurred_at, ts) AS t FROM comms_events WHERE lead_id = ? ORDER BY t DESC LIMIT 1")
    .get(leadId) as { t: string } | undefined;
  return r?.t ?? null;
}

// ── Customer state (Phase 5) — the evidence-driven state machine, one row per lead ──

export interface CustomerStateRow {
  leadId: string;
  state: string;
  confidence: number | null;
  evidence: string | null;
  source: string | null;
  previousState: string | null;
  reason: string | null;
  ts: string;
}

function toCustomerState(r: Record<string, unknown>): CustomerStateRow {
  return {
    leadId: String(r.lead_id),
    state: String(r.state),
    confidence: r.confidence == null ? null : Number(r.confidence),
    evidence: (r.evidence as string) ?? null,
    source: (r.source as string) ?? null,
    previousState: (r.previous_state as string) ?? null,
    reason: (r.reason as string) ?? null,
    ts: String(r.ts),
  };
}

export function getCustomerState(leadId: string): CustomerStateRow | null {
  const r = getDb().prepare("SELECT * FROM customer_state WHERE lead_id = ?").get(leadId) as Record<string, unknown> | undefined;
  return r ? toCustomerState(r) : null;
}

/** All stored customer states, keyed by lead id — for the command center overlay. */
export function getAllCustomerStates(): Map<string, CustomerStateRow> {
  const out = new Map<string, CustomerStateRow>();
  for (const r of getDb().prepare("SELECT * FROM customer_state").all() as Record<string, unknown>[]) {
    const cs = toCustomerState(r);
    out.set(cs.leadId, cs);
  }
  return out;
}

/** Upsert a lead's state, preserving the prior state as previous_state on a transition. */
export function upsertCustomerState(s: { leadId: string; state: string; confidence: number | null; evidence: string | null; source: string | null; reason: string | null }): void {
  const prior = getCustomerState(s.leadId);
  const previousState = prior && prior.state !== s.state ? prior.state : (prior?.previousState ?? null);
  getDb()
    .prepare(
      `INSERT INTO customer_state (lead_id, state, confidence, evidence, source, previous_state, reason, ts)
       VALUES (@leadId,@state,@confidence,@evidence,@source,@previousState,@reason,@ts)
       ON CONFLICT(lead_id) DO UPDATE SET state=@state, confidence=@confidence, evidence=@evidence,
         source=@source, previous_state=@previousState, reason=@reason, ts=@ts`,
    )
    .run({
      leadId: s.leadId,
      state: s.state,
      confidence: s.confidence,
      evidence: s.evidence,
      source: s.source,
      previousState,
      reason: s.reason,
      ts: new Date().toISOString(),
    });
}

// ── Call events (OpenPhone) — inbound call metadata + sentiment for the customer-alerts feature ──

export interface CallEventInput {
  providerId: string; // OpenPhone call/event id (idempotency key)
  eventType?: string;
  direction?: string;
  fromPhone?: string;
  toPhone?: string;
  contactName?: string;
  durationSec?: number | null;
  transcript?: string | null;
  summary?: string | null;
  occurredAt?: string | null;
}

export interface CallEventView {
  id: string;
  providerId: string;
  eventType: string | null;
  direction: string | null;
  fromPhone: string | null;
  toPhone: string | null;
  contactName: string | null;
  durationSec: number | null;
  transcript: string | null;
  summary: string | null;
  sentiment: string | null;
  score: number | null;
  method: string | null;
  reasons: string[];
  llmModel: string | null;
  alertedAt: string | null;
  noteLoggedAt: string | null;
  coachingAttemptedAt: string | null;
  occurredAt: string | null;
  ts: string;
}

function toCallEvent(r: Record<string, unknown>): CallEventView {
  let reasons: string[] = [];
  try {
    reasons = r.reasons ? (JSON.parse(String(r.reasons)) as string[]) : [];
  } catch {
    reasons = [];
  }
  return {
    id: String(r.id),
    providerId: String(r.provider_id ?? ""),
    eventType: (r.event_type as string) ?? null,
    direction: (r.direction as string) ?? null,
    fromPhone: (r.from_phone as string) ?? null,
    toPhone: (r.to_phone as string) ?? null,
    contactName: (r.contact_name as string) ?? null,
    durationSec: r.duration_sec == null ? null : Number(r.duration_sec),
    transcript: (r.transcript as string) ?? null,
    summary: (r.summary as string) ?? null,
    sentiment: (r.sentiment as string) ?? null,
    score: r.score == null ? null : Number(r.score),
    method: (r.method as string) ?? null,
    reasons,
    llmModel: (r.llm_model as string) ?? null,
    alertedAt: (r.alerted_at as string) ?? null,
    noteLoggedAt: (r.note_logged_at as string) ?? null,
    coachingAttemptedAt: (r.coaching_attempted_at as string) ?? null,
    occurredAt: (r.occurred_at as string) ?? null,
    ts: String(r.ts),
  };
}

/** Record that we tried to build a coaching recap for a call but couldn't (thin transcript, model
 *  error). Keeps the backfill from re-attempting it forever and wedging on it. */
export function markCoachingAttempted(callId: string): void {
  getDb().prepare("UPDATE call_events SET coaching_attempted_at = ? WHERE id = ?").run(new Date().toISOString(), callId);
}

/** Mark that we've queued a Goodshuffle note for this call — so a duplicate webhook never double-logs. */
export function markCallNoteLogged(id: string): void {
  getDb().prepare("UPDATE call_events SET note_logged_at=? WHERE id=?").run(new Date().toISOString(), id);
}

/** Insert a call event if its OpenPhone id is new (idempotent). Returns the row id, or null if a
 *  row with that provider id already exists (duplicate webhook delivery — OpenPhone retries). */
export function insertCallEventIfNew(e: CallEventInput): string | null {
  const id = `CALL-${randomUUID()}`;
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO call_events (id, provider_id, event_type, direction, from_phone, to_phone,
        contact_name, duration_sec, transcript, summary, occurred_at, ts)
       VALUES (@id, @providerId, @eventType, @direction, @fromPhone, @toPhone, @contactName,
        @durationSec, @transcript, @summary, @occurredAt, @ts)`,
    )
    .run({
      id,
      providerId: e.providerId,
      eventType: e.eventType ?? null,
      direction: e.direction ?? null,
      fromPhone: e.fromPhone ?? null,
      toPhone: e.toPhone ?? null,
      contactName: e.contactName ?? null,
      durationSec: e.durationSec ?? null,
      transcript: e.transcript ?? null,
      summary: e.summary ?? null,
      occurredAt: e.occurredAt ?? null,
      ts: new Date().toISOString(),
    });
  return info.changes > 0 ? id : null;
}

/** Look up a call event by its OpenPhone call id (several webhook events share one call). */
export function getCallEventByProviderId(providerId: string): CallEventView | null {
  const r = getDb().prepare("SELECT * FROM call_events WHERE provider_id = ?").get(providerId) as
    | Record<string, unknown>
    | undefined;
  return r ? toCallEvent(r) : null;
}

/** Fill in call content that arrives on a later event (transcript/summary/duration), non-null only. */
export function updateCallContent(
  id: string,
  c: { transcript?: string | null; summary?: string | null; durationSec?: number | null; contactName?: string | null; eventType?: string | null; fromPhone?: string | null; toPhone?: string | null },
): void {
  getDb()
    .prepare(
      `UPDATE call_events SET
         transcript   = COALESCE(@transcript, transcript),
         summary      = COALESCE(@summary, summary),
         duration_sec = COALESCE(@durationSec, duration_sec),
         contact_name = COALESCE(@contactName, contact_name),
         event_type   = COALESCE(@eventType, event_type),
         from_phone   = COALESCE(from_phone, @fromPhone),
         to_phone     = COALESCE(to_phone, @toPhone)
       WHERE id = @id`,
    )
    .run({
      id,
      transcript: c.transcript ?? null,
      summary: c.summary ?? null,
      durationSec: c.durationSec ?? null,
      contactName: c.contactName ?? null,
      eventType: c.eventType ?? null,
      fromPhone: c.fromPhone ?? null,
      toPhone: c.toPhone ?? null,
    });
}

/** Attach the sentiment verdict to a call event. */
export function setCallSentiment(
  id: string,
  v: { sentiment: string; score: number | null; method: string; reasons: string[]; llmModel?: string | null },
): void {
  getDb()
    .prepare(
      `UPDATE call_events SET sentiment=@sentiment, score=@score, method=@method, reasons=@reasons,
        llm_model=@llmModel WHERE id=@id`,
    )
    .run({
      id,
      sentiment: v.sentiment,
      score: v.score,
      method: v.method,
      reasons: JSON.stringify(v.reasons ?? []),
      llmModel: v.llmModel ?? null,
    });
}

/** Mark that a Slack alert was sent for this call (so we never double-alert). */
export function markCallAlerted(id: string): void {
  getDb().prepare("UPDATE call_events SET alerted_at=? WHERE id=?").run(new Date().toISOString(), id);
}

/** Most-recent call events (for a future Customer-alerts view / debugging). */
export function getRecentCallEvents(limit = 50): CallEventView[] {
  return (
    getDb().prepare("SELECT * FROM call_events ORDER BY ts DESC LIMIT ?").all(limit) as Record<string, unknown>[]
  ).map(toCallEvent);
}

/** One call event by OUR id (call_events.id) — for the coaching detail page. */
export function getCallEventById(id: string): CallEventView | null {
  const r = getDb().prepare("SELECT * FROM call_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? toCallEvent(r) : null;
}

// ---- Post-call coaching (Custodian-in-Maestro) --------------------------------------------------

/** A call that has a transcript and can therefore be coached, plus whether a recap already exists. */
export interface CoachableCall {
  id: string;
  direction: string | null;
  fromPhone: string | null;
  toPhone: string | null;
  contactName: string | null; // resolved name, or null when only a phone is known
  customerPhone: string | null; // the customer's number (from metadata or the transcript)
  caller: string; // display label: resolved name, else formatted phone, else "Unknown caller"
  durationSec: number | null;
  sentiment: string | null;
  occurredAt: string | null;
  ts: string;
  analyzed: boolean;
}

const prettyPhone = (p: string | null): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  const t = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : (p ?? "").trim() || null;
};

const callerDigits = (direction: string | null, fromPhone: string | null, toPhone: string | null): string | null => {
  const p = direction === "outgoing" ? toPhone : fromPhone;
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

/** Resolve a human name for the counterparty: an explicit contact name (from Quo), else the matched
 *  customer (our booking, by phone), else null — in which case callers display the phone number. */
export function resolveCallerName(call: {
  contactName: string | null;
  direction: string | null;
  fromPhone: string | null;
  toPhone: string | null;
}): string | null {
  if (call.contactName && call.contactName.trim()) return call.contactName.trim();
  const digits = callerDigits(call.direction, call.fromPhone, call.toPhone);
  if (!digits) return null;
  return getBookingByPhoneDigits(digits)?.clientName?.trim() || null;
}

const last10Digits = (p: string | null): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

/** Calls with a transcript (the only ones coachable), newest first, flagged whether analyzed. Caller
 *  identity is resolved from Quo's contact name, else our matched customer by phone; the customer's
 *  number is recovered from the transcript's speakers when the call metadata lacks it. `ourDigits`
 *  (Zoe's own numbers) lets us tell the customer's phone from ours. */
export function listCoachableCalls(limit = 50, ourDigits?: Set<string>, contactMap?: Map<string, string>): CoachableCall[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.direction, c.from_phone, c.to_phone, c.contact_name, c.transcript, c.duration_sec,
              c.sentiment, c.occurred_at, c.ts,
              CASE WHEN a.call_id IS NOT NULL THEN 1 ELSE 0 END AS analyzed
         FROM call_events c
         LEFT JOIN coaching_analyses a ON a.call_id = c.id
        WHERE c.transcript IS NOT NULL AND TRIM(c.transcript) <> ''
        ORDER BY COALESCE(c.occurred_at, c.ts) DESC
        LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => {
    const direction = (r.direction as string) ?? null;
    const fromPhone = (r.from_phone as string) ?? null;
    const toPhone = (r.to_phone as string) ?? null;

    // Customer number: the call's external party, else the non-Zoe speaker in the transcript.
    const fromD = last10Digits(fromPhone);
    const toD = last10Digits(toPhone);
    let customerPhone: string | null =
      fromD && !ourDigits?.has(fromD) ? fromPhone : toD && !ourDigits?.has(toD) ? toPhone : null;
    if (!customerPhone) {
      const cust = computeCallMetrics(String(r.transcript ?? ""), null, ourDigits).speakers.find((s) => s.label === "Customer");
      customerPhone = cust && /\d{10}/.test(cust.raw) ? cust.raw : null;
    }

    const custDigits = last10Digits(customerPhone);
    const contactName =
      ((r.contact_name as string) ?? "").trim() ||
      resolveCallerName({ contactName: null, direction, fromPhone, toPhone }) ||
      (custDigits ? getBookingByPhoneDigits(custDigits)?.clientName?.trim() || null : null) ||
      (custDigits ? contactMap?.get(custDigits) ?? null : null) ||
      null;

    return {
      id: String(r.id),
      direction,
      fromPhone,
      toPhone,
      contactName,
      customerPhone,
      caller: contactName || prettyPhone(customerPhone) || "Unknown caller",
      durationSec: r.duration_sec == null ? null : Number(r.duration_sec),
      sentiment: (r.sentiment as string) ?? null,
      occurredAt: (r.occurred_at as string) ?? null,
      ts: String(r.ts),
      analyzed: Number(r.analyzed) === 1,
    };
  });
}

/** A customer's other coachable calls — their conversation thread — newest first, excluding one id.
 *  Matches by the customer's last-10 digits (derived the same way as the list). */
export function getCustomerCallThread(
  customerDigits: string,
  opts: { ourDigits?: Set<string>; contactMap?: Map<string, string>; excludeId?: string; limit?: number } = {},
): CoachableCall[] {
  if (!customerDigits) return [];
  return listCoachableCalls(300, opts.ourDigits, opts.contactMap)
    .filter((c) => last10Digits(c.customerPhone) === customerDigits && c.id !== opts.excludeId)
    .slice(0, opts.limit ?? 20);
}

// ---- Name enrichment: keep trying to resolve a name for calls that still show only a number ------

/** Coachable calls with no resolved name yet, due for a (re)attempt — i.e. never attempted, or last
 *  attempted before `cutoffIso`. Newest first. Powers the continuous name-enrichment loop. */
export function listUnnamedCoachableCalls(limit: number, cutoffIso: string): {
  id: string;
  transcript: string;
  direction: string | null;
  fromPhone: string | null;
  toPhone: string | null;
}[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.transcript, c.direction, c.from_phone, c.to_phone
         FROM call_events c
        WHERE (c.contact_name IS NULL OR TRIM(c.contact_name) = '')
          AND c.transcript IS NOT NULL AND TRIM(c.transcript) <> ''
          AND (c.name_attempted_at IS NULL OR c.name_attempted_at < ?)
        ORDER BY COALESCE(c.occurred_at, c.ts) DESC
        LIMIT ?`,
    )
    .all(cutoffIso, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    transcript: String(r.transcript ?? ""),
    direction: (r.direction as string) ?? null,
    fromPhone: (r.from_phone as string) ?? null,
    toPhone: (r.to_phone as string) ?? null,
  }));
}

/** How many un-named calls are still due for a name attempt (drives the loop's progress + stop). */
export function countUnnamedDueCalls(cutoffIso: string): number {
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM call_events c
        WHERE (c.contact_name IS NULL OR TRIM(c.contact_name) = '')
          AND c.transcript IS NOT NULL AND TRIM(c.transcript) <> ''
          AND (c.name_attempted_at IS NULL OR c.name_attempted_at < ?)`,
    )
    .get(cutoffIso) as { n: number };
  return Number(r.n);
}

/** Persist a resolved caller name onto a call (and clear its name-attempt throttle — it's named now). */
export function setCallContactName(callId: string, name: string): void {
  getDb().prepare("UPDATE call_events SET contact_name = ?, name_attempted_at = NULL WHERE id = ?").run(name, callId);
}

/** Record that we tried to resolve a name and couldn't — throttles the next retry for this call. */
export function markNameAttempted(callId: string): void {
  getDb().prepare("UPDATE call_events SET name_attempted_at = ? WHERE id = ?").run(new Date().toISOString(), callId);
}

/** Distinct non-empty customer phone numbers from our bookings — the leads to pull call history for. */
export function listBookingPhones(): string[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT client_phone FROM bookings WHERE client_phone IS NOT NULL AND TRIM(client_phone) <> ''")
    .all() as { client_phone: string }[];
  return rows.map((r) => r.client_phone);
}

/** Un-analyzed coachable calls (transcript present, no recap yet), oldest first so the backlog
 *  drains in chronological order. Powers the auto-backfill. */
export function listUnanalyzedCoachableCalls(limit = 25): { id: string; transcript: string; direction: string | null; contactName: string | null; durationSec: number | null; quoSummary: string | null }[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.transcript, c.summary, c.direction, c.from_phone, c.to_phone, c.contact_name, c.duration_sec
         FROM call_events c
         LEFT JOIN coaching_analyses a ON a.call_id = c.id
        WHERE a.call_id IS NULL AND c.coaching_attempted_at IS NULL
          AND c.transcript IS NOT NULL AND TRIM(c.transcript) <> ''
        ORDER BY COALESCE(c.occurred_at, c.ts) DESC
        LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => {
    const direction = (r.direction as string) ?? null;
    return {
      id: String(r.id),
      transcript: String(r.transcript ?? ""),
      direction,
      contactName: resolveCallerName({ contactName: (r.contact_name as string) ?? null, direction, fromPhone: (r.from_phone as string) ?? null, toPhone: (r.to_phone as string) ?? null }),
      durationSec: r.duration_sec == null ? null : Number(r.duration_sec),
      quoSummary: (r.summary as string) ?? null,
    };
  });
}

/** Count of coachable calls still without a recap — for the backfill progress UI. */
export function countUnanalyzedCoachableCalls(): number {
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM call_events c
         LEFT JOIN coaching_analyses a ON a.call_id = c.id
        WHERE a.call_id IS NULL AND c.coaching_attempted_at IS NULL
          AND c.transcript IS NOT NULL AND TRIM(c.transcript) <> ''`,
    )
    .get() as { n: number };
  return Number(r.n);
}

/** The stored coaching recap for a call, or null if it hasn't been analyzed yet. */
export function getCoachingAnalysis(callId: string): CallRecap | null {
  const r = getDb().prepare("SELECT recap_json FROM coaching_analyses WHERE call_id = ?").get(callId) as
    | { recap_json: string }
    | undefined;
  if (!r) return null;
  try {
    return JSON.parse(r.recap_json) as CallRecap;
  } catch {
    return null;
  }
}

/** Store (or replace) a call's coaching recap. */
export function saveCoachingAnalysis(callId: string, recap: CallRecap): void {
  getDb()
    .prepare(
      `INSERT INTO coaching_analyses (call_id, recap_json, model, created_at)
       VALUES (@callId, @recapJson, @model, @createdAt)
       ON CONFLICT(call_id) DO UPDATE SET recap_json = excluded.recap_json, model = excluded.model,
         created_at = excluded.created_at`,
    )
    .run({
      callId,
      recapJson: JSON.stringify(recap),
      model: recap.model ?? null,
      createdAt: new Date().toISOString(),
    });
}

// ---- Sales OS board status (manual Kanban column, overrides the derived default) -----------------

export type LeadBoardStatus = "new" | "quote_sent" | "follow_up" | "action_needed" | "signed" | "archived";

/** Manual board-status overrides, by booking id. Effective status = override ?? derived default. */
export function getLeadStatusMap(): Map<string, LeadBoardStatus> {
  const rows = getDb().prepare("SELECT booking_id, status FROM lead_status").all() as { booking_id: string; status: string }[];
  const m = new Map<string, LeadBoardStatus>();
  for (const r of rows) m.set(r.booking_id, r.status as LeadBoardStatus);
  return m;
}

/** Set (or clear the row for) a lead's board status. */
export function setLeadStatus(bookingId: string, status: LeadBoardStatus, actor?: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO lead_status (booking_id, status, updated_at, updated_by) VALUES (?,?,?,?)
       ON CONFLICT(booking_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(bookingId, status, new Date().toISOString(), actor ?? null);
}

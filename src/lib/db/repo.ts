// Typed data access over the SQLite DB. All server-side reads/writes for routes,
// stops, events, messages, exceptions, audit, and tracking links go through here.

import { randomUUID } from "node:crypto";
import { getDb } from "./index";
import { logChange } from "@/lib/history/store";
import type { Route, RouteStatus, Stop, StopState } from "@/lib/types";

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
  };
}

/** Upsert bookings (from a searchProjects pull), keyed by Goodshuffle project id. Logs a
 *  financial-plan change to Operational History when an existing booking's revenue changes. */
export function saveBookings(items: BookingRecord[]): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Prior revenue per booking, for change detection (MVP4 P3).
  const prior = new Map<string, number | null>();
  const ids = items.map((i) => i.bookingId);
  if (ids.length > 0) {
    const ph = ids.map(() => "?").join(",");
    for (const r of db.prepare(`SELECT booking_id, grand_total FROM bookings WHERE booking_id IN (${ph})`).all(...ids) as {
      booking_id: string;
      grand_total: number | null;
    }[]) {
      prior.set(String(r.booking_id), r.grand_total == null ? null : Number(r.grand_total));
    }
  }

  const up = db.prepare(
    `INSERT INTO bookings (booking_id, event_name, event_date, status_label, signed, contract_total,
       grand_total, amount_paid, amount_due, client_name, client_email, updated_at)
     VALUES (@bookingId,@eventName,@eventDate,@statusLabel,@signed,@contractTotal,@grandTotal,
       @amountPaid,@amountDue,@clientName,@clientEmail,@now)
     ON CONFLICT(booking_id) DO UPDATE SET event_name=@eventName, event_date=@eventDate,
       status_label=@statusLabel, signed=@signed, contract_total=@contractTotal, grand_total=@grandTotal,
       amount_paid=@amountPaid, amount_due=@amountDue, client_name=@clientName, client_email=@clientEmail,
       updated_at=@now`,
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
        now,
      });
  });
  tx();

  // Log revenue changes on already-known bookings (financial-plan change).
  for (const i of items) {
    const before = prior.get(i.bookingId);
    const after = i.grandTotal ?? null;
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
  }
}

/** Booked events on/after `startYmd`, soonest first (the forward pipeline). Dated only. */
export function getUpcomingBookings(startYmd: string): BookingView[] {
  return (
    getDb()
      .prepare("SELECT * FROM bookings WHERE event_date IS NOT NULL AND event_date >= ? ORDER BY event_date ASC")
      .all(startYmd) as Record<string, unknown>[]
  ).map(toBookingView);
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
         AND LOWER(COALESCE(status_label,'')) NOT LIKE '%lost%'`,
    )
    .get(start, end) as { signed_total: number | null; signed_n: number; pipeline_total: number | null; pipeline_n: number };
  return {
    signed: row.signed_n > 0 ? row.signed_total : null,
    signedCount: row.signed_n,
    pipeline: row.pipeline_n > 0 ? row.pipeline_total : null,
    pipelineCount: row.pipeline_n,
  };
}

/** Per-booking rows dated in [start,end] (for the finance event table). */
export function getBookingsInRange(start: string, end: string): BookingView[] {
  return (
    getDb()
      .prepare("SELECT * FROM bookings WHERE event_date >= ? AND event_date <= ? ORDER BY event_date")
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

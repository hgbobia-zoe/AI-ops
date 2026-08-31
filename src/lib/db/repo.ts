// Typed data access over the SQLite DB. All server-side reads/writes for routes,
// stops, events, messages, exceptions, audit, and tracking links go through here.

import { randomUUID } from "node:crypto";
import { getDb } from "./index";
import type { Route, RouteStatus, Stop, StopState } from "@/lib/types";

interface StopRow {
  stop_id: string;
  route_id: string;
  customer_id: string | null;
  sequence: number;
  state: string;
  cust_name: string | null;
  cust_phone: string | null;
  address: string | null;
  day_of_name: string | null;
  day_of_phone: string | null;
  planned_window: string | null;
  eta: string | null;
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
  status: string;
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
    custPhone: r.cust_phone ?? "",
    address: r.address ?? "",
    dayOfName: r.day_of_name ?? undefined,
    dayOfPhone: r.day_of_phone ?? undefined,
    plannedWindow: r.planned_window ?? undefined,
    eta: r.eta ?? undefined,
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

/** The current route for a truck (latest), with its stops in order. */
export function getRoute(truckId: string): Route | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM routes WHERE truck_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(truckId) as RouteRow | undefined;
  if (!row) return null;
  const stops = (
    db
      .prepare("SELECT * FROM stops WHERE route_id = ? ORDER BY sequence")
      .all(row.route_id) as StopRow[]
  ).map(toStop);
  return {
    routeId: row.route_id,
    truckId: row.truck_id,
    date: row.date,
    driverId: row.driver_id ?? undefined,
    status: row.status as RouteStatus,
    stops,
  };
}

export function upsertRoute(r: {
  routeId: string;
  truckId: string;
  date: string;
  driverId?: string;
  status: RouteStatus;
}): void {
  getDb()
    .prepare(
      `INSERT INTO routes (route_id, truck_id, date, driver_id, status, updated_at)
       VALUES (@routeId, @truckId, @date, @driverId, @status, @now)
       ON CONFLICT(route_id) DO UPDATE SET
         truck_id=@truckId, date=@date, driver_id=@driverId, status=@status, updated_at=@now`,
    )
    .run({ ...r, driverId: r.driverId ?? null, now: new Date().toISOString() });
}

export function setRouteStatus(routeId: string, status: RouteStatus): void {
  getDb()
    .prepare("UPDATE routes SET status = ?, updated_at = ? WHERE route_id = ?")
    .run(status, new Date().toISOString(), routeId);
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
    });
    db.prepare("DELETE FROM stops WHERE route_id = ?").run(rt.routeId);
    const ins = db.prepare(
      `INSERT INTO stops (stop_id, route_id, customer_id, sequence, state, cust_name,
        cust_phone, address, day_of_name, day_of_phone, planned_window, eta, arrived_at,
        completed_at, tracking_token)
       VALUES (@stopId, @routeId, @customerId, @sequence, @state, @custName,
        @custPhone, @address, @dayOfName, @dayOfPhone, @plannedWindow, @eta, @arrivedAt,
        @completedAt, @trackingToken)`,
    );
    for (const s of rt.stops) {
      ins.run({
        stopId: s.stopId,
        routeId: rt.routeId,
        customerId: s.customerId ?? null,
        sequence: s.sequence,
        state: s.state,
        custName: s.custName ?? null,
        custPhone: s.custPhone ?? null,
        address: s.address ?? null,
        dayOfName: s.dayOfName ?? null,
        dayOfPhone: s.dayOfPhone ?? null,
        plannedWindow: s.plannedWindow ?? null,
        eta: s.eta ?? null,
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
}

/** Recent outbound messages, newest first — for the dispatch dashboard. */
export function getRecentMessages(limit = 40): MessageRow[] {
  const rows = getDb()
    .prepare(
      "SELECT to_phone, body, status, sent_at, stop_id FROM messages ORDER BY sent_at DESC LIMIT ?",
    )
    .all(limit) as {
    to_phone: string | null;
    body: string | null;
    status: string | null;
    sent_at: string;
    stop_id: string | null;
  }[];
  return rows.map((r) => ({
    toPhone: r.to_phone,
    body: r.body,
    status: r.status,
    sentAt: r.sent_at,
    stopId: r.stop_id,
  }));
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

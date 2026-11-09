// Dispatch progress → Goodshuffle route/stop status (the DISPATCH → GOODSHUFFLE direction of the sync).
//
// Goodshuffle tracks progress on its own routes: a route is SCHEDULED → IN_PROGRESS → COMPLETE and each
// stop (waypoint) is SCHEDULED → ARRIVED → COMPLETED (or SKIPPED). Until now every Goodshuffle route stayed
// SCHEDULED forever, because drivers work in Zoe. This mirrors what the driver (or the office) does in Zoe
// back onto the Goodshuffle route, so Goodshuffle's own route list shows the real state.
//
// The server can't call Goodshuffle (Cloudflare), so each change is queued as a `gs_status` op on the
// gs_outbox and the Auto-Pull extension replays it from a logged-in Goodshuffle tab:
//   POST /app/routing/updateWaypointStatus  { waypointID, status }
//   POST /app/routing/updateRoute           { routeID, routeName, color, notes, status }
// (both found in Goodshuffle's own routing app code, 2026-11-09). Goodshuffle's stop texts are OFF for Zoe,
// so a status change never texts a customer.
//
// Rules:
//   - Only stops/routes that came from a Goodshuffle pull (stop.txId + route.gsRouteId) are synced.
//   - One live op per stop and per route: a newer state REPLACES a still-pending op (latest wins), and a
//     state Goodshuffle already has from us is never re-sent.
//   - Never throws into the caller: a failure here must not fail a driver tap or a route close.
//   - Kill switch: GS_STATUS_SYNC=false (on by default, like every shipped feature).

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { getRouteById, getStop } from "@/lib/db/repo";
import { flagOn } from "@/lib/flags";
import type { StopState } from "@/lib/types";

export const GS_STATUS_OP = "gs_status";

export type GsWaypointStatus = "SCHEDULED" | "ARRIVED" | "COMPLETED" | "SKIPPED";
export type GsRouteStatus = "SCHEDULED" | "IN_PROGRESS" | "COMPLETE";

export interface GsStatusPayload {
  target: "waypoint" | "route";
  status: GsWaypointStatus | GsRouteStatus;
  /** Waypoint only: DROP_OFF | PICK_UP, so the drainer picks the right waypoint when a project has both legs on one route. */
  waypointType?: "DROP_OFF" | "PICK_UP";
}

export function gsStatusSyncEnabled(): boolean {
  return flagOn("GS_STATUS_SYNC");
}

/** Goodshuffle waypoint status for a Zoe stop state. null = no Goodshuffle equivalent (leave it alone). Pure. */
export function gsWaypointStatusFor(state: StopState): GsWaypointStatus | null {
  switch (state) {
    case "Arrived":
      return "ARRIVED";
    case "Completed":
    case "Returned":
      return "COMPLETED";
    case "Waiting":
      return "SCHEDULED"; // a reopened stop goes back to scheduled
    default:
      return null; // EnRoute / HeadingBack / Exception: Goodshuffle has no stop state for these
  }
}

/** What to do given the latest op already queued for this stop/route. Pure.
 *  - "update": a pending op exists, overwrite its status (latest wins, never two in flight).
 *  - "skip": nothing to send (Goodshuffle already has it from us, or it's a no-op first send).
 *  - "insert": queue a new op. */
export function decideGsStatusWrite(
  latest: { status: "pending" | "done" | "failed" | "dead"; sent: string } | null,
  next: string,
  opts: { noopFirst?: string[] } = {},
): "insert" | "update" | "skip" {
  if (!latest) return opts.noopFirst?.includes(next) ? "skip" : "insert";
  if (latest.status === "pending") return latest.sent === next ? "skip" : "update";
  if (latest.status === "done" && latest.sent === next) return "skip";
  return "insert";
}

interface OutboxRow {
  id: string;
  status: "pending" | "done" | "failed" | "dead";
  payload: string | null;
}

function latestOp(where: "stop" | "route", key: string): { id: string; status: OutboxRow["status"]; sent: string } | null {
  const col = where === "stop" ? "stop_id" : "route_id";
  const target = where === "stop" ? "waypoint" : "route";
  const row = getDb()
    .prepare(
      `SELECT id, status, payload FROM gs_outbox
        WHERE op = ? AND ${col} = ? AND json_extract(payload, '$.target') = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(GS_STATUS_OP, key, target) as OutboxRow | undefined;
  if (!row) return null;
  let sent = "";
  try {
    sent = String((JSON.parse(row.payload ?? "{}") as GsStatusPayload).status ?? "");
  } catch {
    /* unreadable payload: treat as nothing sent */
  }
  return { id: row.id, status: row.status, sent };
}

function write(
  decision: "insert" | "update" | "skip",
  latestId: string | undefined,
  row: { routeId: string; stopId?: string; gsRouteId: string; transactionId?: string; label: string; payload: GsStatusPayload },
): "queued" | "updated" | "skipped" {
  const now = new Date().toISOString();
  const db = getDb();
  if (decision === "skip") return "skipped";
  if (decision === "update" && latestId) {
    db.prepare(`UPDATE gs_outbox SET payload = ?, label = ?, updated_at = ? WHERE id = ? AND status = 'pending'`).run(
      JSON.stringify(row.payload),
      row.label,
      now,
      latestId,
    );
    return "updated";
  }
  db.prepare(
    `INSERT INTO gs_outbox (id, op, route_id, stop_id, gs_route_id, transaction_id, label, payload, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(
    `GO-${randomUUID()}`,
    GS_STATUS_OP,
    row.routeId,
    row.stopId ?? null,
    row.gsRouteId,
    row.transactionId ?? null,
    row.label,
    JSON.stringify(row.payload),
    now,
    now,
  );
  return "queued";
}

export type GsSyncResult = "queued" | "updated" | "skipped" | "no_ids" | "off" | "error";

/** Queue a Goodshuffle ROUTE status for one of our routes. `onlyIfSynced`: send only when we've already
 *  pushed a status for this route (a reopen should undo our COMPLETE, but never touch a route we never synced). */
export function syncGsRouteStatus(routeId: string, status: GsRouteStatus, opts: { onlyIfSynced?: boolean } = {}): GsSyncResult {
  try {
    if (!gsStatusSyncEnabled()) return "off";
    const route = getRouteById(routeId);
    if (!route?.gsRouteId) return "no_ids";
    const latest = latestOp("route", routeId);
    if (opts.onlyIfSynced && !latest) return "skipped";
    const decision = decideGsStatusWrite(latest, status, { noopFirst: ["SCHEDULED"] });
    const label = status === "COMPLETE" ? "Mark the Goodshuffle route complete" : status === "IN_PROGRESS" ? "Mark the Goodshuffle route in progress" : "Set the Goodshuffle route back to scheduled";
    return write(decision, latest?.id, { routeId, gsRouteId: route.gsRouteId, label, payload: { target: "route", status } });
  } catch (e) {
    console.error("[gsStatusSync] route status not queued (ignored):", e);
    return "error";
  }
}

/** Queue the Goodshuffle WAYPOINT status for a stop from its CURRENT state (read fresh from the DB), and mark
 *  the route in progress once any stop has moved off Waiting. Call after any stop state change. */
export function syncGsStopStatus(stopId: string): GsSyncResult {
  try {
    if (!gsStatusSyncEnabled()) return "off";
    const stop = getStop(stopId);
    if (!stop) return "skipped";
    const route = getRouteById(stop.routeId);
    if (!route?.gsRouteId || !stop.txId) return "no_ids";
    const status = gsWaypointStatusFor(stop.state);
    let result: GsSyncResult = "skipped";
    if (status) {
      const latest = latestOp("stop", stopId);
      const decision = decideGsStatusWrite(latest, status, { noopFirst: ["SCHEDULED"] });
      const who = stop.custName || "stop";
      const label =
        status === "COMPLETED" ? `Mark ${who} completed in Goodshuffle` : status === "ARRIVED" ? `Mark ${who} arrived in Goodshuffle` : `Set ${who} back to scheduled in Goodshuffle`;
      result = write(decision, latest?.id, {
        routeId: stop.routeId,
        stopId,
        gsRouteId: route.gsRouteId,
        transactionId: stop.txId,
        label,
        payload: { target: "waypoint", status, waypointType: stop.kind === "pickup" ? "PICK_UP" : stop.kind === "delivery" ? "DROP_OFF" : undefined },
      });
    }
    // The first stop leaving Waiting means the route has started.
    if (stop.state !== "Waiting" && route.status !== "done") syncGsRouteStatus(stop.routeId, "IN_PROGRESS");
    return result;
  } catch (e) {
    console.error("[gsStatusSync] stop status not queued (ignored):", e);
    return "error";
  }
}

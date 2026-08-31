// Action intake — the code backend (no Zapier). For each driver action it:
//   1. validates the transition against the shared state machine,
//   2. records the event in SQLite (idempotency key dedupes retries/double-taps),
//   3. updates the stop's state in the DB,
//   4. fires the fan-out (customer SMS, Slack, tracking links) — fire-and-forget,
//      so the tablet gets a fast 200 and never waits on downstream work.

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isSideAction, resolveTransition } from "@/lib/stateMachine";
import {
  advanceNextStop,
  getStop,
  insertEventIfNew,
  setStopProof,
  updateStopState,
} from "@/lib/db/repo";
import { runFanout } from "@/lib/notify/fanout";
import type { ActionRequest, ActionResponse, Stop } from "@/lib/types";

export async function POST(req: Request): Promise<NextResponse<ActionResponse>> {
  let body: ActionRequest;
  try {
    body = (await req.json()) as ActionRequest;
  } catch {
    return NextResponse.json({ accepted: false, error: "invalid_json" }, { status: 400 });
  }

  const { idempotencyKey, action, fromState, context } = body;
  if (!idempotencyKey || !action || !fromState || !body.stopId || !body.truckId) {
    return NextResponse.json({ accepted: false, error: "missing_fields" }, { status: 400 });
  }

  // Transition legality (side actions — message dispatch, fuel log — aren't transitions).
  const side = isSideAction(action);
  const toState = side ? fromState : resolveTransition(fromState, action, context);
  if (!side && !toState) {
    return NextResponse.json({ accepted: false, error: "invalid_transition" }, { status: 409 });
  }

  const eventId = `E-${randomUUID()}`;
  const isNew = insertEventIfNew({
    eventId,
    idempotencyKey,
    stopId: body.stopId,
    routeId: body.routeId,
    truckId: body.truckId,
    driverId: body.driverId,
    action,
    fromState,
    toState: toState ?? undefined,
    ts: body.clientTs || new Date().toISOString(),
    gps: body.gps,
    payload: body.payload,
  });

  if (!isNew) {
    // Idempotent replay — no state change, no re-send.
    return NextResponse.json({ accepted: true, eventId, duplicate: true, toState: toState ?? undefined });
  }

  const now = new Date().toISOString();
  const cur = getStop(body.stopId);
  let nextStop: Stop | null = null;

  if (!side && toState && cur) {
    if (action === "ARRIVED") {
      updateStopState(body.stopId, toState, { arrivedAt: now });
    } else if (toState === "Completed") {
      updateStopState(body.stopId, "Completed", { completedAt: now });
      // Persist proof of delivery captured at completion.
      const p = body.payload as { photoIds?: string[]; signatureId?: string } | undefined;
      if (p && (p.photoIds?.length || p.signatureId)) {
        setStopProof(body.stopId, { photoIds: p.photoIds, signatureId: p.signatureId });
      }
      if (action === "HEADING_NEXT") nextStop = advanceNextStop(body.routeId, cur.sequence);
    } else {
      updateStopState(body.stopId, toState);
    }
  }

  // Fan-out runs async; the response returns immediately.
  const baseUrl = process.env.PUBLIC_BASE_URL || new URL(req.url).origin;
  void runFanout({
    action,
    truckId: body.truckId,
    driverId: body.driverId,
    gps: body.gps,
    payload: body.payload,
    baseUrl,
    currentStop: cur,
    nextStop,
  });

  return NextResponse.json({ accepted: true, eventId, toState: toState ?? undefined });
}

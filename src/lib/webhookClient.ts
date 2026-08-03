// Client-side action dispatcher. Builds the one-action envelope, fires it at the
// intake, and — on network failure — queues it for replay. This is the ONLY place
// the tablet emits a side effect; everything else is display.

"use client";

import type {
  ActionRequest,
  ActionResponse,
  ActionType,
  GpsFix,
  StopState,
} from "./types";
import { enqueue, dequeue, queued } from "./offlineQueue";

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Best-effort GPS. MUST never block a driver's tap: a hard timer caps the wait
 * regardless of whether the browser's own geolocation timeout fires (some
 * browsers stall the callback while a permission prompt is open). Resolves
 * undefined rather than throwing.
 */
export function getGps(timeoutMs = 2500): Promise<GpsFix | undefined> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(undefined);
  }
  const geo = new Promise<GpsFix | undefined>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          ts: new Date().toISOString(),
        }),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
  const cap = new Promise<undefined>((resolve) =>
    setTimeout(() => resolve(undefined), timeoutMs),
  );
  return Promise.race([geo, cap]);
}

export interface BuildActionArgs {
  truckId: string;
  driverId?: string;
  routeId: string;
  stopId: string;
  action: ActionType;
  fromState: StopState;
  gps?: GpsFix;
  payload?: Record<string, unknown>;
  context?: ActionRequest["context"];
}

export function buildAction(args: BuildActionArgs): ActionRequest {
  return {
    idempotencyKey: uuid(),
    truckId: args.truckId,
    driverId: args.driverId,
    routeId: args.routeId,
    stopId: args.stopId,
    action: args.action,
    fromState: args.fromState,
    gps: args.gps,
    clientTs: new Date().toISOString(),
    payload: args.payload,
    context: args.context,
  };
}

async function post(req: ActionRequest): Promise<ActionResponse> {
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  return (await res.json()) as ActionResponse;
}

/**
 * Sends an action. On a network error the action is queued and a synthetic
 * "queued" response is returned so the optimistic UI can proceed; the real send
 * happens on the next flushQueue(). A 409 (invalid transition) is surfaced as-is.
 */
export async function sendAction(req: ActionRequest): Promise<ActionResponse> {
  try {
    const result = await post(req);
    return result;
  } catch {
    enqueue(req);
    return { accepted: true, error: "queued_offline" };
  }
}

/** Attempts to resend every queued action. Safe to call repeatedly (idempotent). */
export async function flushQueue(): Promise<number> {
  const items = queued();
  let sent = 0;
  for (const req of items) {
    try {
      const result = await post(req);
      if (result.accepted) {
        dequeue(req.idempotencyKey);
        sent++;
      }
    } catch {
      break; // still offline; stop and retry later
    }
  }
  return sent;
}

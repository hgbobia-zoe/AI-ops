// Thin intake — the "Claude where Zapier lacks" layer.
//
// Responsibilities Zapier Catch Hooks can't cheaply do synchronously:
//   1. Validate the requested transition against the shared state machine.
//   2. Deduplicate on idempotency key (double-tap / offline replay).
//   3. HMAC-sign and forward the validated event to Zapier for async fan-out.
//   4. Return a fast 200 so the tablet never waits on downstream automations.
//
// If ZAPIER_FORWARD_URL is unset, the action is accepted and logged but not
// forwarded — so the entire UI is exercisable before Zapier is wired up.

import { createHmac, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { serverConfig } from "@/lib/config";
import { resolveTransition } from "@/lib/stateMachine";
import type { ActionRequest, ActionResponse } from "@/lib/types";

// In-memory idempotency cache. Adequate for a single serverless instance in v1;
// the authoritative dedupe lives in the Zapier `Events` table (unique key).
const seen = new Map<string, string>(); // idempotencyKey -> eventId
const SEEN_MAX = 5000;

function remember(key: string, eventId: string) {
  if (seen.size >= SEEN_MAX) {
    const oldest = seen.keys().next().value;
    if (oldest) seen.delete(oldest);
  }
  seen.set(key, eventId);
}

export async function POST(req: Request): Promise<NextResponse<ActionResponse>> {
  let body: ActionRequest;
  try {
    body = (await req.json()) as ActionRequest;
  } catch {
    return NextResponse.json(
      { accepted: false, error: "invalid_json" },
      { status: 400 },
    );
  }

  const { idempotencyKey, action, fromState, context } = body;
  if (!idempotencyKey || !action || !fromState || !body.stopId || !body.truckId) {
    return NextResponse.json(
      { accepted: false, error: "missing_fields" },
      { status: 400 },
    );
  }

  // 1. Idempotent replay → return the original result, no side effects.
  const prior = seen.get(idempotencyKey);
  if (prior) {
    return NextResponse.json({
      accepted: true,
      eventId: prior,
      duplicate: true,
      toState: resolveTransition(fromState, action, context) ?? undefined,
    });
  }

  // 2. Transition legality (server-side guard, not just the client map).
  const toState = resolveTransition(fromState, action, context);
  if (!toState) {
    return NextResponse.json(
      { accepted: false, error: "invalid_transition" },
      { status: 409 },
    );
  }

  const eventId = `E-${randomUUID()}`;
  remember(idempotencyKey, eventId);

  // 3. Forward the validated event to Zapier for async fan-out (fire-and-forget
  //    but awaited briefly so we can report obvious failures; downstream work
  //    stays async inside Zapier).
  const forwardUrl = serverConfig.zapierForwardUrl();
  if (forwardUrl) {
    const envelope = JSON.stringify({ ...body, eventId, toState, serverTs: new Date().toISOString() });
    const secret = serverConfig.webhookSecret();
    const signature = secret
      ? createHmac("sha256", secret).update(envelope).digest("hex")
      : undefined;
    try {
      await fetch(forwardUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signature ? { "x-signature": signature } : {}),
        },
        body: envelope,
      });
    } catch (err) {
      // The tablet still gets a 200 (the event is recorded locally); Zapier
      // failures surface via AutomationLogs / Slack, not by blocking the driver.
      console.error("[intake] forward to Zapier failed", err);
    }
  } else {
    console.log("[intake] accepted (no ZAPIER_FORWARD_URL set)", {
      eventId,
      action,
      fromState,
      toState,
    });
  }

  return NextResponse.json({ accepted: true, eventId, toState });
}

// Queue a delivery-fee override to Goodshuffle. The calculator sends the project id + the computed
// PER-LEG fee; we enqueue a `set_delivery_fee` gs_outbox op that the logged-in Auto-Pull session drains
// (it finds the project's Standard Delivery line(s) and overrides their price). Owner/Admin gated by the
// proxy (/api/pricing is not public); the actual Goodshuffle write happens in the pull, never here.
//
// The write is applied ON DEMAND: after queuing, the calculator pokes the office-machine extension
// ({type:"zoe-drain-now"}) to drain immediately instead of waiting for the next read-pull. The op's real
// status is pollable via GET ?opId=… so the UI shows honest "Pushing… → Pushed" state (never a flat
// "queued" with no resolution).

import { NextResponse } from "next/server";
import { enqueueGsOp, getBookingById, pendingDeliveryFeeOp, getGsOpStatus } from "@/lib/db/repo";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  // `amount` is the ONE per-leg price the drainer writes on every delivery leg line. When the legs differ
  // (each is anchored on its own day) the calculator sends their average, so the round trip total matches;
  // `legs` records the real per-leg fees on the op for the audit trail (the drainer ignores it).
  let body: { projectId?: string; amount?: number; legs?: { dropOff?: number | null; pickup?: number | null } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const projectId = (body.projectId ?? "").trim();
  const amount = Number(body.amount);
  if (!projectId) return NextResponse.json({ error: "project_required" }, { status: 400 });
  if (!Number.isFinite(amount) || amount < 0) return NextResponse.json({ error: "bad_amount" }, { status: 400 });

  const rounded = Math.round(amount * 100) / 100;
  const legFee = (n: unknown): number | null => (n != null && Number.isFinite(Number(n)) && Number(n) >= 0 ? Math.round(Number(n) * 100) / 100 : null);
  const legs =
    body.legs && (legFee(body.legs.dropOff) != null || legFee(body.legs.pickup) != null)
      ? { dropOff: legFee(body.legs.dropOff), pickup: legFee(body.legs.pickup) }
      : null;

  // Idempotency: a double-click / re-push / on-demand re-nudge of the SAME fee must not queue a second op
  // while the first is still pending. Reuse the existing pending op (return its id so the UI keeps polling).
  const existing = pendingDeliveryFeeOp(projectId, rounded);
  if (existing) {
    return NextResponse.json({ ok: true, queued: true, opId: existing.id, deduped: true });
  }

  const booking = getBookingById(projectId);
  const label = booking?.eventName || booking?.clientName || `#${projectId}`;
  const actor = await currentActor();

  const op = enqueueGsOp({
    op: "set_delivery_fee",
    transactionId: projectId,
    label: `delivery fee $${rounded.toFixed(2)} → ${label}`,
    payload: { amount: rounded, by: actor.label, ...(legs ? { legs } : {}) },
  });

  return NextResponse.json({ ok: true, queued: true, opId: op.id });
}

// Poll a queued push's real status so the calculator can resolve "Pushing…" → "Pushed ✓" (or surface a
// failure / still-waiting state). Returns { status: 'pending'|'done'|'failed'|'unknown', error? }.
export async function GET(req: Request): Promise<NextResponse> {
  const opId = new URL(req.url).searchParams.get("opId")?.trim();
  if (!opId) return NextResponse.json({ error: "opId_required" }, { status: 400 });
  const st = getGsOpStatus(opId);
  if (!st) return NextResponse.json({ status: "unknown" });
  return NextResponse.json({ status: st.status, error: st.lastError });
}

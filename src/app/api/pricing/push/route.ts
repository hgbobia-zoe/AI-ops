// Queue a delivery-fee override to Goodshuffle. The calculator sends the project id + the computed
// PER-LEG fee; we enqueue a `set_delivery_fee` gs_outbox op that the logged-in Auto-Pull session drains
// (it finds the project's Standard Delivery line(s) and overrides their price). Owner/Admin gated by the
// proxy (/api/pricing is not public); the actual Goodshuffle write happens in the pull, never here.

import { NextResponse } from "next/server";
import { enqueueGsOp, getBookingById } from "@/lib/db/repo";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { projectId?: string; amount?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const projectId = (body.projectId ?? "").trim();
  const amount = Number(body.amount);
  if (!projectId) return NextResponse.json({ error: "project_required" }, { status: 400 });
  if (!Number.isFinite(amount) || amount < 0) return NextResponse.json({ error: "bad_amount" }, { status: 400 });

  const booking = getBookingById(projectId);
  const label = booking?.eventName || booking?.clientName || `#${projectId}`;
  const actor = await currentActor();

  enqueueGsOp({
    op: "set_delivery_fee",
    transactionId: projectId,
    label: `delivery fee $${amount.toFixed(2)} → ${label}`,
    payload: { amount: Math.round(amount * 100) / 100, by: actor.label },
  });

  return NextResponse.json({ ok: true, queued: true });
}

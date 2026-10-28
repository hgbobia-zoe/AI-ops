// POST /api/payroll/rate-sync — approve ONE Gusto→Connecteam rate proposal: write the authoritative Gusto
// hourly rate into Connecteam. Owner/admin. This WRITES to the system that funds payroll, so it happens only
// on this explicit per-proposal approval (never automatically). The engine audits the write + surfaces a
// missing pay_rates.write scope honestly. Idempotent at the engine level (a rate already in sync yields no
// proposal to approve).

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { approveRateSyncProposal } from "@/lib/payroll/rateSync";

export const dynamic = "force-dynamic";

interface Body {
  connecteamUserId?: number;
  gustoRate?: number;
  effectiveDate?: string;
  name?: string | null;
}

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Body;
  if (typeof b.connecteamUserId !== "number" || !(typeof b.gustoRate === "number" && b.gustoRate >= 0)) {
    return NextResponse.json({ error: "connecteamUserId and a non-negative gustoRate are required" }, { status: 400 });
  }
  const effectiveDate = (b.effectiveDate ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  const actor = await currentActor();
  const r = await approveRateSyncProposal({
    connecteamUserId: b.connecteamUserId,
    gustoRate: b.gustoRate,
    effectiveDate,
    actor: actor.label,
    name: b.name ?? null,
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  return NextResponse.json({ ok: true, connecteamUserId: r.connecteamUserId, gustoRate: r.gustoRate, effectiveDate });
}

// POST /api/payroll/approve — the human approval checkpoint (spec §9). Approves the workers that the UNIFIED
// readiness model says are approvable for the period, so this server gate matches exactly what the UI offers
// and cannot be bypassed. The unified model reconciles review + readiness, so approval honors the SOURCE
// timesheet-approval gate too (not just Gusto mapping). Records WHO/WHEN/WHAT. Owner/admin; proxy also gates.
//
// Gating (cannot be bypassed from the client):
//   • UNAVAILABLE time source       → refused (never approve on unverified/stale hours).
//   • Hard blockers (unmapped/dup)  → those workers are excluded from the run (never approved).
//   • Unapproved / unverified source timesheets → those workers are EXCLUDED unless the caller sends an
//     explicit `acknowledge:true`, which is recorded in the approval snapshot + audit (never silent).

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { commandCenter } from "@/lib/command/service";
import { resolvePeriod, namedPeriod, completedWeeksBack } from "@/lib/payroll/period";
import { derivePayrollReadiness, payrollApprovability } from "@/lib/payroll/readinessModel";
import { upsertApproval } from "@/lib/payroll/store";

export const dynamic = "force-dynamic";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Payroll targets a COMPLETED week: the UI sends the exact period (start/end). `which` is a back-compat alias;
  // with nothing given we default to the last completed week (never the in-progress one).
  const body = (await req.json().catch(() => ({}))) as { which?: "current" | "previous"; start?: string; end?: string; acknowledge?: boolean };
  const today = await safeToday();
  const period =
    body.start && body.end
      ? resolvePeriod(today, body.start, body.end)
      : body.which === "current" || body.which === "previous"
        ? namedPeriod(today, body.which)
        : completedWeeksBack(today, 1);

  const model = await derivePayrollReadiness(period);
  const acknowledge = body.acknowledge === true;
  const appr = payrollApprovability(model, acknowledge);

  // Hard stop: never approve on an unavailable/unverified time source.
  if (appr.unavailable) {
    return NextResponse.json({ error: "Connecteam is unavailable — hours can't be verified, so payroll can't be approved. Retry the sync first." }, { status: 409 });
  }
  // The only approvable workers are held by the source-approval gate, and the caller did not acknowledge it.
  if (appr.readyKeys.length === 0 && appr.needsAck && !acknowledge) {
    return NextResponse.json({
      error: `No worker is fully verified. ${appr.ackReason} Re-submit with acknowledgement to approve the unverified timesheets, or approve them in Connecteam first.`,
      requiresAck: true, acknowledgeable: appr.acknowledgeableKeys.length, reason: appr.ackReason,
    }, { status: 409 });
  }
  if (appr.approvableKeys.length === 0) {
    return NextResponse.json({ error: "Nothing is ready to approve — resolve blockers and review items first." }, { status: 409 });
  }

  const approvedSet = new Set(appr.approvableKeys);
  const approvedWorkers = model.workers.filter((w) => approvedSet.has(w.key));
  const estApproved = approvedWorkers.some((w) => w.estPay != null)
    ? round2(approvedWorkers.reduce((s, w) => s + (w.estPay ?? 0), 0))
    : null;
  const ackedCount = acknowledge ? appr.acknowledgeableKeys.filter((k) => approvedSet.has(k)).length : 0;

  const actor = await currentActor();
  const approval = upsertApproval({
    periodStart: period.start, periodEnd: period.end, status: "APPROVED",
    approvedBy: actor.label, approvedAt: new Date().toISOString(),
    readyWorkerCount: approvedWorkers.length, estApprovedAmount: estApproved,
    snapshot: {
      approvedKeys: appr.approvableKeys,
      acknowledgedUnverified: ackedCount,
      excluded: { blocked: model.counts.blocked, actionRequired: model.counts.actionRequired, unverified: model.counts.unverified },
    },
  });

  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({
      actor: actor.label, action: "payroll.approve", entity: "hr_payroll_approval", entityId: `${period.start}..${period.end}`,
      after: { readyWorkers: approvedWorkers.length, estApproved, acknowledgedUnverified: ackedCount, excludedBlocked: model.counts.blocked },
    });
  } catch {
    /* audit is best-effort */
  }

  return NextResponse.json({ period, approval, readyCount: approvedWorkers.length, estReady: estApproved, acknowledgedUnverified: ackedCount });
}

async function safeToday(): Promise<string> {
  try {
    return (await commandCenter()).today;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

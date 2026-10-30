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
import { finalizeApprovedTimesheets, unlockApprovedTimesheets, type LockTarget } from "@/lib/payroll/timesheetLock";

export const dynamic = "force-dynamic";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Payroll targets a COMPLETED week: the UI sends the exact period (start/end). `which` is a back-compat alias;
  // with nothing given we default to the last completed week (never the in-progress one).
  const body = (await req.json().catch(() => ({}))) as { which?: "current" | "previous"; start?: string; end?: string; acknowledge?: boolean; action?: "approve" | "unapprove"; workerKeys?: string[] };
  const today = await safeToday();
  const period =
    body.start && body.end
      ? resolvePeriod(today, body.start, body.end)
      : body.which === "current" || body.which === "previous"
        ? namedPeriod(today, body.which)
        : completedWeeksBack(today, 1);

  // ── UNAPPROVE: revert the Zoe sign-off AND unlock the finalized days in Connecteam (tolerating a 409 when a
  // day sits inside an already-approved Connecteam payroll period — surfaced, never crashed). Reversible. ──
  if (body.action === "unapprove") {
    const actor = await currentActor();
    const unlock = await unlockApprovedTimesheets(period);
    upsertApproval({ periodStart: period.start, periodEnd: period.end, status: "DRAFT", approvedBy: null, approvedAt: null, readyWorkerCount: null, estApprovedAmount: null, snapshot: { unapprovedBy: actor.label, unapprovedAt: new Date().toISOString(), unlocked: unlock.unlocked, lockConflicts: unlock.conflicts } });
    try {
      const { insertAudit } = await import("@/lib/db/repo");
      insertAudit({ actor: actor.label, action: "payroll.unapprove", entity: "hr_payroll_approval", entityId: `${period.start}..${period.end}`, after: { unlocked: unlock.unlocked, lockConflicts: unlock.conflicts } });
    } catch { /* audit is best-effort */ }
    return NextResponse.json({ period, status: "DRAFT", unlock });
  }

  const model = await derivePayrollReadiness(period);
  const acknowledge = body.acknowledge === true;
  const appr = payrollApprovability(model, acknowledge);

  // Hard stop: never approve on an unavailable/unverified time source.
  if (appr.unavailable) {
    return NextResponse.json({ error: "Connecteam is unavailable — hours can't be verified, so payroll can't be approved. Retry the sync first." }, { status: 409 });
  }

  // ── PER-WORKER APPROVE (from the in-app Timesheet Review): approve + finalize JUST the requested workers,
  // scoped to the SAME approvability gate (a blocked/review-held worker can never be approved this way). This
  // writes each worker's lock record, which clears THEIR source-timesheet gate independently — exactly the
  // readiness model's per-worker-lock semantics. It deliberately does NOT record the period-level Zoe sign-off
  // (that is the explicit bulk "Approve" + the run-payroll gate); it only finalizes the reviewed worker(s). ──
  if (Array.isArray(body.workerKeys) && body.workerKeys.length > 0) {
    const requested = new Set(body.workerKeys);
    const scoped = appr.approvableKeys.filter((k) => requested.has(k));
    if (scoped.length === 0) {
      return NextResponse.json({
        error: appr.needsAck && !acknowledge
          ? `That worker is held by the source-timesheet gate. ${appr.ackReason ?? ""} Re-submit with acknowledgement to approve it.`
          : "That worker isn't approvable. Resolve its blockers or review items first.",
        requiresAck: appr.needsAck && !acknowledge,
      }, { status: 409 });
    }
    const scopedSet = new Set(scoped);
    const targets: LockTarget[] = model.workers
      .filter((w) => scopedSet.has(w.key))
      .map((w) => ({ workerKey: w.key, name: w.name, connecteamUserId: w.connecteamUserId }));
    const actor = await currentActor();
    const finalize = await finalizeApprovedTimesheets(period, targets, actor.label);
    try {
      const { insertAudit } = await import("@/lib/db/repo");
      insertAudit({
        actor: actor.label, action: "payroll.worker.approve", entity: "hr_payroll_ct_locks", entityId: `${period.start}..${period.end}`,
        after: { workers: targets.map((t) => t.name), ctLocked: finalize.locked, ctLockFailed: finalize.failed, ctNothingToLock: finalize.na },
      });
    } catch { /* audit is best-effort */ }
    return NextResponse.json({ period, approvedKeys: scoped, finalize });
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

  // FINALIZE IN CONNECTEAM: approving in the app locks each approved worker's worked days in Connecteam (the
  // only finalization write it exposes), which clears the "Unapproved timesheet" blocker — the owner's intent
  // of managing payroll from one place. Honest: each worker's outcome (locked / failed / nothing-to-lock) is
  // recorded so the gate is satisfied by the REAL recorded Zoe approval and the UI shows the true result. A
  // Connecteam failure NEVER blocks the approval (the sign-off stands); it surfaces as a retryable warning.
  const lockTargets: LockTarget[] = approvedWorkers.map((w) => ({ workerKey: w.key, name: w.name, connecteamUserId: w.connecteamUserId }));
  const finalize = await finalizeApprovedTimesheets(period, lockTargets, actor.label);

  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({
      actor: actor.label, action: "payroll.approve", entity: "hr_payroll_approval", entityId: `${period.start}..${period.end}`,
      after: { readyWorkers: approvedWorkers.length, estApproved, acknowledgedUnverified: ackedCount, excludedBlocked: model.counts.blocked, ctLocked: finalize.locked, ctLockFailed: finalize.failed, ctNothingToLock: finalize.na },
    });
  } catch {
    /* audit is best-effort */
  }

  return NextResponse.json({ period, approval, readyCount: approvedWorkers.length, estReady: estApproved, acknowledgedUnverified: ackedCount, finalize });
}

async function safeToday(): Promise<string> {
  try {
    return (await commandCenter()).today;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// POST /api/payroll/approve — the human approval checkpoint (spec §9). Approves the READY records for a pay
// period; REQUIRES_REVIEW and BLOCKED workers are excluded (not paid until resolved). Records WHO/WHEN/WHAT.
// Gusto push (a later slice) is gated on this APPROVED state. Owner/admin only; the proxy also gates /api/payroll.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { commandCenter } from "@/lib/command/service";
import { namedPeriod } from "@/lib/payroll/period";
import { payrollReview } from "@/lib/payroll/review";
import { upsertApproval } from "@/lib/payroll/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { which?: "current" | "previous" };
  const today = await safeToday();
  const period = namedPeriod(today, body.which === "previous" ? "previous" : "current");

  const rv = await payrollReview(period);
  if (rv.counts.ready === 0) {
    return NextResponse.json({ error: "Nothing is ready to approve — resolve blockers/review items first." }, { status: 409 });
  }

  const actor = await currentActor();
  const approval = upsertApproval({
    periodStart: period.start, periodEnd: period.end, status: "APPROVED",
    approvedBy: actor.label, approvedAt: new Date().toISOString(),
    readyWorkerCount: rv.counts.ready, estApprovedAmount: rv.estReadyPayroll,
    snapshot: { readyKeys: rv.ready.map((w) => w.key), excluded: { requiresReview: rv.counts.review, blocked: rv.counts.blocked } },
  });

  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({
      actor: actor.label, action: "payroll.approve", entity: "hr_payroll_approval", entityId: `${period.start}..${period.end}`,
      after: { readyWorkers: rv.counts.ready, estApproved: rv.estReadyPayroll, excludedBlocked: rv.counts.blocked, excludedReview: rv.counts.review },
    });
  } catch {
    /* audit is best-effort */
  }

  return NextResponse.json({ period, approval, readyCount: rv.counts.ready, estReady: rv.estReadyPayroll });
}

async function safeToday(): Promise<string> {
  try {
    return (await commandCenter()).today;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

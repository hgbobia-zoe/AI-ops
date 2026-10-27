// Gusto remote-browser push — the /payroll "Gusto Console" app API (owner/admin only; the proxy also gates
// /api/payroll). GET returns whether the office runner is configured, the kill-switch state, and the latest
// job (the pane follows it + polls for live frames). POST builds the DRAFT push payload with the SAME
// owner/admin-gated builder as the extension path (buildPushEntries over the deterministic review) and records
// an approved job for the office runner to execute — the browser never computes hours. This endpoint NEVER
// calls Gusto; the runner does the DRAFT-only write and streams the result back.

import { NextResponse } from "next/server";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { commandCenter } from "@/lib/command/service";
import { namedPeriod } from "@/lib/payroll/period";
import { payrollReview } from "@/lib/payroll/review";
import { unifiedWorkers } from "@/lib/payroll/workers";
import { getPayrollConfig } from "@/lib/payroll/config";
import { buildPushEntries } from "@/lib/payroll/gustoPush";
import { gustoPushDisabled } from "@/lib/payroll/gustoPushState";
import { gustoRunnerConfigured } from "@/lib/payroll/gustoRunnerAuth";
import { createJob, latestJob, hasActiveJob } from "@/lib/payroll/gustoRunnerJobs";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({
    runnerConfigured: gustoRunnerConfigured(),
    disabled: gustoPushDisabled(),
    job: latestJob(),
  });
}

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (gustoPushDisabled()) {
    return NextResponse.json({ error: "Gusto push is disabled (GUSTO_PUSH_DISABLED).", disabled: true }, { status: 409 });
  }
  if (!gustoRunnerConfigured()) {
    return NextResponse.json({ error: "The office runner isn't set up yet (GUSTO_RUNNER_TOKEN unset).", unconfigured: true }, { status: 409 });
  }
  // One push at a time — a job in flight must finish (or be canceled) before another starts.
  if (hasActiveJob()) {
    return NextResponse.json({ error: "A push is already in progress.", busy: true }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as { which?: "current" | "previous" };
  const which = body.which === "previous" ? "previous" : "current";
  const today = await safeToday();
  const period = namedPeriod(today, which);

  const overtimeThreshold = getPayrollConfig().overtimeThreshold;
  const [review, { workers: unified }] = await Promise.all([payrollReview(period), unifiedWorkers(period)]);
  const built = buildPushEntries(review.workers, unified, overtimeThreshold);

  if (built.mappedCount === 0) {
    return NextResponse.json(
      { error: "No mapped, unblocked workers with hours to push.", mappedCount: 0, skipped: built.skipped },
      { status: 409 },
    );
  }

  const actor = await currentActor();
  const job = createJob({
    which,
    entries: built.entries,
    period: { start: period.start, end: period.end, label: period.label },
    requester: actor.label,
  });
  if (!job) return NextResponse.json({ error: "Could not queue the push." }, { status: 500 });

  return NextResponse.json({
    ok: true,
    job,
    mappedCount: built.mappedCount,
    skipped: built.skipped,
    totals: { regular: built.totalRegular, overtime: built.totalOvertime },
  });
}

async function safeToday(): Promise<string> {
  try {
    return (await commandCenter()).today;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Payroll Command Center — "Is payroll ready?" in one computed object. RULES CALCULATE: every number here
// is derived deterministically from real data (Connecteam hours/rates, stored workers, the sync ledger) or
// is null when its source is unavailable. The AI layer (later) only INTERPRETS this; it never recomputes it.

import { unifiedWorkers, workerCounts } from "./workers";
import { countOpenExceptions, latestSyncRun, getApproval } from "./store";
import { gustoConfigured } from "./gusto";
import { instaworkTempPay } from "./instawork";
import { classifyReview } from "./review";
import { getPayrollConfig, scheduleLabel } from "./config";
import type { PayPeriod, PayrollOverview, PayrollStatus, UnifiedWorker } from "./types";

export async function payrollOverview(period: PayPeriod): Promise<PayrollOverview> {
  const { workers, connecteamOk } = await unifiedWorkers(period);
  const counts = workerCounts(workers);
  const active = workers.filter((w) => w.active);

  // Deterministic payroll-readiness classification (the taxonomy that drives "Can I approve payroll?").
  const cfg = getPayrollConfig();
  const rv = classifyReview(period, workers, connecteamOk, { overtimeThreshold: cfg.overtimeThreshold });
  const approval = getApproval(period.start, period.end);

  // Total hours — only when the time source answered; otherwise UNVERIFIED (null), never a fabricated 0.
  const totalHours = connecteamOk
    ? Math.round(active.reduce((s, w) => s + (w.periodHours ?? 0), 0) * 10) / 10
    : null;

  // Estimated labor (USD) — sum hours × rate for USD workers with a known rate. `partial` flags that some
  // worked hours couldn't be costed (missing rate or non-USD currency), so the figure is a floor.
  let amount = 0;
  let partial = false;
  let anyCosted = false;
  for (const w of active) {
    const h = w.periodHours ?? 0;
    if (h <= 0) continue;
    if (w.currency === "USD" && w.payRate != null) {
      amount += h * w.payRate;
      anyCosted = true;
    } else {
      partial = true; // worked, but not costable in USD here
    }
  }
  const estimatedLabor = {
    amount: connecteamOk && anyCosted ? Math.round(amount) : null,
    currency: "USD",
    partial: partial || !connecteamOk,
  };

  // Unmatched = active workers who worked this period but have no Gusto mapping (can't be paid through Gusto).
  const unmatchedWorkers = active.filter((w) => (w.periodHours ?? 0) > 0 && !w.gustoMapped).length;

  // Instawork temps — separate labor-cost line (paid via Instawork, never in the Gusto run).
  const temp = await instaworkTempPay(period);
  const tempAmount = temp.totalActualCost ?? temp.totalEstCost ?? null;
  const tempLabor = {
    amount: tempAmount,
    basis: (temp.totalActualCost != null ? "actual" : temp.totalEstCost != null ? "estimated" : "none") as "actual" | "estimated" | "none",
    hours: temp.totalHours,
  };

  const exceptions = countOpenExceptions();
  const last = latestSyncRun();
  const lastSync = last ? { at: last.finishedAt ?? last.startedAt, status: last.status, trigger: last.trigger } : null;

  // Top-line status mirrors the review classification (the approval state is surfaced separately).
  const status: PayrollStatus =
    rv.status === "NO_DATA" ? "NO_DATA"
      : rv.status === "BLOCKED" ? "NOT_READY"
        : rv.status === "REQUIRES_REVIEW" ? "REQUIRES_REVIEW"
          : "READY_FOR_REVIEW";

  return {
    period,
    totalHours,
    connecteamOk,
    estimatedLabor,
    workers: counts.total,
    employees: counts.employees,
    contractors: counts.contractors,
    internationalContractors: counts.international,
    exceptions,
    unmatchedWorkers,
    lastSync,
    nextAutomaticSync: cfg.autoSyncEnabled ? scheduleLabel(cfg) : null,
    status,
    gustoConfigured: gustoConfigured(),
    tempLabor,
    review: {
      status: rv.status,
      workers: rv.counts.workers,
      hours: rv.hours,
      ready: rv.counts.ready,
      requiresReview: rv.counts.review,
      blocked: rv.counts.blocked,
      blockingIssues: rv.blockingIssues,
      exceptions: rv.exceptions,
      missingConfig: rv.missingConfig,
      estReady: rv.estReadyPayroll,
      estBlocked: rv.estBlockedPayroll,
    },
    approvalStatus: approval?.status ?? null,
  };
}

export type { UnifiedWorker };

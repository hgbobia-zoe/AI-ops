// Payroll Review — the deterministic classification that answers "Can I approve payroll?" RULES CALCULATE:
// every status + total here is computed from real worker/hours/rate/mapping data, never fabricated and never
// AI-decided. Each worker being paid this period is READY, REQUIRES_REVIEW, or BLOCKED, and each issue is
// tagged BLOCKING / EXCEPTION / MISSING_CONFIG so the Overview never conflates "needs review" with
// "0 exceptions" (spec §3).

import { unifiedWorkers } from "./workers";
import { getPayrollConfig } from "./config";
import type { IssueTag, PayPeriod, PayrollReviewResult, ReviewStatus, ReviewWorker, UnifiedWorker } from "./types";

export interface ReviewOptions {
  overtimeThreshold: number; // weekly hours above which overtime is flagged (EXCEPTION)
}
export const DEFAULT_REVIEW_OPTIONS: ReviewOptions = { overtimeThreshold: 40 };

const round2 = (n: number): number => Math.round(n * 100) / 100;
const sumOr = (vals: (number | null)[]): number | null => (vals.some((v) => v != null) ? round2(vals.reduce<number>((s, v) => s + (v ?? 0), 0)) : null);

/** Classify one worker's payroll readiness from their facts. Pure + deterministic. */
export function classifyWorker(w: UnifiedWorker, opts: ReviewOptions): ReviewWorker {
  const hours = w.periodHours;
  const payRate = w.payRate;
  const estPay = hours != null && payRate != null && w.currency === "USD" ? round2(hours * payRate) : null;
  const issues: IssueTag[] = [];

  // BLOCKING — prevents payroll approval.
  if (!w.gustoMapped) issues.push({ kind: "BLOCKING", code: "NO_GUSTO_MAPPING", label: "No Gusto mapping" });
  if ((hours ?? 0) > 0 && payRate == null) issues.push({ kind: "BLOCKING", code: "NO_PAY_RATE", label: "Pay rate missing" });

  // MISSING_CONFIG — required setup incomplete (not itself a hard blocker, but needs attention).
  if (w.workerType === "UNKNOWN" || w.typeInferred) issues.push({ kind: "MISSING_CONFIG", code: "TYPE_UNCONFIRMED", label: "Worker type not confirmed" });
  if (w.workerType === "INTERNATIONAL_CONTRACTOR" && !w.country) issues.push({ kind: "MISSING_CONFIG", code: "COUNTRY_MISSING", label: "Country missing" });
  if (w.workerType === "INTERNATIONAL_CONTRACTOR" && !w.currency) issues.push({ kind: "MISSING_CONFIG", code: "CURRENCY_MISSING", label: "Currency missing" });

  // EXCEPTION — anomaly in otherwise valid data.
  if ((hours ?? 0) > opts.overtimeThreshold) issues.push({ kind: "EXCEPTION", code: "OVERTIME", label: `Overtime (> ${opts.overtimeThreshold}h)` });

  const hasBlocking = issues.some((i) => i.kind === "BLOCKING");
  const hasOther = issues.some((i) => i.kind !== "BLOCKING");
  const status: ReviewStatus = hasBlocking ? "BLOCKED" : hasOther ? "REQUIRES_REVIEW" : "READY";

  return {
    key: w.key, name: w.name, workerType: w.workerType, hours, payRate, currency: w.currency,
    estPay, mappingStatus: w.mappingStatus, status, issues,
  };
}

/** Classify a whole roster for a period (pure — takes already-fetched workers). */
export function classifyReview(period: PayPeriod, workers: UnifiedWorker[], connecteamOk: boolean, opts: ReviewOptions = DEFAULT_REVIEW_OPTIONS): PayrollReviewResult {
  // Only workers with actual hours this period are part of the payroll run.
  const paid = workers.filter((w) => w.active && (w.periodHours ?? 0) > 0).map((w) => classifyWorker(w, opts));

  const ready = paid.filter((w) => w.status === "READY");
  const review = paid.filter((w) => w.status === "REQUIRES_REVIEW");
  const blocked = paid.filter((w) => w.status === "BLOCKED");

  const blockingIssues = paid.reduce((n, w) => n + w.issues.filter((i) => i.kind === "BLOCKING").length, 0);
  const exceptions = paid.reduce((n, w) => n + w.issues.filter((i) => i.kind === "EXCEPTION").length, 0);
  const missingConfig = paid.reduce((n, w) => n + w.issues.filter((i) => i.kind === "MISSING_CONFIG").length, 0);

  const hours = connecteamOk ? round2(paid.reduce((s, w) => s + (w.hours ?? 0), 0)) : null;
  const status: ReviewStatus | "NO_DATA" =
    !connecteamOk || paid.length === 0 ? "NO_DATA" : blocked.length > 0 ? "BLOCKED" : review.length > 0 ? "REQUIRES_REVIEW" : "READY";

  return {
    period, workers: paid, ready, review, blocked,
    counts: { workers: paid.length, ready: ready.length, review: review.length, blocked: blocked.length },
    hours, blockingIssues, exceptions, missingConfig,
    estReadyPayroll: sumOr(ready.map((w) => w.estPay)),
    estReviewPayroll: sumOr(review.map((w) => w.estPay)),
    estBlockedPayroll: sumOr(blocked.map((w) => w.estPay)),
    status, connecteamOk,
  };
}

/** Fetch + classify for a period (the Review screen entry point). Uses the configured overtime threshold. */
export async function payrollReview(period: PayPeriod, opts?: ReviewOptions): Promise<PayrollReviewResult> {
  const { workers, connecteamOk } = await unifiedWorkers(period);
  const resolved = opts ?? { overtimeThreshold: getPayrollConfig().overtimeThreshold };
  return classifyReview(period, workers, connecteamOk, resolved);
}

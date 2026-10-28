// Payroll Review — the deterministic classification that answers "Can I approve payroll?" RULES CALCULATE:
// every status + total here is computed from real worker/hours/rate/mapping data, never fabricated and never
// AI-decided. Each worker being paid this period is READY, REQUIRES_REVIEW, or BLOCKED, and each issue is
// tagged BLOCKING / EXCEPTION / MISSING_CONFIG so the Overview never conflates "needs review" with
// "0 exceptions" (spec §3).

import { unifiedWorkers } from "./workers";
import { getPayrollConfig } from "./config";
import { listPeriodExclusions, type PeriodExclusion } from "./store";
import type { ExcludeMode, IssueTag, PayPeriod, PayrollReviewResult, ReviewStatus, ReviewWorker, UnifiedWorker } from "./types";

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
  if ((hours ?? 0) > 0 && payRate == null) issues.push({ kind: "BLOCKING", code: "NO_PAY_RATE", label: missingRateLabel(w) });

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
    recordId: w.recordId, connecteamUserId: w.connecteamUserId,
    rateSource: w.rateSource ?? null, gustoRate: w.gustoRate ?? null, gustoRateUnit: w.gustoRateUnit ?? null,
    connecteamRate: w.connecteamRate ?? null,
  };
}

/** The "pay rate missing" label, said in terms of WHERE it's missing from, so HR fixes the right system. */
function missingRateLabel(w: UnifiedWorker): string {
  // Gusto has a rate but it's a salary (non-hourly) — honest: we don't fabricate an hourly number.
  if (w.gustoRate != null && !(typeof w.gustoRateUnit === "string" && /hour/i.test(w.gustoRateUnit))) {
    return "Salaried in Gusto (no hourly rate)";
  }
  const inGusto = w.gustoRate != null;
  const inConnecteam = w.connecteamRate != null;
  if (!inGusto && !inConnecteam) return w.gustoMapped ? "Pay rate missing (not in Gusto or Connecteam)" : "Pay rate missing";
  if (!inGusto) return "Pay rate missing (not in Gusto)";
  return "Pay rate missing";
}

/** Classify a whole roster for a period (pure — takes already-fetched workers + any per-period skips). */
export function classifyReview(
  period: PayPeriod,
  workers: UnifiedWorker[],
  connecteamOk: boolean,
  opts: ReviewOptions = DEFAULT_REVIEW_OPTIONS,
  periodExclusions: Map<string, PeriodExclusion> = new Map(),
): PayrollReviewResult {
  // Candidates for the run = active workers with actual hours this period.
  const candidates = workers.filter((w) => w.active && (w.periodHours ?? 0) > 0);

  // EXCLUDED — pulled out of the run (permanent flag on the worker, OR a per-period skip). Not counted/gated.
  const excluded: ReviewWorker[] = [];
  const toClassify: UnifiedWorker[] = [];
  for (const w of candidates) {
    const mode: ExcludeMode | null = w.excluded ? "permanent" : periodExclusions.has(w.key) ? "period" : null;
    if (mode) {
      const rw = classifyWorker(w, opts);
      excluded.push({ ...rw, excludeMode: mode, excludeReason: mode === "permanent" ? w.excludeReason ?? null : periodExclusions.get(w.key)?.reason ?? null });
    } else {
      toClassify.push(w);
    }
  }

  const paid = toClassify.map((w) => classifyWorker(w, opts));

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
    excluded, excludedCount: excluded.length,
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
  const periodExclusions = listPeriodExclusions(period.start, period.end);
  return classifyReview(period, workers, connecteamOk, resolved, periodExclusions);
}

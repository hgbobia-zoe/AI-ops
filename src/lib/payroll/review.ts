// Payroll Review — the deterministic classification that answers "Can I approve payroll?" RULES CALCULATE:
// every status + total here is computed from real worker/hours/rate/mapping data, never fabricated and never
// AI-decided. Each worker being paid this period is READY, REQUIRES_REVIEW, or BLOCKED, and each issue is
// tagged BLOCKING / EXCEPTION / MISSING_CONFIG so the Overview never conflates "needs review" with
// "0 exceptions" (spec §3).

import { unifiedWorkers } from "./workers";
import { getPayrollConfig } from "./config";
import { listPeriodExclusions, listReviewAccepts, type PeriodExclusion, type ReviewAccept } from "./store";
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

  // BLOCKING — prevents payroll approval. Gusto mapping is the ONLY hard blocker: an unmapped worker cannot be
  // pushed into the Gusto draft at all, so the run would fail for them. (Map them, or exclude them.)
  if (!w.gustoMapped) issues.push({ kind: "BLOCKING", code: "NO_GUSTO_MAPPING", label: "No Gusto mapping" });

  // MISSING_CONFIG — needs attention but does NOT block the push. A missing PAY RATE is here, not in BLOCKING:
  // Gusto applies its own stored rate when the hours are pushed, so the app's rate only drives the ESTIMATE.
  if ((hours ?? 0) > 0 && payRate == null) issues.push({ kind: "MISSING_CONFIG", code: "NO_PAY_RATE", label: missingRateLabel(w) });
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
    gustoId: w.gustoId ?? null, country: w.country ?? null, payType: w.payType ?? null,
  };
}

/** The "no pay rate" note. This is NOT a blocker — Gusto pays its own rate on the push; the app rate only
 *  drives the estimate — so the label reassures rather than alarms, while staying honest about the salary case. */
function missingRateLabel(w: UnifiedWorker): string {
  // Gusto has a rate but it's a salary (non-hourly) — honest: we don't fabricate an hourly estimate.
  if (w.gustoRate != null && !(typeof w.gustoRateUnit === "string" && /hour/i.test(w.gustoRateUnit))) {
    return "Salaried in Gusto — hourly estimate n/a";
  }
  return "No rate for estimate — Gusto applies its own on the push";
}

/** Classify a whole roster for a period (pure — takes already-fetched workers + any per-period skips). */
export function classifyReview(
  period: PayPeriod,
  workers: UnifiedWorker[],
  connecteamOk: boolean,
  opts: ReviewOptions = DEFAULT_REVIEW_OPTIONS,
  periodExclusions: Map<string, PeriodExclusion> = new Map(),
  reviewAccepts: Map<string, ReviewAccept> = new Map(),
): PayrollReviewResult {
  // Candidates for the run = active workers with actual hours this period.
  const candidates = workers.filter((w) => w.active && (w.periodHours ?? 0) > 0);

  // EXCLUDED — pulled out of the run (permanent flag on the worker, OR a per-period skip). Not counted/gated.
  // Exclusion wins over a review accept — a worker who is both excluded and accepted stays excluded.
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

  // Classify, then PROMOTE accepted review workers to READY. A human reviewed a REQUIRES_REVIEW worker and
  // accepted them into this run, so they become pushable. GUARD: only a REQUIRES_REVIEW worker is ever
  // promoted — a BLOCKED (unmapped) worker is never accepted into the run (the push would fail for them),
  // and excluded workers were already pulled out above.
  const paid = toClassify.map((w) => {
    const rw = classifyWorker(w, opts);
    if (rw.status === "REQUIRES_REVIEW" && reviewAccepts.has(rw.key)) {
      return { ...rw, status: "READY" as ReviewStatus, accepted: true, acceptedBy: reviewAccepts.get(rw.key)?.acceptedBy ?? null };
    }
    return rw;
  });

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
  const reviewAccepts = listReviewAccepts(period.start, period.end);
  return classifyReview(period, workers, connecteamOk, resolved, periodExclusions, reviewAccepts);
}

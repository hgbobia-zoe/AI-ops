// Unified Payroll Readiness — the SINGLE authoritative snapshot the HR/Payroll blade renders. It composes
// the two deterministic engines into one reconciled answer so the Overview, Review, Exceptions, counts,
// badges and action gating can never disagree for the same (period, data snapshot):
//
//   • review.ts (classifyReview)  → Gusto-mapping blocker, rate/type setup gaps, overtime anomaly, the
//                                    per-period exclusions + review accepts (the Zoe checkpoint).
//   • readiness.ts (assessReadiness) → source TIMESHEET APPROVAL (Connecteam), open punches, schedule
//                                    discrepancies, duplicate Gusto mappings, stale/unavailable sources.
//
// WHY THIS EXISTS (the contradiction it fixes): those two engines answer DIFFERENT questions and were shown
// side-by-side unreconciled — one could read "Ready, 0 blocking" while the other read "Blocked, 8 blocking"
// for the same period, because review ignores Connecteam timesheet approval and readiness treats it (and,
// historically, a missing rate) as blocking. This model expresses payroll as a PIPELINE of explicitly
// labelled gates (hours → timesheet approval → Gusto mapping → Zoe review/approval → sent to Gusto); the
// overall status is the worst gate and the next action resolves the EARLIEST unsatisfied one. Nothing
// unknown / unavailable / stale / unverified is ever silently READY (spec §3/§4).
//
// RULES CALCULATE: every number here comes from the two engines (which read real Connecteam/Gusto facts) or
// is null when a source is unavailable. This module only RECONCILES + LABELS; it never recomputes hours,
// mutates data, or submits payroll.

import { payrollReview } from "./review";
import { assessReadiness } from "./readiness";
import { buildRateSyncPlan } from "./rateSync";
import { instaworkTempPay } from "./instawork";
import { gustoConfigured } from "./gusto";
import { readGustoSnapshot, gustoSnapshotFresh } from "./gustoSnapshot";
import { readGustoPushResult } from "./gustoPushState";
import { getPayrollConfig, payrollDeadlineLabel, precheckScheduleLabel, scheduleLabel } from "./config";
import { getApproval, latestSyncRun, listSyncRuns } from "./store";
import { connecteamConfigured } from "@/lib/connecteam";
import { getRecentAudit } from "@/lib/db/repo";
import type {
  PayPeriod, PayrollReadinessModel, UnifiedWorkerRow, UnifiedIssue, UnifiedWorkerStatus, UnifiedPayrollStatus,
  PayrollGate, GateState, AttentionGroup, PayrollSourceHealth, PayrollActivityEvent, PayrollNextAction,
  PayrollTone, ApprovalState, RateComparison, ReviewWorker, ReadinessWorker,
  UnifiedIssueSeverity, ReadinessException, PayrollReviewResult, PayrollReadiness, PayrollApprovalStatus,
} from "./types";
import { GATE_LABEL } from "./types";

const REVIEW_TAB = "/payroll?tab=review";
const WORKERS_TAB = "/payroll?tab=workers";
const SETTINGS_TAB = "/payroll?tab=settings";
const EXCEPTIONS_TAB = "/payroll?tab=exceptions";
const round2 = (n: number): number => Math.round(n * 100) / 100;

// Map a review IssueTag (code/kind) → a unified issue. review's MISSING_CONFIG (incl. missing rate) is a
// non-blocking SETUP gap; its BLOCKING is the Gusto-mapping stop; OVERTIME is a review anomaly.
function reviewIssue(code: string, label: string, kind: string): UnifiedIssue | null {
  if (code === "NO_GUSTO_MAPPING") return { code, label, severity: "blocker", gate: "gustoMapping" };
  if (code === "OVERTIME") return { code: "OVERTIME", label, severity: "review", gate: "zoeReview" };
  if (kind === "MISSING_CONFIG") return { code, label, severity: "setup", gate: "zoeReview" };
  return { code, label, severity: "review", gate: "zoeReview" };
}

// Map a readiness ReadinessException → a unified issue. Source-approval + punch + discrepancy are Connecteam
// (timesheetApproval) gate; duplicate mapping is a hard Gusto-mapping blocker; stale/unavailable are period
// unverified signals. OVERTIME is deduped against review's (same anomaly) by the caller.
function readinessIssue(e: ReadinessException): UnifiedIssue {
  switch (e.type) {
    case "UNAPPROVED_TIMESHEET":
      return { code: "UNAPPROVED_TIMESHEET", label: "Unapproved timesheet", severity: "review", gate: "timesheetApproval", detail: `${e.description} — ${e.ownerAction}` };
    case "APPROVAL_UNVERIFIED":
      return { code: "APPROVAL_UNVERIFIED", label: "Approval unverified", severity: "unverified", gate: "timesheetApproval", detail: `${e.description} — ${e.ownerAction}` };
    case "MISSING_PUNCH":
      return { code: "MISSING_PUNCH", label: "Open punch", severity: "review", gate: "timesheetApproval", detail: `${e.description} — ${e.ownerAction}` };
    case "SCHEDULE_DISCREPANCY":
      return { code: "SCHEDULE_DISCREPANCY", label: "Schedule discrepancy", severity: "review", gate: "timesheetApproval", detail: `${e.description} — ${e.ownerAction}` };
    case "MISSING_GUSTO_MAPPING":
      // Same underlying problem as review's NO_GUSTO_MAPPING — use its code so the merge dedupes to one issue.
      return { code: "NO_GUSTO_MAPPING", label: "No Gusto mapping", severity: "blocker", gate: "gustoMapping", detail: `${e.description} — ${e.ownerAction}` };
    case "DUPLICATE_GUSTO_MAPPING":
      return { code: "DUPLICATE_GUSTO_MAPPING", label: "Duplicate Gusto mapping", severity: "blocker", gate: "gustoMapping", detail: `${e.description} — ${e.ownerAction}` };
    case "NO_PAY_RATE":
      // Aligned with policy: a missing rate is a non-blocking estimate/setup gap (Gusto applies its own rate
      // on the push). Kept as SETUP so it never blocks, matching review.ts.
      return { code: "NO_PAY_RATE", label: "No pay rate (estimate only)", severity: "setup", gate: "zoeReview", detail: `${e.description} — ${e.ownerAction}` };
    case "OVERTIME":
      return { code: "OVERTIME", label: "Overtime", severity: "review", gate: "zoeReview", detail: `${e.description} — ${e.ownerAction}` };
    default:
      return { code: e.type, label: e.type.replace(/_/g, " ").toLowerCase(), severity: "review", gate: "timesheetApproval", detail: `${e.description} — ${e.ownerAction}` };
  }
}

// A worker's single bucket, by precedence: BLOCKED > ACTION_REQUIRED > UNVERIFIED > READY. `accepted` (a human
// accepted a REQUIRES_REVIEW worker into the run) clears the ACCEPTABLE anomalies (review/setup NOT on the
// timesheet-approval gate) from gating — but NEVER the source-approval gate (accepting a Zoe review item does
// not approve a Connecteam timesheet) nor a hard blocker. Legitimate distinction preserved (spec).
function workerStatusFrom(issues: UnifiedIssue[], accepted: boolean): UnifiedWorkerStatus {
  const gating = accepted
    ? issues.filter((i) => i.severity === "blocker" || i.severity === "unverified" || i.gate === "timesheetApproval")
    : issues;
  if (gating.some((i) => i.severity === "blocker")) return "BLOCKED";
  if (gating.some((i) => i.severity === "review" || i.severity === "setup")) return "ACTION_REQUIRED";
  if (gating.some((i) => i.severity === "unverified")) return "UNVERIFIED";
  return "READY";
}

function approvalStateFor(rw: ReadinessWorker | undefined, approvalKnown: boolean): ApprovalState {
  if (rw == null) return approvalKnown ? "APPROVED" : "UNVERIFIED";
  if (!approvalKnown || rw.issues.some((i) => i.type === "APPROVAL_UNVERIFIED")) return "UNVERIFIED";
  if (rw.issues.some((i) => i.type === "UNAPPROVED_TIMESHEET")) return "UNAPPROVED";
  return "APPROVED";
}

// Merge one review worker with its readiness counterpart into a unified row. Dedupes OVERTIME (both engines
// flag it). The readiness worker is matched by the same stable key (ct:<id> | hw:<id>).
function mergeWorker(
  rv: ReviewWorker,
  rd: ReadinessWorker | undefined,
  approvalKnown: boolean,
  excluded: boolean,
): UnifiedWorkerRow {
  const issues: UnifiedIssue[] = [];
  const seen = new Set<string>();
  const add = (i: UnifiedIssue | null) => { if (i && !seen.has(i.code)) { seen.add(i.code); issues.push(i); } };
  for (const t of rv.issues) add(reviewIssue(t.code, t.label, t.kind));
  if (rd) for (const e of rd.issues) add(readinessIssue(e));

  const accepted = !!rv.accepted;
  const status: UnifiedWorkerStatus = excluded ? "EXCLUDED" : workerStatusFrom(issues, accepted);

  return {
    key: rv.key, name: rv.name, workerType: rv.workerType,
    hours: rv.hours, payRate: rv.payRate, rateSource: rv.rateSource ?? null, currency: rv.currency, estPay: rv.estPay,
    mappingStatus: rv.mappingStatus, gustoMapped: rv.mappingStatus !== "UNMATCHED",
    approvalState: excluded ? "NA" : approvalStateFor(rd, approvalKnown),
    approvedHours: rd?.approvedHours ?? null,
    unapprovedHours: rd?.unapprovedHours ?? null,
    status, accepted, acceptedBy: rv.acceptedBy ?? null, issues,
    excludeMode: rv.excludeMode, excludeReason: rv.excludeReason ?? null,
    recordId: rv.recordId ?? null, connecteamUserId: rv.connecteamUserId ?? null,
    gustoId: rv.gustoId ?? null, country: rv.country ?? null, payType: rv.payType ?? null,
    gustoRate: rv.gustoRate ?? null, gustoRateUnit: rv.gustoRateUnit ?? null, connecteamRate: rv.connecteamRate ?? null,
  };
}

const AUDIT_ACTIONS = [
  "payroll.approve", "payroll.worker.accept", "payroll.worker.unaccept",
  "payroll.worker.exclude", "payroll.worker.include", "payroll.rate_sync.write", "payroll.gusto.push_hours",
];
const ACTIVITY: Record<string, { layer: PayrollActivityEvent["layer"]; label: string; tone: PayrollTone }> = {
  "payroll.approve": { layer: "approval", label: "Approved payroll (Zoe sign-off)", tone: "positive" },
  "payroll.worker.accept": { layer: "review", label: "Accepted a worker into the run", tone: "neutral" },
  "payroll.worker.unaccept": { layer: "review", label: "Un-accepted a worker", tone: "neutral" },
  "payroll.worker.exclude": { layer: "exclusion", label: "Excluded a worker", tone: "neutral" },
  "payroll.worker.include": { layer: "exclusion", label: "Re-included a worker", tone: "neutral" },
  "payroll.rate_sync.write": { layer: "rate", label: "Wrote a Gusto rate into Connecteam", tone: "neutral" },
  "payroll.gusto.push_hours": { layer: "submission", label: "Pushed hours to the Gusto draft", tone: "positive" },
};

/** Build the real payroll activity feed from the audit log + the sync ledger (actor / action / time / outcome).
 *  Returns [] honestly when nothing has happened. */
function buildActivity(): PayrollActivityEvent[] {
  const events: PayrollActivityEvent[] = [];
  try {
    for (const a of getRecentAudit(AUDIT_ACTIONS, 12)) {
      const meta = ACTIVITY[a.action] ?? { layer: "review" as const, label: a.action.replace(/^payroll\./, "").replace(/[._]/g, " "), tone: "neutral" as PayrollTone };
      const d = a.detail ?? {};
      const outcome =
        a.action === "payroll.approve" ? `${d.readyWorkers ?? "?"} ready approved`
          : a.action === "payroll.gusto.push_hours" ? `${d.pushed ?? "?"} pushed${d.failed ? `, ${d.failed} failed` : ""}`
            : a.action === "payroll.rate_sync.write" ? `${d.name ?? "worker"} → $${d.gustoRate ?? "?"}/hr`
              : (d.name as string | undefined) ?? (d.period as string | undefined) ?? null;
      events.push({ id: a.auditId, actor: a.actor || null, layer: meta.layer, label: meta.label, at: a.ts, outcome, tone: meta.tone });
    }
  } catch { /* audit unavailable — honest empty feed below */ }
  try {
    for (const r of listSyncRuns(6)) {
      events.push({
        id: `sync:${r.id}`, actor: r.initiatedBy, layer: "sync",
        label: `Synced hours (${r.trigger})`, at: r.finishedAt ?? r.startedAt,
        outcome: `${r.status.toLowerCase().replace(/_/g, " ")}${r.totalHours != null ? ` · ${r.totalHours}h` : ""}`,
        tone: r.status === "FAILED" ? "critical" : "neutral",
      });
    }
  } catch { /* ledger unavailable */ }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 8);
}

function gate(key: PayrollGate["key"], state: GateState, detail: string, affected = 0): PayrollGate {
  return { key, label: GATE_LABEL[key], state, detail, affected };
}

const TONE_FOR_STATUS: Record<UnifiedPayrollStatus, PayrollTone> = {
  NO_DATA: "neutral", UNAVAILABLE: "neutral", BLOCKED: "critical",
  ACTION_REQUIRED: "attention", READY: "positive", APPROVED: "positive", SUBMITTED: "positive",
};

// Pure, IO-free inputs the composition needs — gathered by derivePayrollReadiness, or hand-built in tests.
export interface ComposeInputs {
  period: PayPeriod;
  review: PayrollReviewResult;
  readiness: PayrollReadiness;
  rate: { proposals: number; salaried: number; noGustoRate: number; asOf: string | null };
  approval: { status: PayrollApprovalStatus; approvedBy: string | null; approvedAt: string | null } | null;
  pushedOk: boolean;
  pushed: number;
  snapshotAt: string | null;
  activity: PayrollActivityEvent[];
  sources: { connecteam: boolean; gusto: boolean; gustoSnapshotAt: string | null; gustoFresh: boolean; instaworkOk: boolean; instaworkAsOf: string | null };
  schedule: { deadlineLabel: string; precheckLabel: string | null; autoSyncLabel: string | null };
}

/** The single entry point: gather both engines + the approval/sources/activity and reconcile into one model. */
export async function derivePayrollReadiness(period: PayPeriod): Promise<PayrollReadinessModel> {
  const cfg = getPayrollConfig();
  const [review, readiness, ratePlan, temp] = await Promise.all([
    payrollReview(period),
    assessReadiness(period),
    buildRateSyncPlan(period.end),
    instaworkTempPay(period),
  ]);

  const approval = getApproval(period.start, period.end);
  const pushResult = readGustoPushResult();
  const pushedOk = !!pushResult?.ok && pushResult.aborted == null && (pushResult.pushed ?? 0) > 0;
  const last = latestSyncRun();
  const snap = readGustoSnapshot();

  return composeReadinessModel({
    period, review, readiness,
    rate: { proposals: ratePlan.proposals.length, salaried: ratePlan.salaried, noGustoRate: ratePlan.noGustoRate, asOf: ratePlan.asOf },
    approval: approval ? { status: approval.status, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt } : null,
    pushedOk, pushed: pushResult?.pushed ?? 0,
    snapshotAt: last?.finishedAt ?? last?.startedAt ?? snap?.fetchedAt ?? null,
    activity: buildActivity(),
    sources: {
      connecteam: connecteamConfigured(), gusto: gustoConfigured(),
      gustoSnapshotAt: snap?.fetchedAt ?? null, gustoFresh: gustoSnapshotFresh(),
      instaworkOk: temp.ok, instaworkAsOf: temp.asOf,
    },
    schedule: {
      deadlineLabel: payrollDeadlineLabel(cfg),
      precheckLabel: cfg.precheckEnabled ? precheckScheduleLabel(cfg) : null,
      autoSyncLabel: cfg.autoSyncEnabled ? scheduleLabel(cfg) : null,
    },
  });
}

/** PURE reconciliation (fully unit-testable): compose the one authoritative model from already-fetched facts. */
export function composeReadinessModel(inp: ComposeInputs): PayrollReadinessModel {
  const { period, review, readiness } = inp;
  const approvalKnown = readiness.approvalKnown;
  const rdByKey = new Map<string, ReadinessWorker>(readiness.workers.map((w) => [w.key, w]));

  const workers: UnifiedWorkerRow[] = review.workers.map((rv) => mergeWorker(rv, rdByKey.get(rv.key), approvalKnown, false));
  const excludedWorkers: UnifiedWorkerRow[] = review.excluded.map((rv) => mergeWorker(rv, undefined, approvalKnown, true));

  const included = workers.length;
  const ready = workers.filter((w) => w.status === "READY").length;
  const blocked = workers.filter((w) => w.status === "BLOCKED").length;
  const unverified = workers.filter((w) => w.status === "UNVERIFIED").length;
  const actionRequired = workers.filter((w) => w.status === "ACTION_REQUIRED").length;

  // Period-level signals from the readiness engine (not tied to one worker).
  const periodStale = readiness.exceptions.some((e) => e.type === "GUSTO_STALE");

  // ── Gates ────────────────────────────────────────────────────────────────────────────────────────
  const connecteamOk = review.connecteamOk && readiness.connecteamOk;
  const snapshotAt = inp.snapshotAt;

  const hoursGate = gate("hours",
    !connecteamOk ? "UNAVAILABLE" : "PASS",
    !connecteamOk ? "Connecteam time source is unreachable — hours could not be pulled." : `${review.hours ?? 0}h pulled from Connecteam.`);

  const unapprovedCount = workers.filter((w) => w.approvalState === "UNAPPROVED").length;
  const unverifiedApprovalCount = workers.filter((w) => w.approvalState === "UNVERIFIED").length;
  const approvalGate = gate("timesheetApproval",
    !connecteamOk ? "UNAVAILABLE" : !approvalKnown ? "UNVERIFIED" : unapprovedCount > 0 ? "ACTION" : unverifiedApprovalCount > 0 ? "UNVERIFIED" : "PASS",
    !approvalKnown ? "Connecteam did not expose timesheet approval — cannot confirm hours are approved."
      : unapprovedCount > 0 ? `${unapprovedCount} worker${unapprovedCount === 1 ? "" : "s"} have unapproved time in Connecteam.`
        : unverifiedApprovalCount > 0 ? `${unverifiedApprovalCount} worker${unverifiedApprovalCount === 1 ? "" : "s"} could not be confirmed as approved.`
          : "All timesheets approved in Connecteam.",
    unapprovedCount + unverifiedApprovalCount);

  const unmapped = workers.filter((w) => w.issues.some((i) => i.gate === "gustoMapping" && i.severity === "blocker")).length;
  const mappingGate = gate("gustoMapping",
    unmapped > 0 ? "BLOCKED" : "PASS",
    unmapped > 0 ? `${unmapped} worker${unmapped === 1 ? "" : "s"} cannot be paid — not mapped to a Gusto member (or a duplicate mapping).` : "Every paid worker is mapped to Gusto.",
    unmapped);

  const approval = inp.approval;
  const reviewItems = workers.filter((w) => w.status === "ACTION_REQUIRED" && w.issues.some((i) => i.gate === "zoeReview")).length;
  const approved = approval?.status === "APPROVED";
  const reviewGate = gate("zoeReview",
    approved ? "PASS" : reviewItems > 0 ? "ACTION" : blocked > 0 || unapprovedCount > 0 || unverifiedApprovalCount > 0 ? "PENDING" : ready > 0 ? "PENDING" : "NA",
    approved ? `Approved by ${approval?.approvedBy ?? "—"}.`
      : reviewItems > 0 ? `${reviewItems} worker${reviewItems === 1 ? "" : "s"} need review (accept into the run, fix, or exclude).`
        : "No outstanding review items — ready for sign-off once upstream gates pass.",
    reviewItems);

  const pushedOk = inp.pushedOk;
  const submissionGate = gate("gustoSubmission",
    pushedOk ? "PASS" : approved ? "PENDING" : "NA",
    pushedOk ? `${inp.pushed} worker${inp.pushed === 1 ? "" : "s"} written to the Gusto DRAFT (not submitted).`
      : approved ? "Approved — ready to push hours into the Gusto draft." : "Awaiting approval before any Gusto write.");

  const gates = [hoursGate, approvalGate, mappingGate, reviewGate, submissionGate];

  // ── Overall status (worst gate, reconciled) ───────────────────────────────────────────────────────
  let status: UnifiedPayrollStatus;
  if (!connecteamOk) status = "UNAVAILABLE";
  else if (included === 0) status = "NO_DATA";
  else if (blocked > 0) status = "BLOCKED";
  else if (actionRequired > 0 || unapprovedCount > 0) status = "ACTION_REQUIRED";
  else if (unverified > 0 || !approvalKnown || periodStale) status = "ACTION_REQUIRED";
  else if (pushedOk) status = "SUBMITTED";
  else if (approved) status = "APPROVED";
  else status = "READY";

  const tone = TONE_FOR_STATUS[status];

  // ── Headline + explain ──────────────────────────────────────────────────────────────────────────
  const headline =
    status === "UNAVAILABLE" ? "Payroll data unavailable"
      : status === "NO_DATA" ? "No hours to pay this period"
        : status === "BLOCKED" ? `${blocked} worker${blocked === 1 ? "" : "s"} blocked`
          : status === "ACTION_REQUIRED" ? `${actionRequired + unverified || "Items"} need attention`
            : status === "READY" ? `All ${ready} worker${ready === 1 ? "" : "s"} ready to approve`
              : status === "APPROVED" ? "Payroll approved"
                : "Hours sent to Gusto draft";
  const explain =
    status === "UNAVAILABLE" ? "Connecteam is unreachable, so hours could not be verified. Not safe to approve on stale data."
      : status === "NO_DATA" ? "No worker logged hours in this completed week."
        : status === "BLOCKED" ? "Unaffected, mapped workers can still be approved once review and timesheet gates pass — blocked workers are held out of the run until mapped or excluded."
          : status === "ACTION_REQUIRED" ? "Resolve the items below. Workers that are already clean are not held back once the shared timesheet-approval gate is met."
            : status === "READY" ? "Every gate is clean. Review and record the Zoe approval, then push to the Gusto draft."
              : status === "APPROVED" ? "Zoe sign-off recorded. Push the hours into the Gusto draft (draft only — this never submits payroll)."
                : "Hours are written to the Gusto draft. Submit payroll inside Gusto to finish — that step is not done here.";

  // ── Next valid action (hard blockers first, else earliest pipeline gate) ────────────────────────────
  const nextAction = computeNextAction({ connecteamOk, mappingGate, approvalGate, reviewGate, status, approved });

  // ── Needs-attention (prioritized, grouped) ──────────────────────────────────────────────────────────
  const attention = buildAttention(workers);

  // ── Totals ───────────────────────────────────────────────────────────────────────────────────────
  const estVals = workers.map((w) => w.estPay);
  const estGross = estVals.some((v) => v != null) ? round2(estVals.reduce<number>((s, v) => s + (v ?? 0), 0)) : null;
  const estGrossPartial = workers.some((w) => (w.hours ?? 0) > 0 && w.estPay == null);

  // ── Sources (payroll-scoped health) ────────────────────────────────────────────────────────────────
  const sources = buildSources(connecteamOk, snapshotAt, inp.sources);

  // ── Rate comparison (3 distinct populations) ─────────────────────────────────────────────────────────
  const mappedInRun = workers.filter((w) => w.gustoMapped).length;
  const comparable = Math.max(0, mappedInRun - inp.rate.noGustoRate - inp.rate.salaried);
  const rateComparison: RateComparison = {
    mapped: mappedInRun,
    verifiedMatch: Math.max(0, comparable - inp.rate.proposals),
    differing: inp.rate.proposals,
    missingSourceRate: inp.rate.noGustoRate,
    incomparableSalaried: inp.rate.salaried,
    asOf: inp.rate.asOf,
  };

  return {
    period, snapshotAt, connecteamOk, approvalKnown,
    status, tone, headline, explain, gates, nextAction,
    counts: { included, ready, actionRequired, blocked, unverified, excluded: excludedWorkers.length },
    totals: { hours: review.hours, estGross, estGrossPartial, approvedHours: readiness.approvedHours },
    workers, excludedWorkers, attention, sources,
    activity: inp.activity,
    approval,
    schedule: inp.schedule,
    rateComparison,
  };
}

// ── Approvability (the single source of truth for BOTH the Approve button and the /approve endpoint, so UI
// gating can't be bypassed) ─────────────────────────────────────────────────────────────────────────────
// A worker is strictly approvable when every gate is clean (status READY). The ONLY thing an explicit
// human acknowledgement may add is workers held solely by the source-approval gate (unapproved / unverified
// Connecteam timesheets) — never a hard blocker (unmapped/duplicate), never an unresolved review anomaly,
// and never when the time source itself is UNAVAILABLE. This encodes "unverified must never SILENTLY become
// ready" (spec §4): it can only be approved with a recorded, deliberate acknowledgement.
function onlyApprovalGate(w: UnifiedWorkerRow): boolean {
  const gating = w.accepted
    ? w.issues.filter((i) => i.severity === "blocker" || i.severity === "unverified" || i.gate === "timesheetApproval")
    : w.issues;
  return gating.length > 0 && gating.every((i) => i.code === "UNAPPROVED_TIMESHEET" || i.code === "APPROVAL_UNVERIFIED");
}

export interface Approvability {
  unavailable: boolean; // the time source is down — nothing may be approved
  readyKeys: string[]; // strictly-ready workers (approvable with no acknowledgement)
  acknowledgeableKeys: string[]; // held ONLY by the source-approval gate (approvable only with acknowledgement)
  approvableKeys: string[]; // what WOULD be approved given this acknowledgement flag
  needsAck: boolean; // there are acknowledgeable workers (the caller should confirm inclusion)
  ackReason: string | null;
}
export function payrollApprovability(model: PayrollReadinessModel, acknowledge: boolean): Approvability {
  const unavailable = model.status === "UNAVAILABLE";
  const readyKeys = model.workers.filter((w) => w.status === "READY").map((w) => w.key);
  const acknowledgeableKeys = model.workers
    .filter((w) => (w.status === "UNVERIFIED" || w.status === "ACTION_REQUIRED") && onlyApprovalGate(w))
    .map((w) => w.key);
  const approvableKeys = unavailable ? [] : [...readyKeys, ...(acknowledge ? acknowledgeableKeys : [])];
  const ts = model.gates.find((g) => g.key === "timesheetApproval");
  return {
    unavailable, readyKeys, acknowledgeableKeys, approvableKeys,
    needsAck: acknowledgeableKeys.length > 0,
    ackReason: acknowledgeableKeys.length > 0 ? ts?.detail ?? "Some timesheets are unapproved or unverified in Connecteam." : null,
  };
}

function computeNextAction(a: {
  connecteamOk: boolean; mappingGate: PayrollGate; approvalGate: PayrollGate; reviewGate: PayrollGate;
  status: UnifiedPayrollStatus; approved: boolean;
}): PayrollNextAction {
  if (!a.connecteamOk) return { label: "Sync hours", href: SETTINGS_TAB, explain: "Connecteam is unreachable — retry the hours sync before anything else.", gate: "hours" };
  // Hard blockers first.
  if (a.mappingGate.state === "BLOCKED") return { label: "Map workers to Gusto", href: REVIEW_TAB, explain: a.mappingGate.detail, gate: "gustoMapping" };
  // Then the earliest pipeline gate that isn't passing.
  if (a.approvalGate.state === "ACTION" || a.approvalGate.state === "UNVERIFIED") return { label: "Approve timesheets in Connecteam", href: null, explain: a.approvalGate.detail, gate: "timesheetApproval" };
  if (a.reviewGate.state === "ACTION") return { label: "Review payroll", href: REVIEW_TAB, explain: a.reviewGate.detail, gate: "zoeReview" };
  if (a.status === "READY") return { label: "Approve payroll", href: REVIEW_TAB, explain: "Every gate is clean — record the Zoe approval.", gate: "zoeReview" };
  if (a.status === "APPROVED") return { label: "Push hours to Gusto (draft)", href: SETTINGS_TAB, explain: "Approved — write the hours into the Gusto draft.", gate: "gustoSubmission" };
  if (a.status === "SUBMITTED") return { label: "Submit in Gusto", href: null, explain: "Hours are in the Gusto draft — submit payroll inside Gusto to finish.", gate: "gustoSubmission" };
  return { label: "Nothing to pay", href: null, explain: "No workers to pay in this period.", gate: null };
}

const SEV_RANK: Record<UnifiedIssueSeverity, number> = { blocker: 0, review: 1, unverified: 2, setup: 3 };
const ATTENTION_ACTION: Record<string, { label: string; href: string | null }> = {
  NO_GUSTO_MAPPING: { label: "Map to Gusto", href: WORKERS_TAB },
  DUPLICATE_GUSTO_MAPPING: { label: "Fix mapping", href: WORKERS_TAB },
  UNAPPROVED_TIMESHEET: { label: "Approve in Connecteam", href: null },
  APPROVAL_UNVERIFIED: { label: "Verify in Connecteam", href: null },
  MISSING_PUNCH: { label: "Fix in Connecteam", href: null },
  SCHEDULE_DISCREPANCY: { label: "Review in Exceptions", href: EXCEPTIONS_TAB },
  OVERTIME: { label: "Review overtime", href: REVIEW_TAB },
  NO_PAY_RATE: { label: "Set rate", href: REVIEW_TAB },
  TYPE_UNCONFIRMED: { label: "Classify worker", href: REVIEW_TAB },
  COUNTRY_MISSING: { label: "Set country", href: REVIEW_TAB },
  CURRENCY_MISSING: { label: "Set currency", href: REVIEW_TAB },
};

/** Group repeated issues (e.g. several unapproved timesheets) into prioritized rows: blockers → review →
 *  unverified → setup. Counts come straight from the worker rows, so they always match the tables. */
function buildAttention(workers: UnifiedWorkerRow[]): AttentionGroup[] {
  const byCode = new Map<string, { issue: UnifiedIssue; workers: { key: string; name: string }[] }>();
  for (const w of workers) {
    if (w.status === "READY" || w.status === "EXCLUDED") continue;
    // For an accepted worker, only the still-gating issues are "attention"; others were accepted.
    const gating = w.accepted
      ? w.issues.filter((i) => i.severity === "blocker" || i.severity === "unverified" || i.gate === "timesheetApproval")
      : w.issues;
    for (const i of gating) {
      const g = byCode.get(i.code) ?? { issue: i, workers: [] };
      g.workers.push({ key: w.key, name: w.name });
      byCode.set(i.code, g);
    }
  }
  const groups: AttentionGroup[] = [];
  for (const [code, g] of byCode) {
    groups.push({
      code, severity: g.issue.severity, gate: g.issue.gate,
      title: g.issue.label, count: g.workers.length, workers: g.workers,
      action: ATTENTION_ACTION[code] ?? { label: "Review", href: REVIEW_TAB },
      detail: g.issue.detail ?? "",
    });
  }
  return groups.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count);
}

function buildSources(connecteamOk: boolean, snapshotAt: string | null, s: ComposeInputs["sources"]): PayrollSourceHealth[] {
  return [
    {
      key: "connecteam", label: "Connecteam", role: "Operational time source",
      state: !s.connecteam ? "off" : connecteamOk ? "ok" : "unavailable",
      lastAt: connecteamOk ? snapshotAt : null,
      detail: !s.connecteam ? "not connected" : connecteamOk ? "hours pulled" : "unreachable — retry sync",
      fixHref: s.connecteam ? null : SETTINGS_TAB,
    },
    {
      key: "gusto", label: "Gusto", role: "Payroll system of record",
      state: !s.gusto ? "off" : !s.gustoSnapshotAt ? "idle" : s.gustoFresh ? "ok" : "stale",
      lastAt: s.gustoSnapshotAt,
      detail: !s.gusto ? "not connected" : !s.gustoSnapshotAt ? "no pull yet" : s.gustoFresh ? "roster + rates current" : "snapshot stale — re-run the Gusto pull",
      fixHref: SETTINGS_TAB,
    },
    {
      key: "instawork", label: "Instawork", role: "Temp labor (paid separately)",
      state: s.instaworkOk ? "ok" : "idle",
      lastAt: s.instaworkAsOf, detail: s.instaworkOk ? "snapshot available" : "no recent snapshot",
      fixHref: null,
    },
  ];
}

// Payroll READINESS pre-check — the deterministic "is this pay period ready to export to Gusto?" engine
// that prepares Lisa for the Tuesday payroll run. RULES CALCULATE: every status + exception here is derived
// from real Connecteam/Gusto facts (hours, timesheet approval, planned shifts, Gusto mapping), never
// AI-decided and never fabricated. Honest degradation (spec §3/§4): when a required source is unavailable
// or approval can't be confirmed, the period is UNAVAILABLE / ACTION_REQUIRED — NEVER READY. Nothing here
// mutates hours or submits payroll; it only surfaces what Lisa must resolve.
//
// classifyReadiness() is pure (takes already-fetched facts) so it is fully unit-testable. assessReadiness()
// gathers the live facts and persists each exception idempotently through the existing hr_exceptions queue.

import { unifiedWorkers } from "./workers";
import { getPayrollConfig } from "./config";
import { getTimesheetDetail, getPlannedHours, type TimesheetUserDetail } from "@/lib/connecteam";
import { gustoConfigured } from "./gusto";
import { gustoSnapshotFresh } from "./gustoSnapshot";
import { upsertException, listExceptions, resolveException, getWorkerByConnecteamId, listPeriodExclusions } from "./store";
import type {
  PayPeriod, PayrollReadiness, ReadinessException, ReadinessStatus, ReadinessWorker,
  ReadinessIssueKind, ExceptionSeverity, UnifiedWorker,
} from "./types";

export interface ReadinessOptions {
  overtimeThreshold: number;
  scheduleDiscrepancyPct: number; // |actual−planned|/planned ≥ this % flags a discrepancy
}

/** Per-worker facts the pure classifier needs. Assembled by assessReadiness from the live sources. */
export interface ReadinessFacts {
  key: string;
  name: string;
  connecteamUserId: number | null;
  active: boolean;
  gustoId: string | null;
  gustoMapped: boolean;
  payRate: number | null;
  actualHours: number | null; // null ⇒ time source unavailable (UNVERIFIED, never 0)
  approvedHours: number | null;
  unapprovedHours: number | null;
  approvalKnownForWorker: boolean;
  openPunch: boolean;
  plannedHours: number | null; // from the Connecteam schedule; null ⇒ unknown
}

export interface ReadinessContext {
  period: PayPeriod;
  connecteamOk: boolean; // the hours/time source reached Connecteam
  approvalFieldSeen: boolean; // the timesheet endpoint exposed approval anywhere
  plannedOk: boolean; // the schedule source answered (for discrepancy checks)
  gusto: { configured: boolean; fresh: boolean };
  opts: ReadinessOptions;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const SEVERITY: Record<ReadinessIssueKind, ExceptionSeverity> = {
  BLOCKING: "HIGH",
  UNVERIFIED: "HIGH",
  EXCEPTION: "MEDIUM",
};

function mkException(
  period: PayPeriod,
  w: { key: string | null; label: string | null; connecteamUserId: number | null },
  type: ReadinessException["type"],
  kind: ReadinessIssueKind,
  description: string,
  ownerAction: string,
  source: string,
): ReadinessException {
  return {
    detectKey: `RDY:${period.start}:${period.end}:${w.key ?? "PERIOD"}:${type}`,
    workerKey: w.key,
    workerLabel: w.label,
    connecteamUserId: w.connecteamUserId,
    type,
    kind,
    severity: SEVERITY[kind],
    description,
    ownerAction,
    source,
  };
}

/** Classify ONE worker's readiness from their facts. Pure + deterministic. */
export function classifyReadinessWorker(f: ReadinessFacts, ctx: ReadinessContext): ReadinessWorker {
  const issues: ReadinessException[] = [];
  const who = { key: f.key, label: f.name, connecteamUserId: f.connecteamUserId };
  const hours = f.actualHours;

  // BLOCKING — prevents export to Gusto.
  if (!f.gustoMapped) {
    issues.push(mkException(ctx.period, who, "MISSING_GUSTO_MAPPING", "BLOCKING",
      `${f.name} worked ${hours ?? "?"}h but is not mapped to a Gusto member.`,
      "Map this worker to Gusto in the Workers tab.", "reconciliation"));
  }
  if ((hours ?? 0) > 0 && f.payRate == null) {
    issues.push(mkException(ctx.period, who, "NO_PAY_RATE", "BLOCKING",
      `${f.name} has hours but no pay rate on file.`,
      "Set the pay rate in Connecteam/Gusto, then re-sync.", "reconciliation"));
  }
  // Approval is the sync prerequisite: unapproved hours must NOT be exported.
  if (f.approvalKnownForWorker && (f.unapprovedHours ?? 0) > 0) {
    issues.push(mkException(ctx.period, who, "UNAPPROVED_TIMESHEET", "BLOCKING",
      `${f.name} has ${f.unapprovedHours}h of unapproved time (of ${hours ?? "?"}h total).`,
      "Approve this worker's timesheet in Connecteam.", "connecteam"));
  } else if (!f.approvalKnownForWorker && (hours ?? 0) > 0 && ctx.connecteamOk) {
    // Approval could not be confirmed for this worker → UNVERIFIED, never assumed clean (§4).
    issues.push(mkException(ctx.period, who, "APPROVAL_UNVERIFIED", "UNVERIFIED",
      `${f.name}'s timesheet approval status could not be confirmed from Connecteam.`,
      "Verify the timesheet is approved in Connecteam before exporting.", "connecteam"));
  }

  // EXCEPTION — anomalies to review (not hard blockers).
  if (f.openPunch) {
    issues.push(mkException(ctx.period, who, "MISSING_PUNCH", "EXCEPTION",
      `${f.name} has an open punch (clock-in without a clock-out).`,
      "Fix the missing clock-out in Connecteam.", "connecteam"));
  }
  if (
    ctx.plannedOk && f.plannedHours != null && f.plannedHours > 0 && hours != null &&
    Math.abs(hours - f.plannedHours) / f.plannedHours >= ctx.opts.scheduleDiscrepancyPct / 100
  ) {
    issues.push(mkException(ctx.period, who, "SCHEDULE_DISCREPANCY", "EXCEPTION",
      `${f.name} logged ${round2(hours)}h vs ${round2(f.plannedHours)}h scheduled (≥${ctx.opts.scheduleDiscrepancyPct}% difference).`,
      "Confirm the recorded hours against the schedule.", "connecteam"));
  }
  if ((hours ?? 0) > ctx.opts.overtimeThreshold) {
    issues.push(mkException(ctx.period, who, "OVERTIME", "EXCEPTION",
      `${f.name} logged ${round2(hours ?? 0)}h (> ${ctx.opts.overtimeThreshold}h).`,
      "Review overtime before payroll.", "connecteam"));
  }

  return {
    key: f.key, name: f.name, connecteamUserId: f.connecteamUserId,
    actualHours: f.actualHours, approvedHours: f.approvedHours, unapprovedHours: f.unapprovedHours,
    plannedHours: f.plannedHours, issues, status: statusFromIssues(issues, ctx.connecteamOk),
  };
}

function statusFromIssues(issues: ReadinessException[], connecteamOk: boolean): ReadinessStatus {
  if (!connecteamOk) return "UNAVAILABLE";
  if (issues.some((i) => i.kind === "BLOCKING")) return "BLOCKED";
  if (issues.length > 0) return "ACTION_REQUIRED"; // EXCEPTION or UNVERIFIED
  return "READY";
}

/** Classify a whole period from already-fetched facts. Pure. */
export function classifyReadiness(facts: ReadinessFacts[], ctx: ReadinessContext): PayrollReadiness {
  // When the time source is unavailable, NOTHING is ready — the whole period is UNAVAILABLE (§4).
  if (!ctx.connecteamOk) {
    const periodExc = mkException(
      ctx.period, { key: null, label: null, connecteamUserId: null }, "SOURCE_UNAVAILABLE", "UNVERIFIED",
      "Connecteam time source is unavailable — hours could not be pulled.",
      "Retry once Connecteam is reachable; do not export on stale data.", "connecteam",
    );
    return {
      period: ctx.period, status: "UNAVAILABLE", connecteamOk: false, approvalKnown: ctx.approvalFieldSeen,
      gusto: ctx.gusto, workers: [], exceptions: [periodExc],
      counts: { workers: 0, ready: 0, actionRequired: 0, blocked: 0 },
      blocking: 0, anomalies: 0, unverified: 1, hours: null, approvedHours: null,
      summary: "Payroll readiness UNAVAILABLE — Connecteam time source is unreachable. Not safe to export.",
    };
  }

  // Only workers with hours this period are part of the payroll run.
  const paid = facts.filter((f) => f.active && (f.actualHours ?? 0) > 0);
  const workers = paid.map((f) => classifyReadinessWorker(f, ctx));
  const exceptions: ReadinessException[] = workers.flatMap((w) => w.issues);

  // Period-level: a Gusto member mapped to more than one paid worker can't be paid unambiguously.
  const byGusto = new Map<string, ReadinessFacts[]>();
  for (const f of paid) if (f.gustoId) byGusto.set(f.gustoId, [...(byGusto.get(f.gustoId) ?? []), f]);
  for (const [gid, group] of byGusto) {
    if (group.length > 1) {
      const names = group.map((g) => g.name).join(", ");
      const exc = mkException(
        ctx.period, { key: `gusto:${gid}`, label: names, connecteamUserId: null },
        "DUPLICATE_GUSTO_MAPPING", "BLOCKING",
        `${group.length} workers map to the same Gusto member (${names}).`,
        "Fix the duplicate Gusto mapping in the Workers tab.", "reconciliation",
      );
      exceptions.push(exc);
      // Reflect the block on each involved worker's status.
      for (const g of group) {
        const w = workers.find((x) => x.key === g.key);
        if (w) { w.issues.push(exc); w.status = statusFromIssues(w.issues, true); }
      }
    }
  }

  // Period-level: Gusto configured but the pulled snapshot is stale → mappings/rates may be out of date.
  if (ctx.gusto.configured && !ctx.gusto.fresh) {
    exceptions.push(mkException(
      ctx.period, { key: null, label: null, connecteamUserId: null }, "GUSTO_STALE", "UNVERIFIED",
      "The Gusto snapshot is stale — mappings and pay rates may be out of date.",
      "Re-run the Gusto pull in the office browser before approving.", "gusto",
    ));
  }

  const blocking = exceptions.filter((e) => e.kind === "BLOCKING").length;
  const unverified = exceptions.filter((e) => e.kind === "UNVERIFIED").length;
  const anomalies = exceptions.filter((e) => e.kind === "EXCEPTION").length;

  const ready = workers.filter((w) => w.status === "READY").length;
  const blocked = workers.filter((w) => w.status === "BLOCKED").length;
  const actionRequired = workers.filter((w) => w.status === "ACTION_REQUIRED").length;

  // Overall status: any blocker ⇒ BLOCKED; else any anomaly/unverified (worker- or period-level) ⇒ ACTION
  // _REQUIRED; else READY. A clean period with no paid workers is READY (nothing to pay) only if the source
  // answered — which it did (connecteamOk true here).
  let status: ReadinessStatus;
  if (blocked > 0) status = "BLOCKED";
  else if (actionRequired > 0 || exceptions.length > 0) status = "ACTION_REQUIRED";
  else status = "READY";

  const hours = round2(paid.reduce((s, f) => s + (f.actualHours ?? 0), 0));
  const approvedHours = ctx.approvalFieldSeen
    ? round2(paid.reduce((s, f) => s + (f.approvedHours ?? 0), 0))
    : null;

  const summary = buildSummary(status, { workers: paid.length, ready, actionRequired, blocked }, blocking, anomalies, unverified);

  return {
    period: ctx.period, status, connecteamOk: true, approvalKnown: ctx.approvalFieldSeen, gusto: ctx.gusto,
    workers, exceptions,
    counts: { workers: paid.length, ready, actionRequired, blocked },
    blocking, anomalies, unverified, hours, approvedHours, summary,
  };
}

function buildSummary(
  status: ReadinessStatus,
  counts: { workers: number; ready: number; actionRequired: number; blocked: number },
  blocking: number, anomalies: number, unverified: number,
): string {
  const base = `${counts.workers} worker${counts.workers === 1 ? "" : "s"} · ${counts.ready} ready, ${counts.actionRequired} to review, ${counts.blocked} blocked`;
  if (status === "READY") return `Payroll READY — ${base}. All approvals confirmed.`;
  if (status === "BLOCKED") return `Payroll BLOCKED — ${blocking} blocking issue${blocking === 1 ? "" : "s"}. ${base}.`;
  const parts = [anomalies ? `${anomalies} anomal${anomalies === 1 ? "y" : "ies"}` : "", unverified ? `${unverified} unverified` : ""].filter(Boolean).join(", ");
  return `Payroll ACTION REQUIRED — ${parts || "items to review"}. ${base}.`;
}

// ── Live assessment + persistence ─────────────────────────────────────────────────────────────────────

/** Is this worker pulled out of the run? True when permanently excluded (hr_workers.excluded) OR skipped for
 *  THIS period (a key in the per-period exclusions). Such a worker is never a readiness blocker. Pure. */
export function isExcludedFromRun(excluded: boolean | undefined, key: string, periodExclusions: Map<string, unknown>): boolean {
  return !!excluded || periodExclusions.has(key);
}

/** Gather the live facts for a period and classify readiness. Reads only; never mutates hours or payroll. */
export async function assessReadiness(period: PayPeriod, opts?: Partial<ReadinessOptions>): Promise<PayrollReadiness> {
  const cfg = getPayrollConfig();
  const resolved: ReadinessOptions = {
    overtimeThreshold: opts?.overtimeThreshold ?? cfg.overtimeThreshold,
    scheduleDiscrepancyPct: opts?.scheduleDiscrepancyPct ?? cfg.scheduleDiscrepancyPct,
  };

  const [{ workers, connecteamOk }, tsDetail, planned] = await Promise.all([
    unifiedWorkers(period),
    getTimesheetDetail(period.start, period.end),
    getPlannedHours(period.start, period.end),
  ]);

  // Drop workers the human pulled out of this run on the Review tab (permanent hr_workers.excluded, OR a
  // per-period skip). An excluded worker is not being paid, so it must not surface as a readiness blocker
  // (e.g. "not mapped to Gusto" / "unapproved time"). Everything else below is unchanged.
  const periodExclusions = listPeriodExclusions(period.start, period.end);
  const included = workers.filter((w) => !isExcludedFromRun(w.excluded, w.key, periodExclusions));

  const facts: ReadinessFacts[] = included.map((w: UnifiedWorker) => {
    const detail: TimesheetUserDetail | undefined = w.connecteamUserId != null ? tsDetail.byUser.get(w.connecteamUserId) : undefined;
    const plannedHours = w.connecteamUserId != null && planned.ok ? planned.hours.get(w.connecteamUserId) ?? null : null;
    return {
      key: w.key,
      name: w.name,
      connecteamUserId: w.connecteamUserId,
      active: w.active,
      gustoId: w.gustoId,
      gustoMapped: w.gustoMapped,
      payRate: w.payRate,
      actualHours: w.periodHours,
      approvedHours: detail?.approvedHours ?? null,
      unapprovedHours: detail?.unapprovedHours ?? null,
      approvalKnownForWorker: detail?.approvalKnown ?? false,
      openPunch: detail?.openPunch ?? false,
      plannedHours,
    };
  });

  const ctx: ReadinessContext = {
    period,
    connecteamOk,
    approvalFieldSeen: tsDetail.ok && tsDetail.approvalFieldSeen,
    plannedOk: planned.ok,
    gusto: { configured: gustoConfigured(), fresh: gustoSnapshotFresh() },
    opts: resolved,
  };

  return classifyReadiness(facts, ctx);
}

// The sync engine already owns these in the hr_exceptions queue (WORKER_MISSING_GUSTO / OVERTIME_DETECTED),
// so the readiness pre-check does NOT also persist them — it avoids duplicate rows while still surfacing
// them in its in-memory summary + Slack card. Everything else (approval, punch, discrepancy, duplicate
// mapping, stale/unavailable, missing rate) is readiness-owned and reconcilable via its RDY: detect keys.
const SYNC_OWNED = new Set(["MISSING_GUSTO_MAPPING", "OVERTIME"]);

/** Persist a readiness assessment's exceptions into the hr_exceptions queue (idempotent on detect_key).
 *  Returns how many NEW exceptions were opened. Reuses the existing queue — no parallel store. */
export function persistReadinessExceptions(r: PayrollReadiness): { opened: number } {
  let opened = 0;
  for (const e of r.exceptions) {
    if (SYNC_OWNED.has(e.type)) continue; // the sync engine owns these — don't duplicate
    const workerId = e.connecteamUserId != null ? getWorkerByConnecteamId(e.connecteamUserId)?.id ?? null : null;
    const created = upsertException({
      workerId,
      workerLabel: e.workerLabel,
      severity: e.severity,
      type: e.type,
      description: `${e.description} — ${e.ownerAction}`,
      source: e.source,
      detectKey: e.detectKey,
    });
    if (created) opened++;
  }
  return { opened };
}

export interface ReconcileResult {
  ok: boolean;
  cleared: boolean;
  detail: string;
}

/**
 * Reconcile a readiness exception against the AUTHORITATIVE source (spec §6): a human marking it done — or a
 * Slack button — is NOT proof the underlying record changed. For an approval/punch/discrepancy exception we
 * re-read Connecteam and only auto-RESOLVE when the live record now clears. Mapping/rate blockers are
 * resolved by the Workers-tab edit (which re-reads on the next sync), so here we re-check and report.
 */
export async function reconcileReadinessException(exceptionId: string, actor: string): Promise<ReconcileResult> {
  const exc = listExceptions().find((e) => e.id === exceptionId);
  if (!exc) return { ok: false, cleared: false, detail: "exception not found" };
  if (!exc.detectKey?.startsWith("RDY:")) {
    return { ok: false, cleared: false, detail: "not a readiness exception — resolve it in the Exceptions tab" };
  }
  // detectKey = RDY:<start>:<end>:<workerKey>:<TYPE>
  const parts = exc.detectKey.split(":");
  const start = parts[1];
  const end = parts[2];
  const type = parts[parts.length - 1];
  const workerKey = parts.slice(3, parts.length - 1).join(":");

  // Period-level issues (no single worker) can't be auto-reconciled here — report for human follow-up.
  if (workerKey === "PERIOD" || workerKey.startsWith("gusto:")) {
    return { ok: true, cleared: false, detail: "period-level issue — re-run the pre-check after fixing the source" };
  }

  const uid = workerKey.startsWith("ct:") ? Number(workerKey.slice(3)) : null;
  if (uid == null || !Number.isFinite(uid)) {
    return { ok: true, cleared: false, detail: "worker has no Connecteam id to re-check" };
  }

  const tsDetail = await getTimesheetDetail(start, end);
  if (!tsDetail.ok) return { ok: false, cleared: false, detail: "Connecteam unavailable — cannot verify; leaving exception open" };
  const d = tsDetail.byUser.get(uid);

  let cleared = false;
  let detail = "";
  switch (type) {
    case "UNAPPROVED_TIMESHEET":
      cleared = !!d && d.approvalKnown && (d.unapprovedHours ?? 0) === 0;
      detail = cleared ? "Connecteam now shows the timesheet fully approved." : "Connecteam still shows unapproved time — not cleared.";
      break;
    case "APPROVAL_UNVERIFIED":
      cleared = !!d && d.approvalKnown && (d.unapprovedHours ?? 0) === 0;
      detail = cleared ? "Approval is now confirmed in Connecteam." : "Approval still cannot be confirmed — not cleared.";
      break;
    case "MISSING_PUNCH":
      cleared = !!d && !d.openPunch;
      detail = cleared ? "No open punch remains in Connecteam." : "The open punch is still present — not cleared.";
      break;
    default:
      // SCHEDULE_DISCREPANCY / OVERTIME are informational — a human confirms them in the Exceptions tab.
      return { ok: true, cleared: false, detail: "this exception is reviewed manually (confirm in the Exceptions tab)" };
  }

  if (cleared) resolveException(exc.id, { status: "RESOLVED", resolution: `Reconciled against Connecteam: ${detail}`, resolvedBy: actor });
  return { ok: true, cleared, detail };
}

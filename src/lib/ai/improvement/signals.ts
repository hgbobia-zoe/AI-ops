// Self-Improvement Controller — SIGNAL TRIGGERS (Phase 2). The app notices its OWN problems and files
// SCOPED improvement runs. Deterministic by design: a trigger only ever OPENS a run with an explicit,
// non-forbidden scope — it never ships anything (the autonomy switches stay off) and never bypasses a gate.
//
// Sources today:
//   • audit_failure — a recurring failed operation in audit_logs (e.g. SHIFT_PUBLISH_CONNECTEAM_FAILED),
//   • runtime_job   — a server job whose latest run FAILED (import ledger ok=false).
//
// A signal is AUTO-OPENABLE only when we have a confident scope that touches NONE of the agent's own
// controls (ALWAYS_FORBIDDEN_PATHS) and the problem recurs; otherwise it is surfaced for a human to scope
// and is never auto-opened. The forbidden-path check in `openFromSignal` is the final net regardless.
//
// PURE core (`deriveSignals`) + thin DB reads (`scanImprovementSignals`) + the open seam (`openFromSignal`).

import { getDb } from "@/lib/db";
import { getLatestImportBySource } from "@/lib/pull/state";
import { isAlwaysForbidden } from "./scope";
import { openImprovementRun } from "./service";
import { listActiveRuns } from "./store";
import type { ImprovementRun, RunScope } from "./types";

export type SignalSource = "audit_failure" | "runtime_job";
export type SignalSeverity = "low" | "medium" | "high";

export interface ImprovementSignal {
  source: SignalSource;
  changeKey: string; //    stable dedup key; carried as the run's requestId so a re-scan can't double-open
  blade: string;
  summary: string;
  problem: string;
  allowedPaths: string[]; // conservative; empty when we can't scope it safely
  count: number; //        observations in the window
  lastAt: string | null;
  severity: SignalSeverity;
  autoOpenable: boolean; // true only with a confident, non-forbidden scope AND the recurrence bar met
}

// A failed operation must recur this many times in the window before it is auto-openable (a one-off may be
// transient; a repeat is a real defect). A failed runtime job is auto-openable at 1 — the job is down now.
const AUDIT_RECUR_MIN = 2;
const WINDOW_DAYS = 7;

// Known failure → safe scope. Only mapped entries can be auto-opened; a few confident mappings beat broad
// guesses. Unmapped (or forbidden-touching) failures surface for a human to scope. Grow this as patterns
// prove out — e.g. GITHUB_PR_MERGE_FAILED / APPROVAL_* are intentionally absent (their fix would touch the
// agent's own controls, which no run may modify).
function scopeForAudit(action: string): { blade: string; allowedPaths: string[] } | null {
  if (action.startsWith("SHIFT_PUBLISH")) {
    return { blade: "scheduling", allowedPaths: ["src/lib/connecteam.ts", "src/lib/scheduling/", "src/app/api/scheduling/"] };
  }
  return null;
}

const JOB_SCOPE: Record<string, { blade: string; allowedPaths: string[] }> = {
  connecteam: { blade: "scheduling", allowedPaths: ["src/lib/connecteam.ts"] },
  "shift-lifecycle": { blade: "scheduling", allowedPaths: ["src/lib/scheduling/"] },
  "route-precheck": { blade: "scheduling", allowedPaths: ["src/lib/scheduling/"] },
  "prep-opportunity": { blade: "risk", allowedPaths: ["src/lib/event/", "src/lib/risk/"] },
  instawork: { blade: "scheduling", allowedPaths: ["src/lib/instawork/"] },
  "people-lifecycle": { blade: "people", allowedPaths: ["src/lib/people/"] },
  "payroll-sync": { blade: "payroll", allowedPaths: ["src/lib/payroll/"] },
  "etalink-premint": { blade: "dispatch", allowedPaths: ["src/lib/eta/"] },
  ubersuggest: { blade: "seo", allowedPaths: ["src/lib/seo/"] },
};

function safeScope(allowedPaths: string[]): boolean {
  return allowedPaths.length > 0 && !allowedPaths.some((p) => isAlwaysForbidden(p));
}

function auditSeverity(count: number): SignalSeverity {
  return count >= 5 ? "high" : count >= AUDIT_RECUR_MIN ? "medium" : "low";
}

export interface RawAuditFailure { action: string; count: number; lastAt: string | null; }
export interface RawJobFailure { key: string; detail: string | null; lastAt: string | null; }

/** PURE: turn raw failure rows into improvement signals, most actionable first. No DB, no IO — unit-tested. */
export function deriveSignals(audits: RawAuditFailure[], jobs: RawJobFailure[]): ImprovementSignal[] {
  const out: ImprovementSignal[] = [];
  for (const a of audits) {
    const sc = scopeForAudit(a.action);
    const allowedPaths = sc?.allowedPaths ?? [];
    out.push({
      source: "audit_failure",
      changeKey: `signal:audit:${a.action}`,
      blade: sc?.blade ?? "unknown",
      summary: `Recurring failure: ${a.action} (${a.count}x in ${WINDOW_DAYS}d)`,
      problem: `The operation ${a.action} failed ${a.count} time(s) in the last ${WINDOW_DAYS} days. Investigate the cause and fix it so it stops failing.`,
      allowedPaths,
      count: a.count,
      lastAt: a.lastAt,
      severity: auditSeverity(a.count),
      autoOpenable: safeScope(allowedPaths) && a.count >= AUDIT_RECUR_MIN,
    });
  }
  for (const j of jobs) {
    const sc = JOB_SCOPE[j.key] ?? null;
    const allowedPaths = sc?.allowedPaths ?? [];
    out.push({
      source: "runtime_job",
      changeKey: `signal:job:${j.key}`,
      blade: sc?.blade ?? "back-office",
      summary: `Runtime job failing: ${j.key}`,
      problem: `The scheduled job "${j.key}" last run FAILED${j.detail ? ` — ${j.detail}` : ""}. Investigate and fix the job.`,
      allowedPaths,
      count: 1,
      lastAt: j.lastAt,
      severity: "medium",
      autoOpenable: safeScope(allowedPaths),
    });
  }
  const rank: Record<SignalSeverity, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((x, y) => rank[x.severity] - rank[y.severity] || y.count - x.count);
}

/** Read the app's failure signals from the DB + ledger and derive improvement candidates. Never throws. */
export function scanImprovementSignals(now: Date = new Date()): ImprovementSignal[] {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  let audits: RawAuditFailure[] = [];
  try {
    const rows = getDb()
      .prepare("SELECT action, count(*) c, max(ts) last_ts FROM audit_logs WHERE action LIKE '%FAILED%' AND ts >= ? GROUP BY action")
      .all(since) as { action: string; c: number; last_ts: string | null }[];
    audits = rows.map((r) => ({ action: r.action, count: Number(r.c), lastAt: r.last_ts }));
  } catch {
    /* audit table unavailable — no audit signals */
  }

  let jobs: RawJobFailure[] = [];
  try {
    const latest = getLatestImportBySource();
    jobs = Object.entries(latest)
      .filter(([, row]) => row && row.ok === false)
      .map(([key, row]) => ({ key, detail: row.detail, lastAt: row.ts }));
  } catch {
    /* ledger unavailable */
  }

  return deriveSignals(audits, jobs);
}

export interface OpenFromSignalResult { opened?: ImprovementRun; skipped?: string; }

/** Open a scoped improvement run from a signal. Deterministic guards, in order: must be auto-openable; its
 *  scope must touch no always-forbidden path (defense in depth); and no active run may already track the same
 *  signal (dedup by requestId=changeKey). Opening a run SHIPS NOTHING — it files a human-supervised work item;
 *  the autonomy switches (merge/deploy) stay off. */
export function openFromSignal(sig: ImprovementSignal, startedBy = "self-audit"): OpenFromSignalResult {
  if (!sig.autoOpenable) return { skipped: "not auto-openable (needs human scoping)" };
  const forbidden = sig.allowedPaths.filter((p) => isAlwaysForbidden(p));
  if (forbidden.length) return { skipped: `scope touches forbidden paths: ${forbidden.join(", ")}` };
  const dup = listActiveRuns().find((r) => r.requestId === sig.changeKey);
  if (dup) return { skipped: `already tracked by ${dup.id}` };
  const scope: RunScope = { blade: sig.blade, summary: sig.summary, problem: sig.problem, allowedPaths: sig.allowedPaths, forbiddenPaths: [] };
  const run = openImprovementRun({ requestId: sig.changeKey, scope, startedBy });
  return { opened: run };
}

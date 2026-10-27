// Gusto remote-browser push — the office runner reports job progress + the final outcome here. Token-gated,
// fail-CLOSED. The runner POSTs { id, status, ... }:
//   status 'signin_required' | 'pushing'  → reportProgress (live phase / draft id / session mode / partial workers)
//   status 'done'                         → completeJob (final workers[] + sessionMode; `aborted` for a clean bail)
//   status 'failed'                       → failJob (error)
// On a terminal update we ALSO mirror the outcome into the shared "last push" status (gustoPushState) + the
// import ledger + audit, EXACTLY like the extension's /push-result route — so /payroll's "Last push" line and
// the audit trail are identical whichever path (extension or remote browser) did the write.

import { NextResponse } from "next/server";
import { completeJob, failJob, reportProgress, getJob, type GustoPushJob } from "@/lib/payroll/gustoRunnerJobs";
import { checkGustoRunnerToken } from "@/lib/payroll/gustoRunnerAuth";
import { recordGustoPushResult, type GustoPushResult, type GustoPushWorkerResult } from "@/lib/payroll/gustoPushState";
import { logImport } from "@/lib/pull/state";

export const dynamic = "force-dynamic";

interface IncomingWorker {
  gustoMemberId?: unknown;
  name?: unknown;
  outcome?: unknown;
  regularHours?: unknown;
  overtimeHours?: unknown;
  reason?: unknown;
}
interface IncomingBody {
  id?: unknown;
  status?: unknown;
  phase?: unknown;
  draftPayrollId?: unknown;
  sessionMode?: unknown;
  aborted?: unknown;
  error?: unknown;
  workers?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function coerceWorkers(raw: unknown): GustoPushWorkerResult[] {
  const list = Array.isArray(raw) ? (raw as IncomingWorker[]) : [];
  const out: GustoPushWorkerResult[] = [];
  for (const w of list) {
    const id = str(w.gustoMemberId);
    const outcome = str(w.outcome);
    if (!id || (outcome !== "pushed" && outcome !== "skipped" && outcome !== "failed")) continue;
    out.push({
      gustoMemberId: id,
      name: str(w.name),
      outcome,
      regularHours: numOrNull(w.regularHours),
      overtimeHours: numOrNull(w.overtimeHours),
      reason: str(w.reason),
    });
  }
  return out;
}

const sessionModeOf = (v: unknown): "captured" | "generated" | null => (v === "captured" || v === "generated" ? v : null);

/** Mirror a terminal job outcome into the shared last-push status + ledger + audit (same shape as the
 *  extension /push-result path, so both paths produce identical /payroll status + audit). Best-effort. */
function recordTerminal(job: GustoPushJob): void {
  const pushed = job.workers.filter((w) => w.outcome === "pushed").length;
  const skipped = job.workers.filter((w) => w.outcome === "skipped").length;
  const failed = job.workers.filter((w) => w.outcome === "failed").length;
  const aborted = job.status === "failed" ? job.error ?? "failed" : job.aborted;
  const ok = job.status === "done" && !job.aborted && failed === 0;
  const result: GustoPushResult = {
    at: new Date().toISOString(),
    ok,
    aborted: aborted ?? null,
    draftPayrollId: job.draftPayrollId,
    periodStart: job.periodStart,
    periodEnd: job.periodEnd,
    pushed,
    skipped,
    failed,
    workers: job.workers,
    initiatedBy: job.requester,
    sessionMode: job.sessionMode,
  };
  try { recordGustoPushResult(result); } catch { /* best-effort */ }
  try {
    logImport("gusto_push", ok, {
      rowsWritten: pushed,
      rowsSkipped: skipped,
      detail: aborted ? `aborted: ${aborted}` : `${pushed} pushed, ${skipped} skipped, ${failed} failed (remote browser)`,
    });
  } catch { /* best-effort */ }
}

async function auditTerminal(job: GustoPushJob): Promise<void> {
  try {
    const pushed = job.workers.filter((w) => w.outcome === "pushed").length;
    const skipped = job.workers.filter((w) => w.outcome === "skipped").length;
    const failed = job.workers.filter((w) => w.outcome === "failed").length;
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({
      actor: job.requester ?? "Gusto remote-browser runner",
      action: "payroll.gusto.push_hours",
      entity: "gusto_draft_payroll",
      entityId: job.draftPayrollId ?? `${job.periodStart ?? "?"}..${job.periodEnd ?? "?"}`,
      after: { via: "remote_browser", status: job.status, aborted: job.aborted, pushed, skipped, failed, sessionMode: job.sessionMode, workers: job.workers },
    });
  } catch { /* audit is best-effort */ }
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = checkGustoRunnerToken(req.headers.get("x-gusto-runner-token"));
  if (auth === "unconfigured") return NextResponse.json({ error: "runner_disabled" }, { status: 503 });
  if (auth === "forbidden") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: IncomingBody;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const id = str(body.id);
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
  const status = str(body.status);

  let job: GustoPushJob | null = null;
  if (status === "done") {
    job = completeJob(id, {
      workers: body.workers !== undefined ? coerceWorkers(body.workers) : undefined,
      sessionMode: sessionModeOf(body.sessionMode),
      draftPayrollId: str(body.draftPayrollId),
      aborted: str(body.aborted),
    });
    if (job) { recordTerminal(job); await auditTerminal(job); }
  } else if (status === "failed") {
    job = failJob(id, str(body.error) ?? "unknown error");
    if (job) { recordTerminal(job); await auditTerminal(job); }
  } else if (status === "signin_required" || status === "pushing") {
    job = reportProgress(id, {
      status,
      phase: str(body.phase),
      draftPayrollId: str(body.draftPayrollId),
      sessionMode: sessionModeOf(body.sessionMode),
      workers: body.workers !== undefined ? coerceWorkers(body.workers) : undefined,
    });
  } else {
    // No status change — a bare phase/worker progress tick on the current active state.
    job = reportProgress(id, {
      phase: str(body.phase),
      draftPayrollId: str(body.draftPayrollId),
      sessionMode: sessionModeOf(body.sessionMode),
      workers: body.workers !== undefined ? coerceWorkers(body.workers) : undefined,
    });
  }

  // null = the job was terminal/canceled already (e.g. a human canceled). Tell the runner so it stops.
  if (!job) {
    const current = getJob(id);
    return NextResponse.json({ ok: false, reason: "not_updatable", job: current }, { status: 200 });
  }
  return NextResponse.json({ ok: true, job });
}

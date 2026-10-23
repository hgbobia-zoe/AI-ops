// FI Stage 7a — reconciliation-run RECOMPUTE (the impure WIRING glue). Called from the risk scan right
// after the labor + cost-family recomputes, so each project whose ledger just moved gets a durable run of
// its financial state on the same cadence. This module is the impure boundary: it reads the DB (current
// snapshot via projectFinancials + the prior run) and appends a new run; the phase + variance math lives
// in the PURE, tested reconciliationRun.ts.
//
// HONESTY / IDEMPOTENCY: a run is APPENDED ONLY when the material figures moved since the project's last
// run (sig dedup, exactly like event_snapshots) — a repeated scan with no data change writes nothing, so
// the history stays a faithful record of real settlement, not scan noise. seq increments only on a real
// change; appendReconciliationRun is INSERT OR IGNORE on (project, seq) so a double-fire can't duplicate.
// The whole recompute is wrapped by the caller in try/catch — a failure here must never break the scan.

import { reconciliationRunsConfig } from "./config";
import { projectFinancials } from "./service";
import { computeReconciliationRun } from "./reconciliationRun";
import { getProjectIdsWithCostActivity, getLatestReconciliationRun, appendReconciliationRun } from "@/lib/db/repo";

export interface ReconciliationRunRecomputeResult {
  projectsConsidered: number;
  runsWritten: number;
  skipped?: string;
}

/** Produce a reconciliation run for every project whose cost ledger moved on the scanned days. Idempotent:
 *  re-running with no data change writes nothing. Deterministic given the DB; `now` is injectable for tests. */
export function recomputeReconciliationRuns(days: string[], now: Date = new Date()): ReconciliationRunRecomputeResult {
  if (!reconciliationRunsConfig().enabled) return { projectsConsidered: 0, runsWritten: 0, skipped: "disabled" };
  const projectIds = getProjectIdsWithCostActivity(days);
  if (projectIds.length === 0) return { projectsConsidered: 0, runsWritten: 0, skipped: "no-projects" };

  let runsWritten = 0;
  for (const projectId of projectIds) {
    const snapshot = projectFinancials(projectId, now);
    if (!snapshot) continue; // not in the bookings pull yet — no snapshot to record (UNAVAILABLE, not a run)
    const latest = getLatestReconciliationRun(projectId);
    const prior = latest ? { snapshot: latest.snapshot, seq: latest.seq, phase: latest.phase, capturedAt: latest.capturedAt } : null;
    const result = computeReconciliationRun({ snapshot, prior });
    if (!result.changed) continue; // nothing moved since the last run → no new run (sig dedup)
    const wrote = appendReconciliationRun(
      {
        projectId,
        seq: (latest?.seq ?? 0) + 1,
        phase: result.phase,
        status: result.figures.status,
        revenue: result.figures.revenue,
        collected: result.figures.collected,
        directCost: result.figures.directCost,
        contribution: result.figures.contribution,
        marginPct: result.figures.marginPct,
        balanced: result.figures.balanced,
        residual: result.figures.residual,
        snapshot,
        variance: prior ? result.variance : null,
        sig: result.sig,
      },
      now,
    );
    if (wrote) runsWritten++;
  }
  return { projectsConsidered: projectIds.length, runsWritten };
}

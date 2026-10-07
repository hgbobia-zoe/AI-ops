// The payroll sync ENGINE — ONE implementation shared by manual "Sync Now" and the (future) Monday
// scheduler. Pipeline: pull Connecteam time → normalize → match workers → classify → detect exceptions →
// record an immutable run. IDEMPOTENT: re-running the same period never duplicates hours (time entries are
// upserted on a source key) and never re-opens resolved exceptions (dedup on detect_key).
//
// Slice 1 covers ingestion + matching + exception detection. The Gusto PUSH (create/update time entries in
// the payroll SoR) is the next slice: it runs only on an approved, clean period, so this engine stops at
// "READY / REQUIRES_REVIEW" and records gusto_ok = null (not configured / not pushed).

import { createHash } from "node:crypto";
import { getActualHours } from "@/lib/connecteam";
import { getUsers } from "@/lib/connecteam";
import { gustoConfigured } from "./gusto";
import {
  ensureWorkerFromConnecteam, upsertTimeEntry, upsertException, startSyncRun, finishSyncRun,
} from "./store";
import type { SyncStatus, SyncTrigger } from "./types";

export interface SyncInput {
  periodStart: string;
  periodEnd: string;
  trigger: SyncTrigger;
  actor: string | null;
}

export interface SyncSummary {
  runId: string;
  status: SyncStatus;
  workersProcessed: number;
  totalHours: number | null;
  hoursReady: number | null;
  exceptions: number;
  reviewCount: number;
  gustoCreated: number;
  gustoUpdated: number;
  skipped: number;
  connecteamOk: boolean;
  gustoOk: boolean | null;
  message: string;
}

const OVERTIME_WEEKLY_THRESHOLD = 40; // US weekly OT line; surfaced as a MEDIUM exception (not auto-split yet)

export async function runPayrollSync(input: SyncInput): Promise<SyncSummary> {
  const runId = startSyncRun({ periodStart: input.periodStart, periodEnd: input.periodEnd, trigger: input.trigger, initiatedBy: input.actor });

  // 1) Pull the operational time source. If it's unavailable, FAIL cleanly — never push partial payroll.
  const [roster, actual] = await Promise.all([getUsers(), getActualHours(input.periodStart, input.periodEnd)]);
  if (!actual.ok) {
    finishSyncRun(runId, { status: "FAILED", connecteamOk: false, gustoOk: null, detail: "Connecteam time source unavailable — no hours pulled." });
    return summary(runId, "FAILED", { connecteamOk: false, message: "Connecteam unavailable — nothing was synced." });
  }

  let workersProcessed = 0;
  let totalHours = 0;
  let newExceptions = 0;
  let reviewCount = 0;

  // 2) Normalize + match every worker who logged time this period.
  for (const [userId, hours] of actual.hours.entries()) {
    if (!(hours > 0)) continue;
    const member = roster.get(userId);
    const name = member?.name ?? `#${userId}`;
    const worker = ensureWorkerFromConnecteam({ connecteamUserId: userId, name, email: member?.email ?? null });
    workersProcessed++;
    totalHours += hours;

    const rounded = Math.round(hours * 100) / 100;
    const checksum = createHash("sha1").update(`${userId}|${input.periodStart}|${input.periodEnd}|${rounded}`).digest("hex");
    upsertTimeEntry({
      syncRunId: runId, workerId: worker.id, periodStart: input.periodStart, periodEnd: input.periodEnd,
      hours: rounded, hoursType: "REGULAR", sourceSystem: "connecteam", sourceRecordId: `ct:${userId}`, checksum, status: "MATCHED",
    });

    // 3) Exception detection (deterministic). Missing Gusto mapping blocks payment → HIGH + counts for review.
    if (!worker.gustoId) {
      const opened = upsertException({
        syncRunId: runId, workerId: worker.id, workerLabel: name, severity: "HIGH", type: "WORKER_MISSING_GUSTO",
        source: "reconciliation", description: `${name} worked ${rounded}h but is not mapped to Gusto — cannot be paid until mapped.`,
        detectKey: `${input.periodStart}:${input.periodEnd}:${worker.id}:MISSING_GUSTO`,
      });
      if (opened) newExceptions++;
      reviewCount++;
    }
    if (hours > OVERTIME_WEEKLY_THRESHOLD) {
      const opened = upsertException({
        syncRunId: runId, workerId: worker.id, workerLabel: name, severity: "MEDIUM", type: "OVERTIME_DETECTED",
        source: "connecteam", description: `${name} logged ${rounded}h (> ${OVERTIME_WEEKLY_THRESHOLD}h) — review overtime before payroll.`,
        detectKey: `${input.periodStart}:${input.periodEnd}:${worker.id}:OVERTIME`,
      });
      if (opened) newExceptions++;
    }
  }

  // 4) Decide run status. Gusto is not pushed in this slice → gustoOk stays null. A clean period is READY;
  // anything needing a human (missing mapping, etc.) is REQUIRES_REVIEW.
  const status: SyncStatus = reviewCount > 0 ? "REQUIRES_REVIEW" : "READY";
  const roundedTotal = Math.round(totalHours * 10) / 10;
  finishSyncRun(runId, {
    status, workersProcessed, totalHours: roundedTotal, hoursReady: roundedTotal,
    exceptionsCount: newExceptions, reviewCount, gustoCreated: 0, gustoUpdated: 0, skipped: 0,
    connecteamOk: true, gustoOk: gustoConfigured() ? false : null,
    detail: JSON.stringify({ gustoConfigured: gustoConfigured(), note: "Ingestion + matching only; Gusto push not yet enabled." }),
  });

  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({
      actor: input.actor ?? "system", action: "payroll.sync", entity: "hr_sync_run", entityId: runId,
      after: { period: `${input.periodStart}..${input.periodEnd}`, trigger: input.trigger, status, workersProcessed, totalHours: roundedTotal, reviewCount },
    });
  } catch {
    /* audit is best-effort */
  }

  return summary(runId, status, {
    workersProcessed, totalHours: roundedTotal, hoursReady: roundedTotal, exceptions: newExceptions, reviewCount,
    connecteamOk: true, gustoOk: gustoConfigured() ? false : null,
    message: status === "READY"
      ? `Pulled ${roundedTotal}h for ${workersProcessed} workers. Ready for review.`
      : `Pulled ${roundedTotal}h for ${workersProcessed} workers. ${reviewCount} need review before payroll.`,
  });
}

function summary(runId: string, status: SyncStatus, p: Partial<SyncSummary> & { message: string }): SyncSummary {
  return {
    runId, status,
    workersProcessed: p.workersProcessed ?? 0, totalHours: p.totalHours ?? null, hoursReady: p.hoursReady ?? null,
    exceptions: p.exceptions ?? 0, reviewCount: p.reviewCount ?? 0,
    gustoCreated: p.gustoCreated ?? 0, gustoUpdated: p.gustoUpdated ?? 0, skipped: p.skipped ?? 0,
    connecteamOk: p.connecteamOk ?? false, gustoOk: p.gustoOk ?? null, message: p.message,
  };
}

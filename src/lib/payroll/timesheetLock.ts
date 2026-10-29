// Connecteam timesheet FINALIZE — the write that makes "approve payroll in the app" propagate into
// Connecteam. Connecteam has no admin-approval API; the only finalization write is day-locking. So when
// payroll is approved in Zoe for a worker, we lock exactly their WORKED days (days with hours) in the
// period on Connecteam's time clock. Zoe is the approval AUTHORITY for this business (they don't use
// Connecteam's admin-approval column); the lock is how that decision is reflected downstream.
//
// HONEST by construction: every per-worker outcome is recorded (LOCKED / FAILED / NA) via upsertTimesheetLock
// so the readiness model can show the real result. A failed Connecteam finalize NEVER reads as success — the
// worker is "approved in Zoe" but flagged "Connecteam finalize failed — retry". Idempotent: re-locking
// already-locked days is a safe Connecteam no-op, so re-approving simply retries any FAILED worker.
//
// READ/WRITE Connecteam only; no payroll submission. Key-gated: with Connecteam unconfigured, every worker is
// recorded NA (the Zoe approval still stands; there is simply nothing to lock).

import { getTimesheetDetail, getPrimaryTimeClockId, lockUserDays, connecteamConfigured } from "@/lib/connecteam";
import { upsertTimesheetLock, listTimesheetLocks } from "./store";
import type { PayPeriod, CtLockStatus } from "./types";

export interface LockTarget {
  workerKey: string; // ct:<userId> | hw:<id>
  name: string;
  connecteamUserId: number | null;
}

export interface WorkerLockOutcome {
  workerKey: string;
  name: string;
  connecteamUserId: number | null;
  status: CtLockStatus; // LOCKED | FAILED | NA (finalize never writes UNLOCKED — that's the unlock path)
  detail: string;
  dates: string[];
}

export interface FinalizeResult {
  ok: boolean; // true when no worker FAILED (locked + NA are both fine)
  locked: number;
  failed: number;
  na: number;
  outcomes: WorkerLockOutcome[];
}

/**
 * Finalize (lock) the approved workers' worked days in Connecteam and record each outcome. Resolves the time
 * clock + pulls the period timesheet ONCE, then batches each worker's own worked dates (lockUserDays caps at
 * 50/call). A worker with no Connecteam id or no worked days is recorded NA (nothing to lock). Connecteam
 * being unreachable, or the lock call failing, records FAILED — the Zoe approval stands, but we never claim
 * the Connecteam finalize happened. Writes are per-worker so a partial failure is isolated + retryable.
 */
export async function finalizeApprovedTimesheets(period: PayPeriod, targets: LockTarget[], approvedBy: string | null): Promise<FinalizeResult> {
  const outcomes: WorkerLockOutcome[] = [];
  const approvedAt = new Date().toISOString();

  const record = (t: LockTarget, status: CtLockStatus, detail: string, dates: string[]): void => {
    upsertTimesheetLock({
      periodStart: period.start, periodEnd: period.end, workerKey: t.workerKey,
      connecteamUserId: t.connecteamUserId, approvedBy, approvedAt, lockStatus: status, lockDetail: detail, lockedDates: dates,
    });
    outcomes.push({ workerKey: t.workerKey, name: t.name, connecteamUserId: t.connecteamUserId, status, detail, dates });
  };

  if (!connecteamConfigured()) {
    // Nothing to lock — but the Zoe approval still satisfies the gate. Record NA (never FAILED).
    for (const t of targets) record(t, "NA", "Connecteam not connected — approved in Zoe only.", []);
    return summarize(outcomes);
  }

  const [tsDetail, timeClockId] = await Promise.all([getTimesheetDetail(period.start, period.end), getPrimaryTimeClockId()]);

  for (const t of targets) {
    if (t.connecteamUserId == null) {
      record(t, "NA", "No Connecteam user — approved in Zoe only (nothing to finalize).", []);
      continue;
    }
    if (!tsDetail.ok) {
      record(t, "FAILED", "Connecteam unreachable — approved in Zoe, but the timesheet could not be finalized. Retry.", []);
      continue;
    }
    const dates = tsDetail.byUser.get(t.connecteamUserId)?.workedDates ?? [];
    if (dates.length === 0) {
      record(t, "NA", "No worked days in Connecteam for this period — nothing to finalize.", []);
      continue;
    }
    if (timeClockId == null) {
      record(t, "FAILED", "Approved in Zoe, but no Connecteam time clock could be resolved to finalize. Retry.", []);
      continue;
    }
    const r = await lockUserDays(timeClockId, t.connecteamUserId, dates, true);
    if (r.ok) {
      record(t, "LOCKED", `Locked ${r.dates.length} day${r.dates.length === 1 ? "" : "s"} in Connecteam.`, r.dates);
    } else {
      record(t, "FAILED", `Approved in Zoe, but the Connecteam finalize failed (${r.code ?? r.error ?? `HTTP ${r.status}`}). Retry.`, dates);
    }
  }
  return summarize(outcomes);
}

function summarize(outcomes: WorkerLockOutcome[]): FinalizeResult {
  const locked = outcomes.filter((o) => o.status === "LOCKED").length;
  const failed = outcomes.filter((o) => o.status === "FAILED").length;
  const na = outcomes.filter((o) => o.status === "NA").length;
  return { ok: failed === 0, locked, failed, na, outcomes };
}

export interface UnlockResult {
  ok: boolean; // true when nothing was left physically locked against our intent (409 conflicts set this false)
  unlocked: number; // records whose Zoe approval we withdrew
  conflicts: number; // days Connecteam refused to unlock (DAYS_IN_APPROVED_PERIOD) — still locked there
  detail: string;
}

/**
 * Reverse an approval: withdraw the Zoe approval marker for each locked worker and unlock their days in
 * Connecteam. The Zoe marker is withdrawn regardless (status → UNLOCKED), so the timesheet-approval gate
 * honestly reverts. A Connecteam 409 (DAYS_IN_APPROVED_PERIOD — the day sits inside an already-approved
 * Connecteam payroll period) is SURFACED as a conflict, never crashed: those days stay locked in Connecteam
 * and must be unlocked there. `only` restricts to specific worker keys (default: all locked in the period).
 */
export async function unlockApprovedTimesheets(period: PayPeriod, only?: string[]): Promise<UnlockResult> {
  const locks = listTimesheetLocks(period.start, period.end);
  const onlySet = only && only.length ? new Set(only) : null;
  const timeClockId = connecteamConfigured() ? await getPrimaryTimeClockId() : null;
  let unlocked = 0;
  let conflicts = 0;

  for (const [key, rec] of locks) {
    if (onlySet && !onlySet.has(key)) continue;
    if (rec.lockStatus === "UNLOCKED") continue;

    let detail = "Zoe approval withdrawn.";
    if (rec.lockStatus === "LOCKED" && rec.connecteamUserId != null && rec.lockedDates.length > 0 && timeClockId != null) {
      const r = await lockUserDays(timeClockId, rec.connecteamUserId, rec.lockedDates, false);
      if (!r.ok) {
        conflicts++;
        detail = `Zoe approval withdrawn; Connecteam did NOT unlock (${r.code ?? r.error ?? `HTTP ${r.status}`}) — those days remain locked in Connecteam.`;
      } else {
        detail = `Zoe approval withdrawn; ${r.dates.length} day${r.dates.length === 1 ? "" : "s"} unlocked in Connecteam.`;
      }
    }
    upsertTimesheetLock({
      periodStart: period.start, periodEnd: period.end, workerKey: key, connecteamUserId: rec.connecteamUserId,
      approvedBy: rec.approvedBy, approvedAt: rec.approvedAt, lockStatus: "UNLOCKED", lockDetail: detail, lockedDates: rec.lockedDates,
    });
    unlocked++;
  }
  return {
    ok: conflicts === 0,
    unlocked,
    conflicts,
    detail: conflicts > 0 ? `${unlocked} unapproved; ${conflicts} still locked in Connecteam (in an approved payroll period).` : `${unlocked} unapproved${unlocked ? " and unlocked in Connecteam" : ""}.`,
  };
}

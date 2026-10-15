// Connecteam two-way sync — the DB/network wrapper around the pure planner (connecteamImport.ts). This is
// the side-effecting half: it reads the day's Connecteam shifts + the app's shifts, asks the planner what
// to do, and applies the plan IDEMPOTENTLY (re-running with no changes is a no-op — no shift thrash). It
// adds NO new Connecteam writes: the app -> Connecteam direction stays the existing, human-gated publish
// path. See docs/connecteam-two-way-sync.md.
//
// SAFETY / HONESTY (house law):
//   - Connecteam unreachable (ok:false) -> do NOTHING. Never delete or overwrite an app shift on an unknown.
//   - A vanished Connecteam copy is FLAGGED needs_review, never hard-deleted.
//   - A both-sides conflict with no reliable Connecteam timestamp is FLAGGED, never silently clobbered.
//   - An env kill-switch (CONNECTEAM_IMPORT_DISABLED) turns the whole importer off without a deploy.

import { getCrewForDateSafe, connecteamConfigured } from "@/lib/connecteam";
import { insertAudit } from "@/lib/db/repo";
import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import { createIngestedShift, getShiftsForDate, updateShift } from "./store";
import { planReconcile, type ReconcilePlan } from "./connecteamImport";

/** How many days forward (including today) the runtime sweep reconciles. Bounds the write surface. */
const SYNC_HORIZON_DAYS = 14;

export function connecteamImportEnabled(): boolean {
  return connecteamConfigured() && process.env.CONNECTEAM_IMPORT_DISABLED !== "1";
}

export interface ReconcileDayResult {
  date: string;
  reachable: boolean;
  created: number;
  updated: number; // content applied (Connecteam won)
  baselined: number; // bookkeeping-only (first adoption of an app-pushed shift)
  flagged: number; // needs_review (conflict / vanished)
  unchanged: number;
}

/** Apply a computed plan to the DB. Idempotent + safe. Pure-ish given the plan (only writes what it says). */
export function applyReconcilePlan(plan: ReconcilePlan, actor = "connecteam-sync"): ReconcileDayResult {
  const res: ReconcileDayResult = {
    date: plan.date,
    reachable: plan.reachable,
    created: 0,
    updated: 0,
    baselined: 0,
    flagged: 0,
    unchanged: plan.unchanged,
  };
  if (!plan.reachable) return res;
  const now = new Date().toISOString();

  for (const c of plan.creates) {
    const ct = c.ct;
    const created = createIngestedShift({
      date: ct.date,
      role: ct.role,
      headcount: ct.headcount,
      startTime: ct.startTime,
      endTime: ct.endTime,
      windowKnown: ct.windowKnown,
      location: ct.location,
      eventLabel: ct.eventLabel,
      assignees: ct.assignees,
      connecteamShiftId: ct.connecteamShiftId,
      connecteamSchedulerId: ct.schedulerId,
      connecteamContentHash: ct.contentHash,
      connecteamLastModified: ct.lastModifiedIso,
      connecteamSyncedAt: now,
    });
    res.created += 1;
    audit(actor, "SHIFT_SYNC_IMPORTED", created.id, { connecteamShiftId: ct.connecteamShiftId, date: ct.date, role: ct.role, assignees: ct.assignees.length });
  }

  for (const u of plan.updates) {
    if (u.applyContent) {
      updateShift(u.appShiftId, {
        role: u.ct.role,
        headcount: u.ct.headcount,
        startTime: u.ct.startTime,
        endTime: u.ct.endTime,
        windowKnown: u.ct.windowKnown,
        location: u.ct.location,
        eventLabel: u.ct.eventLabel,
        assignees: u.ct.assignees,
        connecteamContentHash: u.ct.contentHash,
        connecteamSyncedAt: now,
        connecteamLastModified: u.ct.lastModifiedIso,
        syncStatus: "synced",
        syncNote: null,
      });
      res.updated += 1;
      audit(actor, "SHIFT_SYNC_UPDATED", u.appShiftId, { connecteamShiftId: u.ct.connecteamShiftId, reason: u.reason });
    } else {
      // Baseline: record the Connecteam hash so future edits are detectable; do NOT touch app content.
      updateShift(u.appShiftId, {
        connecteamContentHash: u.ct.contentHash,
        connecteamSyncedAt: now,
        connecteamLastModified: u.ct.lastModifiedIso,
        syncStatus: "synced",
        syncNote: null,
      });
      res.baselined += 1;
    }
  }

  for (const f of plan.flags) {
    updateShift(f.appShiftId, { syncStatus: "needs_review", syncNote: f.note });
    res.flagged += 1;
    audit(actor, "SHIFT_SYNC_NEEDS_REVIEW", f.appShiftId, { connecteamShiftId: f.connecteamShiftId, reason: f.reason, note: f.note });
  }

  return res;
}

function audit(actor: string, action: string, entityId: string, after: Record<string, unknown>): void {
  try {
    insertAudit({ actor, action, entity: "staff_shift", entityId, after });
  } catch {
    /* audit must never block a sync */
  }
}

/** Reconcile ONE day: read Connecteam + app shifts, plan, apply. Honest-when-unreachable (does nothing). */
export async function reconcileConnecteamForDate(date: string, actor = "connecteam-sync"): Promise<ReconcileDayResult> {
  const crew = await getCrewForDateSafe(date);
  const appShifts = getShiftsForDate(date);
  const plan = planReconcile({ date, connecteam: crew, appShifts });
  return applyReconcilePlan(plan, actor);
}

export interface ImportTickResult {
  ok: boolean;
  detail: string;
  days: number;
  created: number;
  updated: number;
  baselined: number;
  flagged: number;
  unreachableDays: number;
}

/**
 * Runtime sweep: reconcile today..+SYNC_HORIZON_DAYS. For the server-side tick (RUNTIME_TOKEN-gated). Never
 * throws. A day Connecteam couldn't be reached is counted and SKIPPED (no writes) — an outage never wipes
 * the app schedule. ok is false only when the importer is enabled but EVERY day was unreachable (a real
 * outage worth surfacing), true otherwise (incl. "disabled"/"not configured" no-ops).
 */
export async function runConnecteamImportTick(): Promise<ImportTickResult> {
  if (!connecteamImportEnabled()) {
    return { ok: true, detail: connecteamConfigured() ? "import disabled" : "not configured", days: 0, created: 0, updated: 0, baselined: 0, flagged: 0, unreachableDays: 0 };
  }
  const today = todayInOpsTz();
  const dates = Array.from({ length: SYNC_HORIZON_DAYS }, (_, i) => shiftYmd(today, i));
  let created = 0;
  let updated = 0;
  let baselined = 0;
  let flagged = 0;
  let unreachable = 0;
  let reachableDays = 0;
  for (const d of dates) {
    try {
      const r = await reconcileConnecteamForDate(d);
      if (!r.reachable) {
        unreachable += 1;
        continue;
      }
      reachableDays += 1;
      created += r.created;
      updated += r.updated;
      baselined += r.baselined;
      flagged += r.flagged;
    } catch {
      unreachable += 1; // a thrown day is an unknown, not a zero — skip it
    }
  }
  const ok = reachableDays > 0; // enabled + configured but nothing reachable = a real outage
  const detail = reachableDays === 0
    ? `Connecteam unreachable (${unreachable}/${dates.length} days) — skipped, no app shifts changed`
    : `${reachableDays}/${dates.length} days synced: ${created} imported, ${updated} updated, ${flagged} need review${baselined ? `, ${baselined} baselined` : ""}${unreachable ? `, ${unreachable} day(s) unreachable` : ""}`;
  return { ok, detail, days: reachableDays, created, updated, baselined, flagged, unreachableDays: unreachable };
}

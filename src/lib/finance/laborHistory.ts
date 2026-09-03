// Labor trajectory (MVP4 Phase 3) — snapshots a week's labor plan over time so we can see it move
// from scheduled PLAN → REVISED (schedule changes) → ACTUAL (timesheets fill in). Deduped by a
// signature of the four figures, so a snapshot lands only when something actually changed. Pure
// storage — the finance service feeds it the already-computed numbers (no extra Connecteam calls).

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export interface LaborSnapshotInput {
  weekStart: string; // Sunday YYYY-MM-DD
  plannedHours: number | null;
  plannedCost: number | null;
  actualHours: number | null;
  actualCost: number | null;
}

function sig(s: LaborSnapshotInput): string {
  return JSON.stringify([s.plannedHours, s.plannedCost, s.actualHours, s.actualCost]);
}

/** Snapshot the week's labor only if it differs from the latest one. Returns true if written. */
export function saveLaborSnapshot(s: LaborSnapshotInput, now: Date = new Date()): boolean {
  const db = getDb();
  const g = sig(s);
  const last = db
    .prepare("SELECT sig FROM labor_snapshots WHERE week_start = ? ORDER BY captured_at DESC LIMIT 1")
    .get(s.weekStart) as { sig: string } | undefined;
  if (last && last.sig === g) return false;
  db.prepare(
    `INSERT INTO labor_snapshots (id, week_start, planned_hours, planned_cost, actual_hours, actual_cost, sig, captured_at)
     VALUES (@id,@ws,@ph,@pc,@ah,@ac,@sig,@now)`,
  ).run({
    id: `LS-${randomUUID()}`,
    ws: s.weekStart,
    ph: s.plannedHours,
    pc: s.plannedCost,
    ah: s.actualHours,
    ac: s.actualCost,
    sig: g,
    now: now.toISOString(),
  });
  return true;
}

export interface LaborSnapshotRow {
  weekStart: string;
  plannedHours: number | null;
  plannedCost: number | null;
  actualHours: number | null;
  actualCost: number | null;
  capturedAt: string;
}

/** The week's labor snapshots, oldest→newest (the trajectory). */
export function getLaborTrajectory(weekStart: string): LaborSnapshotRow[] {
  return (
    getDb().prepare("SELECT * FROM labor_snapshots WHERE week_start = ? ORDER BY captured_at ASC").all(weekStart) as Record<string, unknown>[]
  ).map((r) => ({
    weekStart: String(r.week_start),
    plannedHours: r.planned_hours == null ? null : Number(r.planned_hours),
    plannedCost: r.planned_cost == null ? null : Number(r.planned_cost),
    actualHours: r.actual_hours == null ? null : Number(r.actual_hours),
    actualCost: r.actual_cost == null ? null : Number(r.actual_cost),
    capturedAt: String(r.captured_at),
  }));
}

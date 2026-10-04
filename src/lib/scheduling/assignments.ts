// Persistence for shift_assignments — the keystone per-worker entity (one row per shift x worker), plus
// the append-only shift_assignment_events audit log. Mirrors scheduling/store.ts + history/store.ts
// conventions: getDb() directly, a Row interface, a mapper, prefixed-UUID ids, ISO timestamps.
//
// Dual-write / derive (migration I of the design): the engine owns shift_assignments, but keeps
// staff_shifts.assignees in sync (the internal-userId projection) so the existing board + coverage are
// unchanged. The live board still assigns via assignees directly (AddWorkerPanel); backfillAssignments
// derives the per-worker rows FROM assignees + booked Instawork workers, idempotently, so nothing breaks.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { isLiveAssignment } from "./lifecycle";
import type { AssignmentState, ShiftAssignment, ShiftLifecycleState, StaffShift, WorkerKind } from "./types";

interface Row {
  id: string;
  shift_id: string;
  worker_kind: string;
  connecteam_user_id: number | null;
  instawork_worker: string | null;
  instawork_gig_id: string | null;
  display_name: string | null;
  role: string;
  state: string;
  packet_version: string | null;
  packet_sent_at: string | null;
  confirmed_at: string | null;
  confirm_method: string | null;
  clock_in_at: string | null;
  clock_out_at: string | null;
  clock_source: string | null;
  no_show: number;
  temp_reason: string | null;
  route_reason: string | null;
  est_hours: number | null;
  est_rate: number | null;
  est_cost: number | null;
  overridden: number;
  override_reason: string | null;
  created_at: string;
  updated_at: string;
}

function toAssignment(r: Row): ShiftAssignment {
  return {
    id: r.id,
    shiftId: r.shift_id,
    workerKind: r.worker_kind as WorkerKind,
    connecteamUserId: r.connecteam_user_id,
    instaworkWorker: r.instawork_worker,
    instaworkGigId: r.instawork_gig_id,
    displayName: r.display_name,
    role: r.role as ShiftAssignment["role"],
    state: r.state as AssignmentState,
    packetVersion: r.packet_version,
    packetSentAt: r.packet_sent_at,
    confirmedAt: r.confirmed_at,
    confirmMethod: r.confirm_method,
    clockInAt: r.clock_in_at,
    clockOutAt: r.clock_out_at,
    clockSource: r.clock_source,
    noShow: r.no_show === 1,
    tempReason: r.temp_reason,
    routeReason: r.route_reason,
    estHours: r.est_hours,
    estRate: r.est_rate,
    estCost: r.est_cost,
    overridden: r.overridden === 1,
    overrideReason: r.override_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getAssignmentById(id: string): ShiftAssignment | null {
  const r = getDb().prepare("SELECT * FROM shift_assignments WHERE id = ?").get(id) as Row | undefined;
  return r ? toAssignment(r) : null;
}

export function getAssignmentsForShift(shiftId: string): ShiftAssignment[] {
  const rows = getDb()
    .prepare("SELECT * FROM shift_assignments WHERE shift_id = ? ORDER BY worker_kind, display_name")
    .all(shiftId) as Row[];
  return rows.map(toAssignment);
}

/** All assignments for a day's shifts, keyed by shiftId (one query via a join on staff_shifts.date). */
export function getAssignmentsForDate(date: string): Map<string, ShiftAssignment[]> {
  const rows = getDb()
    .prepare(
      `SELECT a.* FROM shift_assignments a JOIN staff_shifts s ON s.id = a.shift_id
       WHERE s.date = ? ORDER BY a.worker_kind, a.display_name`,
    )
    .all(date) as Row[];
  const out = new Map<string, ShiftAssignment[]>();
  for (const r of rows) {
    const a = toAssignment(r);
    const list = out.get(a.shiftId) ?? [];
    list.push(a);
    out.set(a.shiftId, list);
  }
  return out;
}

export interface NewAssignment {
  shiftId: string;
  workerKind: WorkerKind;
  connecteamUserId?: number | null;
  instaworkWorker?: string | null;
  instaworkGigId?: string | null;
  displayName?: string | null;
  role: ShiftAssignment["role"];
  state?: AssignmentState;
  tempReason?: string | null;
  routeReason?: string | null;
  estHours?: number | null;
  estRate?: number | null;
  estCost?: number | null;
}

/**
 * Idempotent upsert of an assignment, matched by the UNIQUE (shift, kind, userId, worker) key. A repeat
 * assign is a no-op that only refreshes the mutable economics/display fields — never a duplicate row.
 * Returns the row id.
 */
export function upsertAssignment(a: NewAssignment): string {
  const now = new Date().toISOString();
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM shift_assignments
       WHERE shift_id = @shiftId AND worker_kind = @workerKind
         AND IFNULL(connecteam_user_id,-1) = IFNULL(@cuid,-1)
         AND IFNULL(instawork_worker,'') = IFNULL(@iw,'')`,
    )
    .get({ shiftId: a.shiftId, workerKind: a.workerKind, cuid: a.connecteamUserId ?? null, iw: a.instaworkWorker ?? null }) as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare(
      `UPDATE shift_assignments SET display_name = @displayName, instawork_gig_id = @gig,
         temp_reason = @tempReason, route_reason = @routeReason, est_hours = @estHours,
         est_rate = @estRate, est_cost = @estCost, updated_at = @now WHERE id = @id`,
    ).run({
      id: existing.id,
      displayName: a.displayName ?? null,
      gig: a.instaworkGigId ?? null,
      tempReason: a.tempReason ?? null,
      routeReason: a.routeReason ?? null,
      estHours: a.estHours ?? null,
      estRate: a.estRate ?? null,
      estCost: a.estCost ?? null,
      now,
    });
    return existing.id;
  }
  const id = `SA-${randomUUID()}`;
  db.prepare(
    `INSERT INTO shift_assignments
       (id, shift_id, worker_kind, connecteam_user_id, instawork_worker, instawork_gig_id, display_name,
        role, state, clock_source, no_show, temp_reason, route_reason, est_hours, est_rate, est_cost,
        overridden, created_at, updated_at)
     VALUES (@id,@shiftId,@workerKind,@cuid,@iw,@gig,@displayName,@role,@state,@clockSource,0,
        @tempReason,@routeReason,@estHours,@estRate,@estCost,0,@now,@now)`,
  ).run({
    id,
    shiftId: a.shiftId,
    workerKind: a.workerKind,
    cuid: a.connecteamUserId ?? null,
    iw: a.instaworkWorker ?? null,
    gig: a.instaworkGigId ?? null,
    displayName: a.displayName ?? null,
    role: a.role,
    state: a.state ?? "ASSIGNED",
    clockSource: a.workerKind === "instawork" ? "unavailable" : null,
    tempReason: a.tempReason ?? null,
    routeReason: a.routeReason ?? null,
    estHours: a.estHours ?? null,
    estRate: a.estRate ?? null,
    estCost: a.estCost ?? null,
    now,
  });
  return id;
}

export interface AssignmentPatch {
  state?: AssignmentState;
  packetVersion?: string | null;
  packetSentAt?: string | null;
  confirmedAt?: string | null;
  confirmMethod?: string | null;
  clockInAt?: string | null;
  clockOutAt?: string | null;
  clockSource?: string | null;
  noShow?: boolean;
  overridden?: boolean;
  overrideReason?: string | null;
}

const PATCH_COLS: Record<keyof AssignmentPatch, string> = {
  state: "state",
  packetVersion: "packet_version",
  packetSentAt: "packet_sent_at",
  confirmedAt: "confirmed_at",
  confirmMethod: "confirm_method",
  clockInAt: "clock_in_at",
  clockOutAt: "clock_out_at",
  clockSource: "clock_source",
  noShow: "no_show",
  overridden: "overridden",
  overrideReason: "override_reason",
};

export function updateAssignment(id: string, patch: AssignmentPatch): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, now: new Date().toISOString() };
  for (const [key, col] of Object.entries(PATCH_COLS) as [keyof AssignmentPatch, string][]) {
    if (!(key in patch)) continue;
    const v = patch[key];
    sets.push(`${col} = @${col}`);
    params[col] = key === "noShow" || key === "overridden" ? (v ? 1 : 0) : (v ?? null);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = @now");
  getDb().prepare(`UPDATE shift_assignments SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

// ── Append-only audit log (shift_assignment_events) — dedup by change_key (mirrors history_changes) ──

export interface ShiftEventInput {
  shiftId?: string | null;
  assignmentId?: string | null;
  actor?: string | null;
  kind: string; // assigned | packet_sent | confirmed | clock_in | ... | state_change
  field?: string | null;
  fromValue?: string | null;
  toValue?: string | null;
  changeKey: string; // idempotency: same transition logged once
}

/** Append an operational event, idempotently. Returns true if a new row was written. */
export function logShiftEvent(e: ShiftEventInput, now: Date = new Date()): boolean {
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO shift_assignment_events
         (id, ts, shift_id, assignment_id, actor, kind, field, from_value, to_value, change_key)
       VALUES (@id,@ts,@shiftId,@assignmentId,@actor,@kind,@field,@fromValue,@toValue,@changeKey)`,
    )
    .run({
      id: `SE-${randomUUID()}`,
      ts: now.toISOString(),
      shiftId: e.shiftId ?? null,
      assignmentId: e.assignmentId ?? null,
      actor: e.actor ?? "system",
      kind: e.kind,
      field: e.field ?? null,
      fromValue: e.fromValue ?? null,
      toValue: e.toValue ?? null,
      changeKey: e.changeKey,
    });
  return info.changes > 0;
}

export interface ShiftEventRow {
  id: string;
  ts: string;
  shiftId: string | null;
  assignmentId: string | null;
  actor: string | null;
  kind: string;
  field: string | null;
  fromValue: string | null;
  toValue: string | null;
}

/** The operational timeline for a shift, newest first. */
export function getShiftEvents(shiftId: string): ShiftEventRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM shift_assignment_events WHERE shift_id = ? ORDER BY ts DESC")
    .all(shiftId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    ts: String(r.ts),
    shiftId: (r.shift_id as string) ?? null,
    assignmentId: (r.assignment_id as string) ?? null,
    actor: (r.actor as string) ?? null,
    kind: String(r.kind),
    field: (r.field as string) ?? null,
    fromValue: (r.from_value as string) ?? null,
    toValue: (r.to_value as string) ?? null,
  }));
}

// ── Dual-write / derive helpers ────────────────────────────────────────────────────────────────────

/** Persist the derived lifecycle_state + cached readiness onto the demand line (derived, never SoR). */
export function writeShiftLifecycle(shiftId: string, state: ShiftLifecycleState, readinessJson: string | null): void {
  getDb()
    .prepare("UPDATE staff_shifts SET lifecycle_state = ?, readiness_json = ?, updated_at = ? WHERE id = ?")
    .run(state, readinessJson, new Date().toISOString(), shiftId);
}

/**
 * Reconcile the internal shift_assignments for a shift to EXACTLY the given set of Connecteam userIds
 * (the staff_shifts.assignees projection — the SoR the board still reads). This is the LIVE dual-write
 * path: when the dispatcher adds/removes an internal worker (AddWorkerPanel / ShiftEditor → PATCH), the
 * per-worker rows are kept in lock-step. Idempotent: live rows for still-wanted workers are left as-is,
 * a worker dropped from the set is marked REPLACED, and a previously-REPLACED worker who returns is
 * revived to ASSIGNED. Records a shift_assignment_event per change. All in one transaction.
 */
export function syncInternalAssignments(
  shift: Pick<StaffShift, "id" | "role">,
  assignees: number[],
  nameOf: (userId: number) => string | null,
  actor: string = "system",
  now: Date = new Date(),
): { created: number; removed: number } {
  const db = getDb();
  let created = 0;
  let removed = 0;
  const want = new Set(assignees);
  const tx = db.transaction(() => {
    const existing = getAssignmentsForShift(shift.id).filter((a) => a.workerKind === "internal");
    const byUid = new Map<number, ShiftAssignment>();
    for (const a of existing) if (a.connecteamUserId != null) byUid.set(a.connecteamUserId, a);

    // Drop live rows whose worker is no longer wanted.
    for (const a of existing) {
      if (a.connecteamUserId == null || want.has(a.connecteamUserId) || !isLiveAssignment(a.state)) continue;
      updateAssignment(a.id, { state: "REPLACED" });
      removed += 1;
      logShiftEvent(
        { shiftId: shift.id, assignmentId: a.id, actor, kind: "reassigned", field: "state", fromValue: a.state, toValue: "REPLACED", changeKey: `${a.id}:replaced:${now.toISOString()}` },
        now,
      );
    }

    // Add new rows, or revive a worker who was previously REPLACED/terminal.
    for (const uid of assignees) {
      const row = byUid.get(uid);
      if (row && isLiveAssignment(row.state)) continue; // already live — no-op
      if (row) {
        updateAssignment(row.id, { state: "ASSIGNED" });
        created += 1;
        logShiftEvent({ shiftId: shift.id, assignmentId: row.id, actor, kind: "assigned", field: "state", fromValue: row.state, toValue: "ASSIGNED", changeKey: `${row.id}:revived:${now.toISOString()}` }, now);
        continue;
      }
      const id = upsertAssignment({ shiftId: shift.id, workerKind: "internal", connecteamUserId: uid, displayName: nameOf(uid), role: shift.role, state: "ASSIGNED" });
      created += 1;
      logShiftEvent({ shiftId: shift.id, assignmentId: id, actor, kind: "assigned", field: "worker", toValue: String(uid), changeKey: `${shift.id}:assigned:internal:${uid}` }, now);
    }
  });
  tx();
  return { created, removed };
}

/**
 * Reconcile the INSTAWORK shift_assignments for a shift to the booked worker NAMES in a FRESH gig
 * snapshot. The caller MUST pass only workers from a verified, fresh snapshot (a stale/unreachable
 * snapshot must never call this — it would fabricate or wrongly drop a booked worker; the house rule).
 * Idempotent, same discipline as the internal sync: new names create rows, a name that left the booked
 * set is marked REPLACED (a possible drop — the exception scan / monitor surface the replacement need).
 */
export function syncInstaworkAssignments(
  shift: Pick<StaffShift, "id" | "role">,
  gig: { gigId: string | null; workers: string[] },
  actor: string = "system",
  now: Date = new Date(),
  startMs: number | null = null,
): { created: number; removed: number; noShows: number } {
  const db = getDb();
  let created = 0;
  let removed = 0;
  let noShows = 0;
  const want = new Set(gig.workers);
  // A worker who leaves the booked set AFTER the shift start is a probable NO-SHOW (same signal the
  // Instawork monitor uses); before start, it is a drop (REPLACED). Never fabricated — only on a worker
  // the fresh snapshot actually lost.
  const afterStart = startMs != null && now.getTime() >= startMs;
  const goneState: AssignmentState = afterStart ? "NO_SHOW" : "REPLACED";
  const tx = db.transaction(() => {
    const existing = getAssignmentsForShift(shift.id).filter((a) => a.workerKind === "instawork");
    const byName = new Map<string, ShiftAssignment>();
    for (const a of existing) if (a.instaworkWorker != null) byName.set(a.instaworkWorker, a);

    for (const a of existing) {
      if (a.instaworkWorker == null || want.has(a.instaworkWorker) || !isLiveAssignment(a.state)) continue;
      updateAssignment(a.id, { state: goneState, noShow: goneState === "NO_SHOW" });
      removed += 1;
      if (goneState === "NO_SHOW") noShows += 1;
      logShiftEvent({ shiftId: shift.id, assignmentId: a.id, actor, kind: "reassigned", field: "state", fromValue: a.state, toValue: goneState, changeKey: `${a.id}:iw_${goneState.toLowerCase()}:${now.toISOString()}` }, now);
    }

    for (const name of gig.workers) {
      const row = byName.get(name);
      if (row && isLiveAssignment(row.state)) {
        if (gig.gigId && row.instaworkGigId !== gig.gigId) upsertAssignment({ shiftId: shift.id, workerKind: "instawork", instaworkWorker: name, instaworkGigId: gig.gigId, displayName: name, role: shift.role });
        continue;
      }
      const id = upsertAssignment({ shiftId: shift.id, workerKind: "instawork", instaworkWorker: name, instaworkGigId: gig.gigId, displayName: name, role: shift.role, state: "ASSIGNED" });
      created += 1;
      logShiftEvent({ shiftId: shift.id, assignmentId: id, actor, kind: "assigned", field: "worker", toValue: name, changeKey: `${shift.id}:assigned:instawork:${name}` }, now);
    }
  });
  tx();
  return { created, removed, noShows };
}

/**
 * Derive per-worker assignment rows FROM a shift's existing internal assignees (idempotent). This is the
 * backfill-on-first-tick path (I.3): it creates an internal row for each assignee that has none yet, and
 * never clobbers existing rows. Instawork seats are backfilled separately from a fresh gig snapshot (so a
 * stale snapshot never fabricates a booked worker). Returns the number of rows created.
 */
export function backfillInternalAssignments(
  shift: Pick<StaffShift, "id" | "role" | "assignees">,
  nameOf: (userId: number) => string | null,
): number {
  const existing = getAssignmentsForShift(shift.id);
  const have = new Set(existing.filter((a) => a.workerKind === "internal").map((a) => a.connecteamUserId));
  let created = 0;
  for (const uid of shift.assignees) {
    if (have.has(uid)) continue;
    upsertAssignment({
      shiftId: shift.id,
      workerKind: "internal",
      connecteamUserId: uid,
      displayName: nameOf(uid),
      role: shift.role,
      state: "ASSIGNED",
    });
    created += 1;
  }
  return created;
}

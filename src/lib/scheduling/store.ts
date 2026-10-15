// Persistence for staff_shifts — the app-owned schedule. CRUD + a demand→draft upsert. Mirrors the
// risk/store.ts + shift_passes repo conventions: getDb() directly, a row interface, a toStaffShift()
// mapper, prefixed-UUID ids, ISO timestamps, JSON blobs as TEXT.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { DemandShift, ShiftStatus, StaffShift } from "./types";

interface Row {
  id: string;
  date: string;
  role: string;
  headcount: number;
  start_time: string | null;
  end_time: string | null;
  window_known: number;
  location: string | null;
  route_id: string | null;
  truck_id: string | null;
  event_label: string | null;
  reasons: string | null;
  notes: string | null;
  source: string;
  status: string;
  assignees: string | null;
  instawork_headcount: number;
  pay_rate: number | null;
  connecteam_shift_id: string | null;
  connecteam_scheduler_id: number | null;
  connecteam_published_at: string | null;
  connecteam_content_hash: string | null;
  connecteam_synced_at: string | null;
  connecteam_last_modified: string | null;
  sync_status: string | null;
  sync_note: string | null;
  instawork_gig_id: string | null;
  instawork_posted_at: string | null;
  lifecycle_state: string | null;
  supervisor_user_id: number | null;
  report_location: string | null;
  report_time: string | null;
  equipment: string | null;
  instructions: string | null;
  created_at: string;
  updated_at: string;
}

function parseArr<T>(s: string | null): T[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function toStaffShift(r: Row): StaffShift {
  return {
    id: r.id,
    date: r.date,
    role: r.role as StaffShift["role"],
    headcount: r.headcount,
    startTime: r.start_time,
    endTime: r.end_time,
    windowKnown: r.window_known === 1,
    location: r.location,
    routeId: r.route_id,
    truckId: r.truck_id,
    eventLabel: r.event_label,
    reasons: parseArr<string>(r.reasons),
    notes: r.notes,
    source: r.source as StaffShift["source"],
    status: r.status as ShiftStatus,
    assignees: parseArr<number>(r.assignees),
    instaworkHeadcount: r.instawork_headcount,
    payRate: r.pay_rate,
    connecteamShiftId: r.connecteam_shift_id,
    connecteamSchedulerId: r.connecteam_scheduler_id,
    connecteamPublishedAt: r.connecteam_published_at,
    connecteamContentHash: r.connecteam_content_hash,
    connecteamSyncedAt: r.connecteam_synced_at,
    connecteamLastModified: r.connecteam_last_modified,
    syncStatus: (r.sync_status as StaffShift["syncStatus"]) ?? null,
    syncNote: r.sync_note,
    instaworkGigId: r.instawork_gig_id,
    instaworkPostedAt: r.instawork_posted_at,
    lifecycleState: (r.lifecycle_state as StaffShift["lifecycleState"]) ?? null,
    supervisorUserId: r.supervisor_user_id,
    reportLocation: r.report_location,
    reportTime: r.report_time,
    equipment: parseArr<string>(r.equipment),
    instructions: r.instructions,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** All shifts on a given day, drivers → field → prep, earliest window first. */
export function getShiftsForDate(date: string): StaffShift[] {
  const rows = getDb()
    .prepare("SELECT * FROM staff_shifts WHERE date = ? ORDER BY start_time IS NULL, start_time, role")
    .all(date) as Row[];
  return rows.map(toStaffShift);
}

export function getShiftById(id: string): StaffShift | null {
  const r = getDb().prepare("SELECT * FROM staff_shifts WHERE id = ?").get(id) as Row | undefined;
  return r ? toStaffShift(r) : null;
}

/** The app shift linked to a Connecteam shift id (the two-way-sync join key), or null. One app shift per
 *  Connecteam id by construction (publish sets it once; the importer matches on it before creating). */
export function getShiftByConnecteamId(connecteamShiftId: string): StaffShift | null {
  const r = getDb()
    .prepare("SELECT * FROM staff_shifts WHERE connecteam_shift_id = ? LIMIT 1")
    .get(connecteamShiftId) as Row | undefined;
  return r ? toStaffShift(r) : null;
}

/** All shifts whose date is in [startDate,endDate] inclusive (YYYY-MM-DD). For the reconcile sweep. */
export function getShiftsForDateRange(startDate: string, endDate: string): StaffShift[] {
  const rows = getDb()
    .prepare("SELECT * FROM staff_shifts WHERE date >= ? AND date <= ? ORDER BY date, start_time IS NULL, start_time, role")
    .all(startDate, endDate) as Row[];
  return rows.map(toStaffShift);
}

/** Shifts flagged needs_review on a given day (two-way-sync conflicts / vanished Connecteam copies). The
 *  surface the dispatcher resolves from. Earliest window first, same ordering as getShiftsForDate. */
export function listNeedsReview(date: string): StaffShift[] {
  const rows = getDb()
    .prepare("SELECT * FROM staff_shifts WHERE date = ? AND sync_status = 'needs_review' ORDER BY start_time IS NULL, start_time, role")
    .all(date) as Row[];
  return rows.map(toStaffShift);
}

/** Shifts flagged needs_review across [startDate,endDate] inclusive — the near-window conflict list. */
export function listNeedsReviewRange(startDate: string, endDate: string): StaffShift[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM staff_shifts WHERE date >= ? AND date <= ? AND sync_status = 'needs_review' ORDER BY date, start_time IS NULL, start_time, role",
    )
    .all(startDate, endDate) as Row[];
  return rows.map(toStaffShift);
}

/** Distinct dates that already have built shifts, newest first (for the board's day rail). */
export function getShiftDates(): string[] {
  const rows = getDb().prepare("SELECT DISTINCT date FROM staff_shifts ORDER BY date DESC").all() as { date: string }[];
  return rows.map((r) => r.date);
}

export interface NewShift {
  date: string;
  role: StaffShift["role"];
  headcount: number;
  startTime?: string | null;
  endTime?: string | null;
  windowKnown?: boolean;
  location?: string | null;
  routeId?: string | null;
  truckId?: string | null;
  eventLabel?: string | null;
  reasons?: string[];
  notes?: string | null;
  source?: StaffShift["source"];
  assignees?: number[];
  instaworkHeadcount?: number;
  payRate?: number | null;
}

export function createShift(s: NewShift): StaffShift {
  const now = new Date().toISOString();
  const id = `SH-${randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO staff_shifts
       (id, date, role, headcount, start_time, end_time, window_known, location, route_id, truck_id,
        event_label, reasons, notes, source, status, assignees, instawork_headcount, pay_rate, created_at, updated_at)
       VALUES (@id, @date, @role, @headcount, @start_time, @end_time, @window_known, @location, @route_id, @truck_id,
        @event_label, @reasons, @notes, @source, 'draft', @assignees, @instawork_headcount, @pay_rate, @now, @now)`,
    )
    .run({
      id,
      date: s.date,
      role: s.role,
      headcount: s.headcount,
      start_time: s.startTime ?? null,
      end_time: s.endTime ?? null,
      window_known: s.windowKnown ? 1 : 0,
      location: s.location ?? null,
      route_id: s.routeId ?? null,
      truck_id: s.truckId ?? null,
      event_label: s.eventLabel ?? null,
      reasons: JSON.stringify(s.reasons ?? []),
      notes: s.notes ?? null,
      source: s.source ?? "manual",
      assignees: JSON.stringify(s.assignees ?? []),
      instawork_headcount: s.instaworkHeadcount ?? 0,
      pay_rate: s.payRate ?? null,
      now,
    });
  return getShiftById(id)!;
}

/** A shift INGESTED from Connecteam by the two-way-sync importer. It carries the Connecteam linkage and
 *  reconcile bookkeeping from birth (source='connecteam', status='sent' — it is already live in Connecteam
 *  and the crew are notified there), so the two directions reconcile to the SAME record instead of
 *  duplicating. Day-level role; never attached to a route (the importer does not guess route assignments). */
export interface IngestedShift {
  date: string;
  role: StaffShift["role"];
  headcount: number;
  startTime: string | null;
  endTime: string | null;
  windowKnown: boolean;
  location: string | null;
  eventLabel: string | null;
  assignees: number[];
  connecteamShiftId: string;
  connecteamSchedulerId: number | null;
  connecteamContentHash: string;
  connecteamLastModified: string | null;
  connecteamSyncedAt: string;
}

export function createIngestedShift(s: IngestedShift): StaffShift {
  const now = new Date().toISOString();
  const id = `SH-${randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO staff_shifts
       (id, date, role, headcount, start_time, end_time, window_known, location, route_id, truck_id,
        event_label, reasons, notes, source, status, assignees, instawork_headcount, pay_rate,
        connecteam_shift_id, connecteam_scheduler_id, connecteam_published_at, connecteam_content_hash,
        connecteam_synced_at, connecteam_last_modified, sync_status, created_at, updated_at)
       VALUES (@id, @date, @role, @headcount, @start_time, @end_time, @window_known, @location, NULL, NULL,
        @event_label, '[]', NULL, 'connecteam', 'sent', @assignees, 0, NULL,
        @connecteam_shift_id, @connecteam_scheduler_id, @connecteam_synced_at, @connecteam_content_hash,
        @connecteam_synced_at, @connecteam_last_modified, 'synced', @now, @now)`,
    )
    .run({
      id,
      date: s.date,
      role: s.role,
      headcount: s.headcount,
      start_time: s.startTime ?? null,
      end_time: s.endTime ?? null,
      window_known: s.windowKnown ? 1 : 0,
      location: s.location ?? null,
      event_label: s.eventLabel ?? null,
      assignees: JSON.stringify(s.assignees ?? []),
      connecteam_shift_id: s.connecteamShiftId,
      connecteam_scheduler_id: s.connecteamSchedulerId ?? null,
      connecteam_content_hash: s.connecteamContentHash,
      connecteam_synced_at: s.connecteamSyncedAt,
      connecteam_last_modified: s.connecteamLastModified ?? null,
      now,
    });
  return getShiftById(id)!;
}

/** Patchable fields on an existing shift. External-linkage fields are set by the push path. */
export interface ShiftPatch {
  role?: StaffShift["role"];
  headcount?: number;
  startTime?: string | null;
  endTime?: string | null;
  windowKnown?: boolean;
  location?: string | null;
  eventLabel?: string | null;
  notes?: string | null;
  status?: ShiftStatus;
  assignees?: number[];
  instaworkHeadcount?: number;
  payRate?: number | null;
  connecteamShiftId?: string | null;
  connecteamSchedulerId?: number | null;
  connecteamPublishedAt?: string | null;
  connecteamContentHash?: string | null;
  connecteamSyncedAt?: string | null;
  connecteamLastModified?: string | null;
  syncStatus?: StaffShift["syncStatus"];
  syncNote?: string | null;
  instaworkGigId?: string | null;
  instaworkPostedAt?: string | null;
}

const COLS: Record<keyof ShiftPatch, string> = {
  role: "role",
  headcount: "headcount",
  startTime: "start_time",
  endTime: "end_time",
  windowKnown: "window_known",
  location: "location",
  eventLabel: "event_label",
  notes: "notes",
  status: "status",
  assignees: "assignees",
  instaworkHeadcount: "instawork_headcount",
  payRate: "pay_rate",
  connecteamShiftId: "connecteam_shift_id",
  connecteamSchedulerId: "connecteam_scheduler_id",
  connecteamPublishedAt: "connecteam_published_at",
  connecteamContentHash: "connecteam_content_hash",
  connecteamSyncedAt: "connecteam_synced_at",
  connecteamLastModified: "connecteam_last_modified",
  syncStatus: "sync_status",
  syncNote: "sync_note",
  instaworkGigId: "instawork_gig_id",
  instaworkPostedAt: "instawork_posted_at",
};

export function updateShift(id: string, patch: ShiftPatch): StaffShift | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, now: new Date().toISOString() };
  for (const [key, col] of Object.entries(COLS) as [keyof ShiftPatch, string][]) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (key === "windowKnown") {
      sets.push(`${col} = @${col}`);
      params[col] = v ? 1 : 0;
    } else if (key === "assignees") {
      sets.push(`${col} = @${col}`);
      params[col] = JSON.stringify(v ?? []);
    } else {
      sets.push(`${col} = @${col}`);
      params[col] = v ?? null;
    }
  }
  if (sets.length === 0) return getShiftById(id);
  sets.push("updated_at = @now");
  getDb().prepare(`UPDATE staff_shifts SET ${sets.join(", ")} WHERE id = @id`).run(params);
  return getShiftById(id);
}

export function deleteShift(id: string): void {
  getDb().prepare("DELETE FROM staff_shifts WHERE id = ?").run(id);
}

/**
 * Materialize a demand draft into shifts, idempotently. A derived shift is keyed by
 * (its own date, role, routeId) so re-running demand generation refreshes counts/windows for
 * routes still auto-derived WITHOUT clobbering anything a human has touched — we skip refresh once
 * a shift leaves 'draft' or carries assignees/an Instawork gig.
 *
 * Demand can span days: buildDemand emits driver/field shifts on the event day but the PREP shift
 * the day BEFORE (and with no routeId). So each demand item is deduped against the existing rows
 * for ITS OWN date — deduping everything against `date` would leave the prep row unmatched and spawn
 * a duplicate on the prior day every run. `date` only selects which day's shifts to return.
 */
export function syncDemand(date: string, demand: DemandShift[]): StaffShift[] {
  const db = getDb();
  const dates = [...new Set(demand.map((d) => d.date))];
  const existingByDate = new Map<string, StaffShift[]>(dates.map((dt) => [dt, getShiftsForDate(dt)]));
  const tx = db.transaction(() => {
    for (const d of demand) {
      const existing = existingByDate.get(d.date) ?? [];
      const match = existing.find(
        (e) => e.source === "derived" && e.role === d.role && (e.routeId ?? null) === (d.routeId ?? null),
      );
      if (!match) {
        createShift({ ...d, source: "derived" });
        continue;
      }
      // Leave anything a human is working on alone.
      const humanTouched = match.status !== "draft" || match.assignees.length > 0 || match.instaworkHeadcount > 0;
      if (humanTouched) continue;
      updateShift(match.id, {
        headcount: d.headcount,
        startTime: d.startTime,
        endTime: d.endTime,
        windowKnown: d.windowKnown,
        location: d.location,
        eventLabel: d.eventLabel,
      });
    }
  });
  tx();
  return getShiftsForDate(date);
}

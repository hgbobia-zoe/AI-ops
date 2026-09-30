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
  instawork_gig_id: string | null;
  instawork_posted_at: string | null;
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
    instaworkGigId: r.instawork_gig_id,
    instaworkPostedAt: r.instawork_posted_at,
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
 * Materialize a demand draft into the day's shifts, idempotently. A derived shift is keyed by
 * (date, role, routeId) so re-running demand generation refreshes counts/windows for routes that
 * are still auto-derived WITHOUT clobbering anything a human has touched — we skip refresh once a
 * shift leaves 'draft' or carries assignees/an Instawork gig. Returns the day's shifts after upsert.
 */
export function syncDemand(date: string, demand: DemandShift[]): StaffShift[] {
  const db = getDb();
  const existing = getShiftsForDate(date);
  const tx = db.transaction(() => {
    for (const d of demand) {
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

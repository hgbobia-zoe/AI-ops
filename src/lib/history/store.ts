// Operational History (MVP4) — snapshot + append-only change-log store. Observes the other
// systems; never a source of truth. Snapshots dedup by signature (only when a meaningful field
// changed); changes dedup by a deterministic change_key (idempotent under repeated scans/imports).

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export interface SnapshotInput {
  eventId: string;
  eventDate: string;
  label: string;
  routeId?: string;
  daysOut: number;
  driverName?: string;
  riskLevel: string;
  readinessScore: number | null;
  openRisks: number;
  revenue?: number | null;
}

function snapshotSig(s: SnapshotInput): string {
  return JSON.stringify([s.driverName ?? "", s.riskLevel, s.readinessScore, s.openRisks, s.revenue ?? null]);
}

/** Write a snapshot only if the event's latest snapshot differs (meaningful change). Returns true if written. */
export function captureEventSnapshot(s: SnapshotInput, now: Date = new Date()): boolean {
  const db = getDb();
  const sig = snapshotSig(s);
  const last = db
    .prepare("SELECT sig FROM event_snapshots WHERE event_id = ? ORDER BY captured_at DESC LIMIT 1")
    .get(s.eventId) as { sig: string } | undefined;
  if (last && last.sig === sig) return false; // no meaningful change → no new snapshot
  db.prepare(
    `INSERT INTO event_snapshots (id, event_id, event_date, label, route_id, days_out, driver_name,
       risk_level, readiness_score, open_risks, revenue, sig, captured_at)
     VALUES (@id,@eventId,@eventDate,@label,@routeId,@daysOut,@driverName,@riskLevel,@readinessScore,
       @openRisks,@revenue,@sig,@now)`,
  ).run({
    id: `SN-${randomUUID()}`,
    eventId: s.eventId,
    eventDate: s.eventDate,
    label: s.label,
    routeId: s.routeId ?? null,
    daysOut: s.daysOut,
    driverName: s.driverName ?? null,
    riskLevel: s.riskLevel,
    readinessScore: s.readinessScore,
    openRisks: s.openRisks,
    revenue: s.revenue ?? null,
    sig,
    now: now.toISOString(),
  });
  return true;
}

export interface ChangeInput {
  source: string; // dispatch | risk | goodshuffle | finance | connecteam
  eventId?: string;
  entity: string; // route | stop | risk | event | financial
  entityId?: string;
  kind: string;
  field?: string;
  fromValue?: string | null;
  toValue?: string | null;
  /** Deterministic key → the same transition is logged once (idempotent). */
  changeKey: string;
}

/** Append one change to the log. Returns true if newly logged (false = already recorded). */
export function logChange(c: ChangeInput, now: Date = new Date()): boolean {
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO history_changes (id, ts, source, event_id, entity, entity_id, kind, field, from_value, to_value, change_key)
       VALUES (@id,@ts,@source,@eventId,@entity,@entityId,@kind,@field,@fromValue,@toValue,@changeKey)`,
    )
    .run({
      id: `CH-${randomUUID()}`,
      ts: now.toISOString(),
      source: c.source,
      eventId: c.eventId ?? null,
      entity: c.entity,
      entityId: c.entityId ?? null,
      kind: c.kind,
      field: c.field ?? null,
      fromValue: c.fromValue ?? null,
      toValue: c.toValue ?? null,
      changeKey: c.changeKey,
    });
  return info.changes > 0;
}

export interface ChangeRow {
  id: string;
  ts: string;
  source: string;
  eventId: string | null;
  entity: string;
  entityId: string | null;
  kind: string;
  field: string | null;
  fromValue: string | null;
  toValue: string | null;
}

function toChange(r: Record<string, unknown>): ChangeRow {
  return {
    id: String(r.id),
    ts: String(r.ts),
    source: String(r.source ?? ""),
    eventId: (r.event_id as string) ?? null,
    entity: String(r.entity ?? ""),
    entityId: (r.entity_id as string) ?? null,
    kind: String(r.kind ?? ""),
    field: (r.field as string) ?? null,
    fromValue: (r.from_value as string) ?? null,
    toValue: (r.to_value as string) ?? null,
  };
}

export function getRecentChanges(limit = 100): ChangeRow[] {
  return (getDb().prepare("SELECT * FROM history_changes ORDER BY ts DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(toChange);
}

export interface SnapshotRow {
  id: string;
  eventId: string;
  eventDate: string;
  label: string;
  daysOut: number;
  driverName: string | null;
  riskLevel: string;
  readinessScore: number | null;
  openRisks: number;
  revenue: number | null;
  capturedAt: string;
}

export function getEventTimeline(eventId: string): { snapshots: SnapshotRow[]; changes: ChangeRow[] } {
  const snaps = (getDb().prepare("SELECT * FROM event_snapshots WHERE event_id = ? ORDER BY captured_at").all(eventId) as Record<string, unknown>[]).map(
    (r) => ({
      id: String(r.id),
      eventId: String(r.event_id),
      eventDate: String(r.event_date ?? ""),
      label: String(r.label ?? ""),
      daysOut: Number(r.days_out ?? 0),
      driverName: (r.driver_name as string) ?? null,
      riskLevel: String(r.risk_level ?? ""),
      readinessScore: r.readiness_score == null ? null : Number(r.readiness_score),
      openRisks: Number(r.open_risks ?? 0),
      revenue: r.revenue == null ? null : Number(r.revenue),
      capturedAt: String(r.captured_at),
    }),
  );
  const changes = (getDb().prepare("SELECT * FROM history_changes WHERE event_id = ? ORDER BY ts DESC").all(eventId) as Record<string, unknown>[]).map(toChange);
  return { snapshots: snaps, changes };
}

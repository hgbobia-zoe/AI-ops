// Persistence for HR / Payroll — hr_workers, hr_time_entries, hr_sync_runs, hr_exceptions. Mirrors the
// scheduling/store.ts + repo.ts conventions: getDb() directly, a Row interface, a toX() mapper, prefixed
// UUID ids, ISO timestamps, idempotent upserts keyed on UNIQUE columns. No IO beyond SQLite.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type {
  WorkerRecord, WorkerType, EmploymentStatus, PayType, GustoEntityType,
  PayrollException, ExceptionSeverity, ExceptionStatus,
  SyncRun, SyncTrigger, SyncStatus, HoursType, TimeEntryStatus,
} from "./types";

// ── hr_workers ─────────────────────────────────────────────────────────────────────────────────────
interface WorkerRow {
  id: string; name: string; email: string | null; worker_type: string; employment_status: string;
  connecteam_user_id: number | null; instawork_worker: string | null; gusto_id: string | null;
  gusto_entity_type: string | null; pay_type: string | null; pay_rate: number | null;
  currency: string | null; country: string | null; active: number; notes: string | null;
  created_at: string; updated_at: string;
}
function toWorker(r: WorkerRow): WorkerRecord {
  return {
    id: r.id, name: r.name, email: r.email,
    workerType: r.worker_type as WorkerType, employmentStatus: r.employment_status as EmploymentStatus,
    connecteamUserId: r.connecteam_user_id, instaworkWorker: r.instawork_worker,
    gustoId: r.gusto_id, gustoEntityType: (r.gusto_entity_type as GustoEntityType | null) ?? null,
    payType: (r.pay_type as PayType | null) ?? null, payRate: r.pay_rate,
    currency: r.currency, country: r.country, active: r.active === 1, notes: r.notes,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function listWorkerRecords(): WorkerRecord[] {
  const rows = getDb().prepare("SELECT * FROM hr_workers ORDER BY name").all() as WorkerRow[];
  return rows.map(toWorker);
}
export function getWorkerById(id: string): WorkerRecord | null {
  const r = getDb().prepare("SELECT * FROM hr_workers WHERE id = ?").get(id) as WorkerRow | undefined;
  return r ? toWorker(r) : null;
}
export function getWorkerByConnecteamId(userId: number): WorkerRecord | null {
  const r = getDb().prepare("SELECT * FROM hr_workers WHERE connecteam_user_id = ?").get(userId) as WorkerRow | undefined;
  return r ? toWorker(r) : null;
}

export interface ConnecteamSeed {
  connecteamUserId: number;
  name: string;
  email?: string | null;
  workerTypeDefault?: WorkerType; // inferred default; only applied on first insert
}
/** Ensure a stored row exists for a Connecteam worker. Idempotent: creates with inferred defaults if
 *  missing; if present, refreshes only the cached name/email — NEVER clobbers a human classification or
 *  pay override. Returns the row. */
export function ensureWorkerFromConnecteam(seed: ConnecteamSeed): WorkerRecord {
  const existing = getWorkerByConnecteamId(seed.connecteamUserId);
  const now = new Date().toISOString();
  if (existing) {
    getDb().prepare("UPDATE hr_workers SET name = @name, email = COALESCE(@email, email), updated_at = @now WHERE id = @id")
      .run({ id: existing.id, name: seed.name, email: seed.email ?? null, now });
    return getWorkerById(existing.id)!;
  }
  const id = `HW-${randomUUID()}`;
  getDb().prepare(
    `INSERT INTO hr_workers (id, name, email, worker_type, employment_status, connecteam_user_id, active, created_at, updated_at)
     VALUES (@id, @name, @email, @worker_type, 'ACTIVE', @cuid, 1, @now, @now)`,
  ).run({ id, name: seed.name, email: seed.email ?? null, worker_type: seed.workerTypeDefault ?? "EMPLOYEE", cuid: seed.connecteamUserId, now });
  return getWorkerById(id)!;
}

export interface WorkerPatch {
  name?: string; email?: string | null; workerType?: WorkerType; employmentStatus?: EmploymentStatus;
  gustoId?: string | null; gustoEntityType?: GustoEntityType | null; payType?: PayType | null;
  payRate?: number | null; currency?: string | null; country?: string | null; active?: boolean; notes?: string | null;
}
export function updateWorker(id: string, patch: WorkerPatch): WorkerRecord | null {
  const cur = getWorkerById(id);
  if (!cur) return null;
  const next = {
    name: patch.name ?? cur.name,
    email: patch.email === undefined ? cur.email : patch.email,
    worker_type: patch.workerType ?? cur.workerType,
    employment_status: patch.employmentStatus ?? cur.employmentStatus,
    gusto_id: patch.gustoId === undefined ? cur.gustoId : patch.gustoId,
    gusto_entity_type: patch.gustoEntityType === undefined ? cur.gustoEntityType : patch.gustoEntityType,
    pay_type: patch.payType === undefined ? cur.payType : patch.payType,
    pay_rate: patch.payRate === undefined ? cur.payRate : patch.payRate,
    currency: patch.currency === undefined ? cur.currency : patch.currency,
    country: patch.country === undefined ? cur.country : patch.country,
    active: (patch.active ?? cur.active) ? 1 : 0,
    notes: patch.notes === undefined ? cur.notes : patch.notes,
    now: new Date().toISOString(),
    id,
  };
  getDb().prepare(
    `UPDATE hr_workers SET name=@name, email=@email, worker_type=@worker_type, employment_status=@employment_status,
      gusto_id=@gusto_id, gusto_entity_type=@gusto_entity_type, pay_type=@pay_type, pay_rate=@pay_rate,
      currency=@currency, country=@country, active=@active, notes=@notes, updated_at=@now WHERE id=@id`,
  ).run(next);
  return getWorkerById(id);
}

// ── hr_sync_runs ───────────────────────────────────────────────────────────────────────────────────
interface SyncRow {
  id: string; period_start: string; period_end: string; trigger: string; initiated_by: string | null;
  status: string; workers_processed: number | null; total_hours: number | null; hours_ready: number | null;
  exceptions_count: number | null; review_count: number | null; gusto_created: number | null;
  gusto_updated: number | null; skipped: number | null; connecteam_ok: number | null; gusto_ok: number | null;
  detail: string | null; started_at: string; finished_at: string | null;
}
function toSyncRun(r: SyncRow): SyncRun {
  return {
    id: r.id, periodStart: r.period_start, periodEnd: r.period_end, trigger: r.trigger as SyncTrigger,
    initiatedBy: r.initiated_by, status: r.status as SyncStatus, workersProcessed: r.workers_processed,
    totalHours: r.total_hours, hoursReady: r.hours_ready, exceptionsCount: r.exceptions_count,
    reviewCount: r.review_count, gustoCreated: r.gusto_created, gustoUpdated: r.gusto_updated, skipped: r.skipped,
    connecteamOk: r.connecteam_ok == null ? null : r.connecteam_ok === 1,
    gustoOk: r.gusto_ok == null ? null : r.gusto_ok === 1,
    detail: r.detail, startedAt: r.started_at, finishedAt: r.finished_at,
  };
}
export function startSyncRun(p: { periodStart: string; periodEnd: string; trigger: SyncTrigger; initiatedBy: string | null }): string {
  const id = `HS-${randomUUID()}`;
  getDb().prepare(
    `INSERT INTO hr_sync_runs (id, period_start, period_end, trigger, initiated_by, status, started_at)
     VALUES (@id, @ps, @pe, @trigger, @by, 'RUNNING', @now)`,
  ).run({ id, ps: p.periodStart, pe: p.periodEnd, trigger: p.trigger, by: p.initiatedBy, now: new Date().toISOString() });
  return id;
}
export interface SyncFinish {
  status: SyncStatus; workersProcessed?: number; totalHours?: number | null; hoursReady?: number | null;
  exceptionsCount?: number; reviewCount?: number; gustoCreated?: number; gustoUpdated?: number; skipped?: number;
  connecteamOk?: boolean; gustoOk?: boolean | null; detail?: string | null;
}
export function finishSyncRun(id: string, f: SyncFinish): void {
  getDb().prepare(
    `UPDATE hr_sync_runs SET status=@status, workers_processed=@wp, total_hours=@th, hours_ready=@hr,
      exceptions_count=@ex, review_count=@rc, gusto_created=@gc, gusto_updated=@gu, skipped=@sk,
      connecteam_ok=@cok, gusto_ok=@gok, detail=@detail, finished_at=@now WHERE id=@id`,
  ).run({
    id, status: f.status, wp: f.workersProcessed ?? null, th: f.totalHours ?? null, hr: f.hoursReady ?? null,
    ex: f.exceptionsCount ?? null, rc: f.reviewCount ?? null, gc: f.gustoCreated ?? null, gu: f.gustoUpdated ?? null,
    sk: f.skipped ?? null, cok: f.connecteamOk == null ? null : f.connecteamOk ? 1 : 0,
    gok: f.gustoOk == null ? null : f.gustoOk ? 1 : 0, detail: f.detail ?? null, now: new Date().toISOString(),
  });
}
export function listSyncRuns(limit = 30): SyncRun[] {
  const rows = getDb().prepare("SELECT * FROM hr_sync_runs ORDER BY started_at DESC LIMIT ?").all(limit) as SyncRow[];
  return rows.map(toSyncRun);
}
export function latestSyncRun(): SyncRun | null {
  const r = getDb().prepare("SELECT * FROM hr_sync_runs ORDER BY started_at DESC LIMIT 1").get() as SyncRow | undefined;
  return r ? toSyncRun(r) : null;
}

// ── hr_exceptions ──────────────────────────────────────────────────────────────────────────────────
interface ExcRow {
  id: string; sync_run_id: string | null; worker_id: string | null; worker_label: string | null;
  severity: string; type: string; description: string; source: string | null; status: string;
  resolution: string | null; resolved_by: string | null; resolved_at: string | null; detected_at: string;
}
function toException(r: ExcRow): PayrollException {
  return {
    id: r.id, syncRunId: r.sync_run_id, workerId: r.worker_id, workerLabel: r.worker_label,
    severity: r.severity as ExceptionSeverity, type: r.type, description: r.description, source: r.source,
    status: r.status as ExceptionStatus, resolution: r.resolution, resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at, detectedAt: r.detected_at,
  };
}
export interface NewException {
  syncRunId?: string | null; workerId?: string | null; workerLabel?: string | null;
  severity: ExceptionSeverity; type: string; description: string; source?: string | null; detectKey: string;
}
/** Idempotent on detect_key: re-detecting the same issue refreshes its description/severity (unless the
 *  human already RESOLVED/IGNORED it — those are left alone). Returns true if a NEW exception was opened. */
export function upsertException(e: NewException): boolean {
  const db = getDb();
  const existing = db.prepare("SELECT id, status FROM hr_exceptions WHERE detect_key = ?").get(e.detectKey) as { id: string; status: string } | undefined;
  const now = new Date().toISOString();
  if (existing) {
    if (existing.status === "OPEN" || existing.status === "IN_REVIEW") {
      db.prepare("UPDATE hr_exceptions SET severity=@sev, description=@desc, sync_run_id=@run, detected_at=@now WHERE id=@id")
        .run({ id: existing.id, sev: e.severity, desc: e.description, run: e.syncRunId ?? null, now });
    }
    return false;
  }
  db.prepare(
    `INSERT INTO hr_exceptions (id, sync_run_id, worker_id, worker_label, severity, type, description, source, status, detect_key, detected_at)
     VALUES (@id, @run, @wid, @wlabel, @sev, @type, @desc, @source, 'OPEN', @key, @now)`,
  ).run({
    id: `HE-${randomUUID()}`, run: e.syncRunId ?? null, wid: e.workerId ?? null, wlabel: e.workerLabel ?? null,
    sev: e.severity, type: e.type, desc: e.description, source: e.source ?? null, key: e.detectKey, now,
  });
  return true;
}
export function listExceptions(status?: ExceptionStatus): PayrollException[] {
  const sql = status
    ? "SELECT * FROM hr_exceptions WHERE status = ? ORDER BY detected_at DESC"
    : "SELECT * FROM hr_exceptions ORDER BY (status IN ('RESOLVED','IGNORED')), detected_at DESC";
  const rows = (status ? getDb().prepare(sql).all(status) : getDb().prepare(sql).all()) as ExcRow[];
  return rows.map(toException);
}
export function countOpenExceptions(): number {
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM hr_exceptions WHERE status IN ('OPEN','IN_REVIEW')").get() as { n: number };
  return r.n;
}
export function resolveException(id: string, p: { status: ExceptionStatus; resolution?: string | null; resolvedBy: string }): void {
  getDb().prepare("UPDATE hr_exceptions SET status=@status, resolution=@res, resolved_by=@by, resolved_at=@now WHERE id=@id")
    .run({ id, status: p.status, res: p.resolution ?? null, by: p.resolvedBy, now: new Date().toISOString() });
}

// ── hr_time_entries ────────────────────────────────────────────────────────────────────────────────
export interface TimeEntryUpsert {
  syncRunId: string; workerId: string | null; periodStart: string; periodEnd: string; date?: string | null;
  hours: number; hoursType: HoursType; sourceSystem: string; sourceRecordId: string; checksum: string; status: TimeEntryStatus;
}
/** Idempotent upsert on (source_system, source_record_id, period). Re-running a sync UPDATES the row in
 *  place (never duplicates hours). Returns "created" | "updated" | "unchanged". */
export function upsertTimeEntry(e: TimeEntryUpsert): "created" | "updated" | "unchanged" {
  const db = getDb();
  const existing = db.prepare(
    "SELECT id, checksum FROM hr_time_entries WHERE source_system=? AND source_record_id=? AND period_start=? AND period_end=?",
  ).get(e.sourceSystem, e.sourceRecordId, e.periodStart, e.periodEnd) as { id: string; checksum: string } | undefined;
  const now = new Date().toISOString();
  if (existing) {
    if (existing.checksum === e.checksum) return "unchanged";
    db.prepare(
      `UPDATE hr_time_entries SET sync_run_id=@run, worker_id=@wid, date=@date, hours=@hours, hours_type=@htype,
        checksum=@checksum, status=@status, updated_at=@now WHERE id=@id`,
    ).run({ id: existing.id, run: e.syncRunId, wid: e.workerId, date: e.date ?? null, hours: e.hours, htype: e.hoursType, checksum: e.checksum, status: e.status, now });
    return "updated";
  }
  db.prepare(
    `INSERT INTO hr_time_entries (id, sync_run_id, worker_id, period_start, period_end, date, hours, hours_type,
      source_system, source_record_id, checksum, status, created_at, updated_at)
     VALUES (@id, @run, @wid, @ps, @pe, @date, @hours, @htype, @sys, @srid, @checksum, @status, @now, @now)`,
  ).run({
    id: `HT-${randomUUID()}`, run: e.syncRunId, wid: e.workerId, ps: e.periodStart, pe: e.periodEnd, date: e.date ?? null,
    hours: e.hours, htype: e.hoursType, sys: e.sourceSystem, srid: e.sourceRecordId, checksum: e.checksum, status: e.status, now,
  });
  return "created";
}
export function countTimeEntries(periodStart: string, periodEnd: string): number {
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM hr_time_entries WHERE period_start=? AND period_end=?").get(periodStart, periodEnd) as { n: number };
  return r.n;
}

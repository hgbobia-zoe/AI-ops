// People Lifecycle store — all DB access for the employee spine, access policies, and lifecycle tasks.
// Server-only (better-sqlite3). Pure business rules live in machine.ts / policy.ts / lifecycle.ts; this
// file is persistence only. Seed policies are written once (seeded=1) and never silently overwritten.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { Role } from "@/lib/auth/roles";
import { SEED_POLICIES } from "./policy";
import type { AccessPolicy, Employee, LifecycleState, LifecycleTask, PolicyRule, TaskKind, TaskStatus } from "./types";

// ── Employee ────────────────────────────────────────────────────────────────────────────────────────
interface EmpRow {
  id: string;
  display_name: string;
  work_email: string | null;
  lifecycle_state: string;
  role: string;
  department: string | null;
  start_date: string | null;
  end_date: string | null;
  user_id: string | null;
  hr_worker_id: string | null;
  connecteam_user_id: number | null;
  instawork_worker: string | null;
  openphone_user_id: string | null;
  gusto_id: string | null;
  ai_org_human_name: string | null;
  created_at: string;
  updated_at: string;
}

function toEmployee(r: EmpRow): Employee {
  return {
    id: r.id,
    displayName: r.display_name,
    workEmail: r.work_email,
    lifecycleState: r.lifecycle_state as LifecycleState,
    role: r.role as Role,
    department: r.department,
    startDate: r.start_date,
    endDate: r.end_date,
    userId: r.user_id,
    hrWorkerId: r.hr_worker_id,
    connecteamUserId: r.connecteam_user_id,
    instaworkWorker: r.instawork_worker,
    openphoneUserId: r.openphone_user_id,
    gustoId: r.gusto_id,
    aiOrgHumanName: r.ai_org_human_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface NewEmployee {
  displayName: string;
  workEmail?: string | null;
  role: Role;
  department?: string | null;
  startDate?: string | null;
  userId?: string | null;
  hrWorkerId?: string | null;
  connecteamUserId?: number | null;
  openphoneUserId?: string | null;
  gustoId?: string | null;
  aiOrgHumanName?: string | null;
}

export function createEmployee(input: NewEmployee): Employee {
  const id = `E-${randomUUID()}`;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO employee (id, display_name, work_email, lifecycle_state, role, department, start_date,
        user_id, hr_worker_id, connecteam_user_id, instawork_worker, openphone_user_id, gusto_id,
        ai_org_human_name, created_at, updated_at)
       VALUES (@id,@name,@email,'HIRE',@role,@dept,@start,@userId,@hrId,@ctId,NULL,@opId,@gustoId,@aiName,@now,@now)`,
    )
    .run({
      id,
      name: input.displayName.trim(),
      email: input.workEmail?.trim() || null,
      role: input.role,
      dept: input.department ?? null,
      start: input.startDate ?? null,
      userId: input.userId ?? null,
      hrId: input.hrWorkerId ?? null,
      ctId: input.connecteamUserId ?? null,
      opId: input.openphoneUserId ?? null,
      gustoId: input.gustoId ?? null,
      aiName: input.aiOrgHumanName ?? null,
      now,
    });
  return getEmployee(id)!;
}

export function getEmployee(id: string): Employee | null {
  const r = getDb().prepare("SELECT * FROM employee WHERE id = ?").get(id) as EmpRow | undefined;
  return r ? toEmployee(r) : null;
}

export function listEmployees(): Employee[] {
  return (getDb().prepare("SELECT * FROM employee ORDER BY created_at DESC").all() as EmpRow[]).map(toEmployee);
}

/** Set the lifecycle state (callers must have already checked the machine's guard). */
export function setEmployeeState(id: string, state: LifecycleState): void {
  getDb().prepare("UPDATE employee SET lifecycle_state = ?, updated_at = ? WHERE id = ?").run(state, new Date().toISOString(), id);
}

export function setEmployeeEndDate(id: string, endDate: string | null): void {
  getDb().prepare("UPDATE employee SET end_date = ?, updated_at = ? WHERE id = ?").run(endDate, new Date().toISOString(), id);
}

/** Link an employee to an external identity (nullable FK set). Only one column per call. */
export function linkEmployee(id: string, field: "user_id" | "hr_worker_id" | "openphone_user_id" | "gusto_id", value: string | null): void {
  getDb().prepare(`UPDATE employee SET ${field} = ?, updated_at = ? WHERE id = ?`).run(value, new Date().toISOString(), id);
}

// ── Access policies ─────────────────────────────────────────────────────────────────────────────────
interface PolicyRow { id: string; name: string; seeded: number }
interface RuleRow { policy_id: string; adapter_id: string; system: string; required: number; mode: string }

/** Write the code seed into the DB once. Idempotent: an existing policy id is left untouched (so admin
 *  edits survive). Safe to call on every read. */
export function ensureSeedPolicies(): void {
  const db = getDb();
  const now = new Date().toISOString();
  const insertPolicy = db.prepare("INSERT OR IGNORE INTO access_policy (id, name, seeded, created_at, updated_at) VALUES (?,?,?,?,?)");
  const insertRule = db.prepare(
    "INSERT OR IGNORE INTO access_policy_rule (id, policy_id, adapter_id, system, required, mode) VALUES (?,?,?,?,?,?)",
  );
  const tx = db.transaction(() => {
    for (const p of SEED_POLICIES) {
      insertPolicy.run(p.id, p.name, 1, now, now);
      for (const r of p.rules) insertRule.run(`${p.id}:${r.adapterId}`, p.id, r.adapterId, r.system, r.required ? 1 : 0, r.mode);
    }
  });
  tx();
}

function rulesFor(policyId: string): PolicyRule[] {
  const rows = getDb().prepare("SELECT * FROM access_policy_rule WHERE policy_id = ? ORDER BY required DESC, adapter_id").all(policyId) as RuleRow[];
  return rows.map((r) => ({ adapterId: r.adapter_id, system: r.system, required: r.required === 1, mode: r.mode as PolicyRule["mode"] }));
}

export function getPolicy(id: string): AccessPolicy | null {
  ensureSeedPolicies();
  const p = getDb().prepare("SELECT * FROM access_policy WHERE id = ?").get(id) as PolicyRow | undefined;
  if (!p) return null;
  return { id: p.id, name: p.name, seeded: p.seeded === 1, rules: rulesFor(p.id) };
}

export function listPolicies(): AccessPolicy[] {
  ensureSeedPolicies();
  const rows = getDb().prepare("SELECT * FROM access_policy ORDER BY name").all() as PolicyRow[];
  return rows.map((p) => ({ id: p.id, name: p.name, seeded: p.seeded === 1, rules: rulesFor(p.id) }));
}

// ── Lifecycle tasks ─────────────────────────────────────────────────────────────────────────────────
interface TaskRow {
  id: string;
  employee_id: string;
  adapter_id: string;
  system: string;
  kind: string;
  title: string;
  status: string;
  mode: string;
  required: number;
  source: string;
  change_key: string;
  external_ref: string | null;
  error: string | null;
  retryable: number;
  approval_id: string | null;
  actor: string | null;
  created_at: string;
  completed_at: string | null;
}

function toTask(r: TaskRow): LifecycleTask {
  return {
    id: r.id,
    employeeId: r.employee_id,
    adapterId: r.adapter_id,
    system: r.system,
    kind: r.kind as TaskKind,
    title: r.title,
    status: r.status as TaskStatus,
    mode: r.mode as LifecycleTask["mode"],
    required: r.required === 1,
    source: r.source as LifecycleTask["source"],
    changeKey: r.change_key,
    externalRef: r.external_ref,
    error: r.error,
    retryable: r.retryable === 1,
    approvalId: r.approval_id,
    actor: r.actor,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

export interface NewTask {
  employeeId: string;
  adapterId: string;
  system: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  mode: LifecycleTask["mode"];
  required: boolean;
  source: LifecycleTask["source"];
  changeKey: string;
}

/** Insert a task idempotently on change_key. Returns the existing row if one already exists (so
 *  re-materialization never duplicates). */
export function insertTaskIfAbsent(input: NewTask): LifecycleTask {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM lifecycle_task WHERE change_key = ?").get(input.changeKey) as TaskRow | undefined;
  if (existing) return toTask(existing);
  const id = `LT-${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO lifecycle_task (id, employee_id, adapter_id, system, kind, title, status, mode, required,
       source, change_key, retryable, created_at)
     VALUES (@id,@emp,@adapter,@system,@kind,@title,@status,@mode,@required,@source,@key,1,@now)`,
  ).run({
    id,
    emp: input.employeeId,
    adapter: input.adapterId,
    system: input.system,
    kind: input.kind,
    title: input.title,
    status: input.status,
    mode: input.mode,
    required: input.required ? 1 : 0,
    source: input.source,
    key: input.changeKey,
    now,
  });
  return toTask(db.prepare("SELECT * FROM lifecycle_task WHERE id = ?").get(id) as TaskRow);
}

export function getTask(id: string): LifecycleTask | null {
  const r = getDb().prepare("SELECT * FROM lifecycle_task WHERE id = ?").get(id) as TaskRow | undefined;
  return r ? toTask(r) : null;
}

export function listTasks(employeeId: string, kind?: TaskKind): LifecycleTask[] {
  const rows = kind
    ? (getDb().prepare("SELECT * FROM lifecycle_task WHERE employee_id = ? AND kind = ? ORDER BY required DESC, created_at").all(employeeId, kind) as TaskRow[])
    : (getDb().prepare("SELECT * FROM lifecycle_task WHERE employee_id = ? ORDER BY kind, required DESC, created_at").all(employeeId) as TaskRow[]);
  return rows.map(toTask);
}

export interface TaskUpdate {
  status?: TaskStatus;
  externalRef?: string | null;
  error?: string | null;
  approvalId?: string | null;
  actor?: string | null;
  completedAt?: string | null;
}

export function updateTask(id: string, patch: TaskUpdate): LifecycleTask | null {
  const cur = getTask(id);
  if (!cur) return null;
  const next = {
    status: patch.status ?? cur.status,
    externalRef: patch.externalRef !== undefined ? patch.externalRef : cur.externalRef,
    error: patch.error !== undefined ? patch.error : cur.error,
    approvalId: patch.approvalId !== undefined ? patch.approvalId : cur.approvalId,
    actor: patch.actor !== undefined ? patch.actor : cur.actor,
    completedAt: patch.completedAt !== undefined ? patch.completedAt : cur.completedAt,
  };
  getDb()
    .prepare(
      "UPDATE lifecycle_task SET status=@status, external_ref=@externalRef, error=@error, approval_id=@approvalId, actor=@actor, completed_at=@completedAt WHERE id=@id",
    )
    .run({ id, ...next });
  return getTask(id);
}

/** Tasks across all employees in a given status + kind — for the runtime tick's escalation/auto-run sweeps. */
export function tasksByStatus(kind: TaskKind, statuses: TaskStatus[]): LifecycleTask[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM lifecycle_task WHERE kind = ? AND status IN (${placeholders}) ORDER BY created_at`)
    .all(kind, ...statuses) as TaskRow[];
  return rows.map(toTask);
}

// ── Audit timeline for one employee ───────────────────────────────────────────────────────────────────
export interface EmployeeAuditEntry {
  actor: string;
  action: string;
  entityId: string;
  detail: Record<string, unknown> | null;
  ts: string;
}

/** Every audit row for this employee — lifecycle transitions (entity_id = <empId>) AND per-system access
 *  grants/revokes (entity_id = <empId>:<adapter>). Reuses the shared audit_logs table (insertAudit). */
export function listEmployeeAudit(employeeId: string, limit = 100): EmployeeAuditEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT actor, action, entity_id, after, ts FROM audit_logs
       WHERE entity = 'employee' AND (entity_id = ? OR entity_id LIKE ?)
       ORDER BY ts DESC, rowid DESC LIMIT ?`,
    )
    .all(employeeId, `${employeeId}:%`, limit) as { actor: string; action: string; entity_id: string; after: string | null; ts: string }[];
  return rows.map((r) => {
    let detail: Record<string, unknown> | null = null;
    try {
      detail = r.after ? (JSON.parse(r.after) as Record<string, unknown>) : null;
    } catch {
      detail = null;
    }
    return { actor: r.actor, action: r.action, entityId: r.entity_id, detail, ts: r.ts };
  });
}

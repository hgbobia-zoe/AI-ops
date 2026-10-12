// People Lifecycle orchestration — the engine that ties the pure machine + policy + adapters + the
// approval gate + the audit trail together. It performs the side effects; the machine stays pure.
//
// GOVERNING LAW: rules calculate, humans approve, nothing is faked.
//  - A side-effectful provision/revoke raises an ai_approvals card (reusing createApproval — approvals.ts
//    is imported, never edited). hiring/firing are FORBIDDEN to execute via the AI outbox there, so the
//    ACTUAL in-app action (minting an invite / setUserActive) is performed HERE by the automated adapter,
//    which is a genuine in-app capability, not a faked external write. Every grant/revoke is audited.
//  - Manual/future systems never fake a write: their tasks sit manual_required until a human Marks Complete
//    (which records who + when). OFFBOARDED does NOT imply access removed — manual revokes stay open.

import { createApproval, decideApproval, getApproval } from "@/lib/aiorg/approvals";
import { insertAudit } from "@/lib/db/repo";
import { canTransition } from "./machine";
import { getAdapter } from "./adapters";
import {
  getEmployee,
  getPolicy,
  getTask,
  insertTaskIfAbsent,
  listTasks,
  setEmployeeEndDate,
  setEmployeeState,
  updateTask,
} from "./store";
import type { Employee, LifecycleState, LifecycleTask, TaskKind } from "./types";

// ── Readiness (PURE given tasks) ────────────────────────────────────────────────────────────────────
export interface Readiness {
  ready: boolean;
  completed: number;
  totalRequired: number;
  completionPct: number; // over ALL provision tasks (required + optional), for the progress bar
  blockers: { system: string; status: string }[]; // required, not-yet-completed
}

/** READY only when every REQUIRED provision task is completed. PURE — pass the employee's provision tasks. */
export function computeReadiness(provisionTasks: LifecycleTask[]): Readiness {
  const required = provisionTasks.filter((t) => t.required);
  const doneRequired = required.filter((t) => t.status === "completed");
  const blockers = required
    .filter((t) => t.status !== "completed")
    .map((t) => ({ system: t.system, status: t.status }));
  const doneAll = provisionTasks.filter((t) => t.status === "completed").length;
  const completionPct = provisionTasks.length === 0 ? 0 : Math.round((doneAll / provisionTasks.length) * 100);
  return {
    ready: required.length > 0 && blockers.length === 0,
    completed: doneRequired.length,
    totalRequired: required.length,
    completionPct,
    blockers,
  };
}

export function readinessFor(employeeId: string): Readiness {
  return computeReadiness(listTasks(employeeId, "provision"));
}

// ── Task materialization ───────────────────────────────────────────────────────────────────────────
// Entering ONBOARD materializes one provision task per policy rule; OFFBOARD materializes one revoke task
// per currently-held grant (a completed provision) PLUS any still-required system. Idempotent via
// change_key, so re-running never duplicates.
function initialStatus(mode: LifecycleTask["mode"]): LifecycleTask["status"] {
  // Automated → pending (awaits the approval gate). Everything else → manual_required (a human must act).
  return mode === "automated" ? "pending" : "manual_required";
}

export function materializeOnboardingTasks(emp: Employee): LifecycleTask[] {
  const policy = emp.department ? getPolicy(emp.department) : null;
  const rules = policy?.rules ?? [];
  return rules.map((r) => {
    // Snapshot the adapter's LIVE capability (not the static seed mode): a system is automated here only if
    // its adapter can truly act right now — Connecteam once its write scope is verified, a replay system
    // once its endpoint is captured. The policy rule still owns `required`.
    const mode = getAdapter(r.adapterId).mode();
    return insertTaskIfAbsent({
      employeeId: emp.id,
      adapterId: r.adapterId,
      system: r.system,
      kind: "provision",
      title: `Provision ${r.system}`,
      status: initialStatus(mode),
      mode,
      required: r.required,
      source: mode === "automated" ? "automated" : "manual",
      changeKey: `${emp.id}:provision:${r.adapterId}`,
    });
  });
}

export function materializeOffboardingTasks(emp: Employee): LifecycleTask[] {
  const policy = emp.department ? getPolicy(emp.department) : null;
  const rules = policy?.rules ?? [];
  const provisioned = new Set(listTasks(emp.id, "provision").filter((t) => t.status === "completed").map((t) => t.adapterId));
  // Revoke every system the policy covers; a system that was actually provisioned is the priority grant.
  return rules.map((r) => {
    const mode = getAdapter(r.adapterId).mode();
    return insertTaskIfAbsent({
      employeeId: emp.id,
      adapterId: r.adapterId,
      system: r.system,
      kind: "revoke",
      title: `Revoke ${r.system}`,
      status: initialStatus(mode),
      mode,
      required: provisioned.has(r.adapterId) || r.required,
      source: mode === "automated" ? "automated" : "manual",
      changeKey: `${emp.id}:revoke:${r.adapterId}`,
    });
  });
}

// ── Lifecycle transitions ──────────────────────────────────────────────────────────────────────────
export interface TransitionResult {
  ok: boolean;
  state: LifecycleState;
  message: string;
}

function audit(actor: string, action: string, entityId: string, before: unknown, after: unknown): void {
  try {
    insertAudit({ actor, action, entity: "employee", entityId, before, after });
  } catch {
    /* audit best-effort */
  }
}

function move(emp: Employee, to: LifecycleState, actor: string, action: string): TransitionResult {
  if (!canTransition(emp.lifecycleState, to)) {
    return { ok: false, state: emp.lifecycleState, message: `Illegal transition ${emp.lifecycleState} → ${to}.` };
  }
  setEmployeeState(emp.id, to);
  audit(actor, action, emp.id, { state: emp.lifecycleState }, { state: to });
  return { ok: true, state: to, message: `${action.replace(/_/g, " ").toLowerCase()} ok` };
}

/** HIRE → ONBOARD: begin onboarding and materialize the provision tasks from the role's policy. */
export function startOnboarding(employeeId: string, actor: string): TransitionResult {
  const emp = getEmployee(employeeId);
  if (!emp) return { ok: false, state: "HIRE", message: "employee not found" };
  const r = move(emp, "ONBOARD", actor, "ONBOARDING_STARTED");
  if (r.ok) materializeOnboardingTasks({ ...emp, lifecycleState: "ONBOARD" });
  return r;
}

/** ONBOARD → READY: guarded by readiness (every required provision task completed). */
export function advanceToReady(employeeId: string, actor: string): TransitionResult {
  const emp = getEmployee(employeeId);
  if (!emp) return { ok: false, state: "HIRE", message: "employee not found" };
  const readiness = readinessFor(emp.id);
  if (!readiness.ready) {
    const names = readiness.blockers.map((b) => b.system).join(", ");
    return { ok: false, state: emp.lifecycleState, message: `Not ready — ${readiness.blockers.length} blocker(s): ${names}.` };
  }
  return move(emp, "READY", actor, "MARKED_READY");
}

/** READY → ACTIVE. */
export function activate(employeeId: string, actor: string): TransitionResult {
  const emp = getEmployee(employeeId);
  if (!emp) return { ok: false, state: "HIRE", message: "employee not found" };
  return move(emp, "ACTIVE", actor, "ACTIVATED");
}

/** …any live state… → OFFBOARD. Records the effective end date (immediate OR future) and materializes the
 *  revoke tasks. A future-dated termination leaves its automated revokes pending until the tick fires. */
export function startOffboarding(employeeId: string, actor: string, effectiveDate: string | null): TransitionResult {
  const emp = getEmployee(employeeId);
  if (!emp) return { ok: false, state: "HIRE", message: "employee not found" };
  const r = move(emp, "OFFBOARD", actor, "OFFBOARDING_STARTED");
  if (r.ok) {
    setEmployeeEndDate(emp.id, effectiveDate);
    materializeOffboardingTasks({ ...emp, lifecycleState: "OFFBOARD", endDate: effectiveDate });
  }
  return r;
}

/** OFFBOARD → OFFBOARDED. HONEST: this marks the HR process done; it does NOT auto-complete manual revoke
 *  tasks (they stay open + visible). Access removal is tracked separately per task, never implied here. */
export function completeOffboarding(employeeId: string, actor: string): TransitionResult {
  const emp = getEmployee(employeeId);
  if (!emp) return { ok: false, state: "HIRE", message: "employee not found" };
  return move(emp, "OFFBOARDED", actor, "OFFBOARDED");
}

// ── Task execution + completion ──────────────────────────────────────────────────────────────────────
export interface TaskActionResult {
  ok: boolean;
  task: LifecycleTask | null;
  message: string;
}

const ACCESS_ACTION: Record<TaskKind, string> = { provision: "ACCESS_GRANTED", revoke: "ACCESS_REVOKED" };

/** Ensure a governance approval card exists for a side-effectful automated task (idempotent via its
 *  change_key). Returns the approval id. The card is honest INTENT: hiring/firing are forbidden to execute
 *  via the AI outbox, so the real in-app action is performed by executeAutomatedTask, not by the outbox. */
function ensureApproval(emp: Employee, task: LifecycleTask): string {
  if (task.approvalId && getApproval(task.approvalId)) return task.approvalId;
  const isProvision = task.kind === "provision";
  const approval = createApproval({
    agentId: "hiring", //       the AI-org hiring/HR employee owns people provisioning
    owner: "Lisa",
    title: `${isProvision ? "Provision" : "Revoke"} ${task.system} for ${emp.displayName}`,
    actionType: isProvision ? "hiring" : "firing", // the semantically-closest FORBIDDEN-to-execute card
    actionPayload: { employeeId: emp.id, adapterId: task.adapterId, taskId: task.id, kind: task.kind },
    card: {
      what: `${isProvision ? "Create" : "Remove"} the ${task.system} access for ${emp.displayName} (${emp.role}).`,
      why: `${isProvision ? "Onboarding" : "Offboarding"} per the ${emp.department ?? "—"} access policy.`,
      dataUsed: `Employee ${emp.id}; access_policy ${emp.department ?? "—"}; adapter ${task.adapterId}.`,
      expectedOutcome: isProvision ? "A Zoe login invite is issued (hire sets their own password)." : "The Zoe login is deactivated.",
      risk: isProvision ? "Grants console access — scoped to the employee's role." : "Removes console access immediately.",
      whatIfApproved: "The People engine performs the in-app action and records the grant/revoke in the audit log.",
    },
    idempotencyKey: `people:${task.changeKey}`,
  });
  updateTask(task.id, { approvalId: approval.id, status: "in_progress" });
  return approval.id;
}

/**
 * Approve + execute an AUTOMATED task (owner/admin gated at the API). One owner/admin action = the human
 * approval gate AND the in-app execution, fully audited:
 *   1. ensure the ai_approvals governance card exists and stamp it decided (approve) — recorded as intent,
 *   2. run the adapter's automate()/revoke() (the real in-app createInvite / setUserActive),
 *   3. record the result on the task + insertAudit(ACCESS_GRANTED/ACCESS_REVOKED).
 * Only valid for an adapter whose mode() is currently automated — never fakes a manual/future write.
 */
export async function executeAutomatedTask(taskId: string, actor: string): Promise<TaskActionResult> {
  const task = getTask(taskId);
  if (!task) return { ok: false, task: null, message: "task not found" };
  if (task.status === "completed") return { ok: true, task, message: "Already completed." };
  const emp = getEmployee(task.employeeId);
  if (!emp) return { ok: false, task, message: "employee not found" };
  const adapter = getAdapter(task.adapterId);
  if (adapter.mode() !== "automated") {
    return { ok: false, task, message: `${task.system} is not automated — use Mark Complete after doing it by hand.` };
  }

  // 1) Governance card + decision (honest: recorded as approved intent; the real action is in-app below).
  const approvalId = ensureApproval(emp, task);
  decideApproval(approvalId, "approve", actor, { note: "People Lifecycle: executed the in-app access change." });

  // 2) Execute the real in-app action.
  let result;
  try {
    result = task.kind === "provision" ? await adapter.automate(emp) : await adapter.revoke(emp);
  } catch (e) {
    const detail = e instanceof Error ? e.message : "adapter error";
    updateTask(task.id, { status: "failed", error: detail });
    return { ok: false, task: getTask(task.id), message: `Failed: ${detail}` };
  }

  // 3) Record.
  const now = new Date().toISOString();
  const updated = updateTask(task.id, {
    status: result.status,
    externalRef: result.externalRef ?? task.externalRef,
    error: result.ok ? null : result.detail,
    actor,
    completedAt: result.status === "completed" ? now : null,
  });
  audit(actor, ACCESS_ACTION[task.kind], `${emp.id}:${task.adapterId}`, { status: task.status }, { status: result.status, source: "automated", detail: result.detail, approvalId });
  return { ok: result.ok, task: updated, message: result.detail };
}

/** Mark a MANUAL/future task complete — the human did it in the external system and is attesting to it.
 *  Records who + when (evidence), never a bare acknowledge. */
export function markTaskComplete(taskId: string, actor: string, note?: string): TaskActionResult {
  const task = getTask(taskId);
  if (!task) return { ok: false, task: null, message: "task not found" };
  if (task.status === "completed") return { ok: true, task, message: "Already completed." };
  const emp = getEmployee(task.employeeId);
  const now = new Date().toISOString();
  const updated = updateTask(task.id, { status: "completed", actor, error: null, completedAt: now });
  audit(actor, ACCESS_ACTION[task.kind], `${task.employeeId}:${task.adapterId}`, { status: task.status }, { status: "completed", source: "manual", note: note ?? null });
  void emp;
  return { ok: true, task: updated, message: `Marked ${task.system} ${task.kind} complete.` };
}

/** Retry a failed task (reset to its initial status so it can be re-run / re-attempted). */
export function retryTask(taskId: string, actor: string): TaskActionResult {
  const task = getTask(taskId);
  if (!task) return { ok: false, task: null, message: "task not found" };
  if (!task.retryable) return { ok: false, task, message: "Task is not retryable." };
  const next = task.mode === "automated" ? "pending" : "manual_required";
  const updated = updateTask(task.id, { status: next, error: null });
  audit(actor, "TASK_RETRIED", `${task.employeeId}:${task.adapterId}`, { status: task.status }, { status: next });
  return { ok: true, task: updated, message: `Reset ${task.system} for another attempt.` };
}

/** Skip a non-required task (deliberately not applicable). */
export function skipTask(taskId: string, actor: string): TaskActionResult {
  const task = getTask(taskId);
  if (!task) return { ok: false, task: null, message: "task not found" };
  if (task.required) return { ok: false, task, message: "A required task cannot be skipped." };
  const updated = updateTask(task.id, { status: "skipped", actor });
  audit(actor, "TASK_SKIPPED", `${task.employeeId}:${task.adapterId}`, { status: task.status }, { status: "skipped" });
  return { ok: true, task: updated, message: `Skipped ${task.system}.` };
}

// AI Org — the control-plane type model. An AI employee is a CONFIG object (reviewed in code, like
// RUNTIME_JOBS), not a DB row a Member could edit. Status / metrics / lastRun are DERIVED from real
// signals at runtime (never stored stale, never fabricated) — the derivation lives in service.ts and
// the pure helpers at the bottom of this file. Governing law holds: RULES CALCULATE, AI INTERPRETS;
// a "coming" employee shows NO metrics, an unknown stays null and the UI says so.

// ── Org structure ───────────────────────────────────────────────────────────
export type AiDept = "sales" | "backoffice" | "marketing" | "ops_exec";

/** Honest backing state of an employee's data source (see the per-agent table in the design doc).
 *  - live:    real wired data today
 *  - seed:    the workflow is live but running on demo/seed data (badged SEED, e.g. Event Radar)
 *  - partial: real but manual-entry, dormant-LLM, or an UNVERIFIED gap
 *  - coming:  no real data source yet — ship as a placeholder, NEVER with fabricated metrics */
export type AiBacking = "live" | "seed" | "partial" | "coming";

// ── Toolbox + permissions (§4 of the design doc) ──────────────────────────────
/** Per-tool, per-employee authority. FORBIDDEN tools are simply ABSENT from a toolbox. */
export type PermLevel =
  | "READ" //              retrieve data
  | "ANALYZE" //           process + recommend (no external effect)
  | "DRAFT" //             prepare an artifact, cannot execute
  | "EXECUTE" //           perform without approval (rare; low-risk only)
  | "APPROVAL_REQUIRED" // prepare + wait for a human decision
  | "FORBIDDEN"; //        tool not exposed at all

export type ToolCategory =
  | "DATA" //          read a real module
  | "ANALYSIS" //      run a deterministic calc / score
  | "COMMS_DRAFT" //   prepare an SMS / email / note
  | "COMMS_SEND" //    send (always APPROVAL + master-switch)
  | "WORKFLOW" //      create/assign a task, raise an exception, record audit
  | "EXTERNAL"; //     an outbox op / provider write that reaches outside the app

export interface Tool {
  id: string;
  label: string;
  category: ToolCategory;
  perm: PermLevel;
  /** Real backing, "file:function", or "none" when the capability does not exist yet. */
  backing: string;
}

// ── Inputs + rules ────────────────────────────────────────────────────────────
/** A real module/function the employee consumes, with a deep link into its backing blade. */
export interface InputRef {
  label: string; // human name, e.g. "Sales OS worklist"
  ref: string; // "file:function" it reads
  href?: string; // deep link into the backing blade
}

export interface EscalationRule {
  when: string; // the condition that routes to the human owner / Priority filter
}

// ── The employee config (source of truth in registry.ts) ──────────────────────
export interface AIEmployee {
  id: string; // "lead-intelligence"
  name: string; // "Lead Intelligence"
  department: AiDept;
  owner: string; // human owner name (must match a HUMANS entry)
  mission: string; // one sentence
  responsibilities: string[];
  inputs: InputRef[];
  toolbox: Tool[]; // the ONLY tools this employee may use
  escalationRules: EscalationRule[];
  backing: AiBacking;
  /** How the value of this employee is measured (shown on the detail page). */
  valueMeasure: string;
  /** The runtime-job / audit key used to derive lastRun, when wired to one. */
  runKey?: string;
  /** The connections.ts health key for this employee's data source, when it has one. */
  healthKey?: string;
}

// ── A human manager (real roster, no fabricated people) ───────────────────────
export interface Human {
  name: string; // "Jessie"
  role: string; // "Sales"
}

// ── Derived views (computed in service.ts; never stored) ──────────────────────
export type AiLiveState = "ok" | "attention" | "idle" | "coming";

export interface AiMetric {
  label: string;
  value: string | number;
  tone?: "critical" | "attention" | "positive" | "default";
}

export interface AiEmployeeView {
  id: string;
  name: string;
  department: AiDept;
  owner: string;
  mission: string;
  backing: AiBacking;
  /** Derived liveness dot. "coming" employees are always "coming" (no metrics). */
  state: AiLiveState;
  /** Headline metrics for the command center + detail (empty for "coming"). */
  metrics: AiMetric[];
  lastRunAt: string | null;
  lastDetail: string | null;
  /** Data-source health, from computeConnections() when the employee declares a healthKey. */
  health: { status: "ok" | "attention" | "off"; label: string } | null;
}

export interface HumanCard {
  name: string;
  role: string;
  employeeCount: number;
  /** Live status dots for the employees this human manages. */
  employees: { id: string; name: string; state: AiLiveState; backing: AiBacking }[];
  openApprovals: number;
  openExceptions: number;
  aiActivityToday: number;
}

// ── Pure derivation helpers (unit-testable, no DB) ─────────────────────────────

/** The raw per-employee signal the aggregator resolves from real modules. A null `metrics` means the
 *  backing module could not resolve a number (honest "—"); an empty array means "no metric defined". */
export interface EmployeeSignal {
  lastRunAt?: string | null;
  lastDetail?: string | null;
  /** Null => unresolved (show "—"); otherwise the real metrics. */
  metrics?: AiMetric[] | null;
  /** Resolved health for this employee's data source, or null when it declares none. */
  health?: { status: "ok" | "attention" | "off"; label: string } | null;
  /** When the backing is live/partial/seed: does the source have anything to show right now? Drives
   *  the idle-vs-ok dot. Defaults to true. */
  active?: boolean;
}

/** Build the derived view for one employee from its config + resolved signal. PURE.
 *  Enforces the house law: a "coming" employee NEVER shows metrics and is always state "coming". */
export function buildEmployeeView(emp: AIEmployee, signal: EmployeeSignal = {}): AiEmployeeView {
  const coming = emp.backing === "coming";
  const metrics = coming ? [] : signal.metrics ?? [];
  let state: AiLiveState;
  if (coming) state = "coming";
  else if (signal.health && signal.health.status === "off") state = "attention";
  else if (signal.health && signal.health.status === "attention") state = "attention";
  else if (signal.active === false) state = "idle";
  else state = "ok";
  return {
    id: emp.id,
    name: emp.name,
    department: emp.department,
    owner: emp.owner,
    mission: emp.mission,
    backing: emp.backing,
    state,
    metrics,
    lastRunAt: coming ? null : signal.lastRunAt ?? null,
    lastDetail: coming ? null : signal.lastDetail ?? null,
    health: coming ? null : signal.health ?? null,
  };
}

/** Split a toolbox into what the employee CAN do unaided vs what REQUIRES a human approval. PURE.
 *  FORBIDDEN tools never appear in config, so they are not shown. */
export function authoritySplit(toolbox: Tool[]): { can: Tool[]; requiresApproval: Tool[] } {
  const can: Tool[] = [];
  const requiresApproval: Tool[] = [];
  for (const t of toolbox) {
    if (t.perm === "FORBIDDEN") continue;
    if (t.perm === "APPROVAL_REQUIRED") requiresApproval.push(t);
    else can.push(t);
  }
  return { can, requiresApproval };
}

/** Priority label mapping P0..P3 over the existing critical/high/medium/info scale (the design doc
 *  notes no P0-P3 literal exists in code — this is a label mapping, not new severity logic). PURE. */
export function priorityLabel(priority: "critical" | "high" | "medium" | "info"): "P0" | "P1" | "P2" | "P3" {
  return priority === "critical" ? "P0" : priority === "high" ? "P1" : priority === "medium" ? "P2" : "P3";
}

/** Roll employee views up into per-human manager cards. PURE given the per-human approval/exception/
 *  activity counts (resolved from real signals by the aggregator). */
export function rollupHumans(
  humans: Human[],
  views: AiEmployeeView[],
  perHuman: Record<string, { openApprovals: number; openExceptions: number; aiActivityToday: number }>,
): HumanCard[] {
  return humans.map((h) => {
    const mine = views.filter((v) => v.owner === h.name);
    const counts = perHuman[h.name] ?? { openApprovals: 0, openExceptions: 0, aiActivityToday: 0 };
    return {
      name: h.name,
      role: h.role,
      employeeCount: mine.length,
      employees: mine.map((v) => ({ id: v.id, name: v.name, state: v.state, backing: v.backing })),
      openApprovals: counts.openApprovals,
      openExceptions: counts.openExceptions,
      aiActivityToday: counts.aiActivityToday,
    };
  });
}

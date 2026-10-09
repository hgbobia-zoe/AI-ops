// Event DEPENDENCY model — PURE (no DB/net/AI/UI).
//
// Governing law: RULES CALCULATE, AI INTERPRETS. This layer answers one deterministic question: for a
// given FORWARD lifecycle step, are the preconditions met, and if not, exactly what is missing? It does
// NOT perform transitions — src/lib/event/machine.ts remains the ONLY definition of a legal transition.
// This module only reports whether a transition's *gates* hold, computed from the Phase-1 EventView plus
// the Phase-3 requirement set (requirements.ts). It mints nothing and fetches nothing.
//
// Reused (no duplication):
//   • machine.ts — nextStates()/LIFECYCLE_ORDER give the single forward edge out of the current state, and
//     isTerminal() ends the chain. The legal-transition definition is NOT re-implemented here.
//   • requirements.ts / types.ts Requirement[] — the →READY gate is EXACTLY P3's blocking-requirement gate
//     (isReadyGateSatisfied's rule: a blocking requirement must be OK or UNVERIFIED). We map dependencies
//     onto the already-resolved Requirement[]; we do NOT re-derive any requirement status.
//   • lifecycle.ts deriveLifecycle — canAdvance() reuses it to know the CURRENT state (same facts path as
//     the resolvers), rather than re-deriving commercial/logistics state here.
//
// UNVERIFIED handling (the honesty rule, applied uniformly): a dependency the data cannot confirm is
// reported as UNVERIFIED — it is NOT counted as satisfied and NOT counted as a hard blocker (unknown ≠
// deficiency), matching P3's readiness rule. e.g. owned-inventory confirmation/reconciliation has no owned
// master (see inventory.ts), so it is always UNVERIFIED and never auto-satisfied.

import type { EventView, Requirement, RequirementStatus } from "./types";
import { deriveLifecycle, type LifecycleFacts } from "./lifecycle";
import { LIFECYCLE_ORDER, isTerminal, nextStates, type LifecycleState } from "./machine";

/** The forward lifecycle steps that carry a precondition GATE. Other forward steps (→QUOTED, →BOOKED,
 *  →PLANNING, →SETUP, →LIVE, →PICKUP, →CLOSEOUT) are driven purely by observed facts and have no extra
 *  dependency gate in this layer. */
export type DependencyTransition = "→READY" | "→DISPATCHED" | "→CLOSED";

/** How a dependency is satisfied:
 *  - `requirement`: by a Phase-3 Requirement (OK ⇒ SATISFIED, UNVERIFIED ⇒ UNVERIFIED, BLOCKED/WARNING ⇒
 *    UNMET). When that requirement wasn't generated for this event it is UNVERIFIED (we can't assert it).
 *  - `ready-gate`: the whole P3 blocking-requirement gate (expands to one dependency per blocking req).
 *  - `fact`: a derivable EventView fact, resolved by a named pure resolver below. */
export type SatisfiedBy =
  | { kind: "requirement"; requirementId: string }
  | { kind: "ready-gate" }
  | { kind: "fact"; factId: EventFactId };

/** The EventView facts a dependency can be satisfied by (each resolved by a pure function over EventView). */
export type EventFactId =
  | "truck_assigned"
  | "owned_inventory_confirmed"
  | "pickup_completed"
  | "owned_inventory_reconciled"
  | "financial_closeout"
  | "issues_recorded";

/** The static shape of a dependency (data, not prose). */
export interface DependencySpec {
  id: string;
  label: string;
  satisfiedBy: SatisfiedBy;
  /** True when this precondition must hold for the step to be legal. UNVERIFIED still never counts as a
   *  blocker even when blocking:true — intent is expressed, but an unknown is not a deficiency. */
  blocking: boolean;
}

/** A dependency's resolved status. SATISFIED = data backs it and it holds; UNMET = a real, data-backed
 *  deficiency; UNVERIFIED = we cannot confirm it from data (never satisfied, never a blocker). */
export type DependencyStatus = "SATISFIED" | "UNMET" | "UNVERIFIED";

/** A resolved dependency: its static spec plus the computed status and a human detail. */
export interface Dependency extends DependencySpec {
  status: DependencyStatus;
  detail: string;
}

// ── The dependency table — keyed by the FORWARD transition it gates. DATA, not code paths. ──────────────
//
// → DISPATCHED: cannot dispatch until a route exists, a truck is assigned, a driver is assigned, and the
//   required inventory is confirmed (the last is UNVERIFIED by design — no owned-inventory master).
// → READY: the P3 readiness gate (all blocking requirements satisfied). Expressed as a single ready-gate
//   entry so this layer does NOT re-declare which requirements are blocking — requirements.ts owns that;
//   resolveDependencies expands it into one dependency per blocking requirement so the READY gate deps
//   match P3 exactly.
// → CLOSED: cannot close until pickup is completed, equipment reconciled (UNVERIFIED — no owned master),
//   financial closeout completed, and issues recorded (UNVERIFIED — no issue-capture source wired yet).
export const DEPENDENCIES: Record<DependencyTransition, DependencySpec[]> = {
  "→READY": [
    { id: "ready_gate", label: "All blocking readiness requirements satisfied", satisfiedBy: { kind: "ready-gate" }, blocking: true },
  ],
  "→DISPATCHED": [
    { id: "route_planned", label: "Route exists", satisfiedBy: { kind: "requirement", requirementId: "route_exists" }, blocking: true },
    { id: "truck_assigned", label: "Truck assigned", satisfiedBy: { kind: "fact", factId: "truck_assigned" }, blocking: true },
    { id: "driver_assigned", label: "Driver assigned", satisfiedBy: { kind: "requirement", requirementId: "driver_assigned" }, blocking: true },
    { id: "inventory_confirmed", label: "Required inventory confirmed", satisfiedBy: { kind: "fact", factId: "owned_inventory_confirmed" }, blocking: true },
  ],
  "→CLOSED": [
    { id: "pickup_completed", label: "Pickup completed", satisfiedBy: { kind: "fact", factId: "pickup_completed" }, blocking: true },
    { id: "equipment_reconciled", label: "Equipment reconciled", satisfiedBy: { kind: "fact", factId: "owned_inventory_reconciled" }, blocking: true },
    { id: "financial_closeout", label: "Financial closeout completed", satisfiedBy: { kind: "fact", factId: "financial_closeout" }, blocking: true },
    { id: "issues_recorded", label: "Issues recorded", satisfiedBy: { kind: "fact", factId: "issues_recorded" }, blocking: false },
  ],
};

/** The lifecycle states that carry a dependency gate (the keys of DEPENDENCIES, without the arrow). */
export const GATED_STATES: LifecycleState[] = ["READY", "DISPATCHED", "CLOSED"];

/** The arrow key for a target state, or null when that state has no dependency gate. PURE. */
export function dependencyKey(target: LifecycleState): DependencyTransition | null {
  const key = `→${target}` as DependencyTransition;
  return key in DEPENDENCIES ? key : null;
}

export interface DependencyContext {
  /** The event's resolved, data-backed Phase-3 requirement set. */
  requirements?: Requirement[] | null;
}

/**
 * Resolve EVERY dependency of a forward step into a {status, detail} — SATISFIED / UNMET / UNVERIFIED.
 * This is the full picture (it surfaces UNVERIFIED dependencies too); `unmetDependencies` is the blocking
 * subset. Returns [] for a target with no gate. PURE.
 */
export function resolveDependencies(
  target: LifecycleState,
  view: EventView,
  ctx: DependencyContext = {},
): Dependency[] {
  const key = dependencyKey(target);
  if (!key) return [];
  const requirements = ctx.requirements ?? [];
  const specs = DEPENDENCIES[key];
  const out: Dependency[] = [];
  for (const spec of specs) {
    if (spec.satisfiedBy.kind === "ready-gate") {
      out.push(...expandReadyGate(requirements));
      continue;
    }
    out.push(resolveSpec(spec, view, requirements));
  }
  return out;
}

/**
 * The BLOCKING, UNMET dependencies of a forward step — exactly what stands between the event and that step.
 * An UNVERIFIED dependency is NOT returned here (unknown ≠ deficiency); it is surfaced via
 * resolveDependencies. Returns [] for an ungated target or when every blocking dependency is met. PURE.
 */
export function unmetDependencies(
  target: LifecycleState,
  view: EventView,
  ctx: DependencyContext = {},
): Dependency[] {
  return resolveDependencies(target, view, ctx).filter((d) => d.blocking && d.status === "UNMET");
}

export interface CanAdvanceResult {
  /** The single forward happy-path state (from the machine), or null when the event is terminal. */
  nextState: LifecycleState | null;
  /** The blocking, unmet preconditions of that forward step (empty ⇒ the step's gates are met). */
  blockedBy: Dependency[];
}

/**
 * Whether the event's NEXT forward transition's preconditions hold, and if not, exactly what's missing.
 * The machine owns the forward edge (nextStates + LIFECYCLE_ORDER); this only reports the gate. It never
 * performs a transition. Deterministic. PURE.
 */
export function canAdvance(view: EventView, ctx: DependencyContext = {}): CanAdvanceResult {
  const facts: LifecycleFacts = { requirements: ctx.requirements ?? null };
  const current = deriveLifecycle(view, facts).state;
  if (isTerminal(current)) return { nextState: null, blockedBy: [] };

  // The forward happy-path step = the machine's next state that lies on LIFECYCLE_ORDER (trips are off-path).
  const nextState = nextStates(current).find((s) => LIFECYCLE_ORDER.includes(s)) ?? null;
  if (!nextState) return { nextState: null, blockedBy: [] };

  const blockedBy = unmetDependencies(nextState, view, ctx);
  return { nextState, blockedBy };
}

// ── resolution helpers (pure) ───────────────────────────────────────────────────────────────────────

/** Map a Requirement status onto a DependencyStatus (the same rule the P3 READY gate uses). */
function statusFromRequirement(status: RequirementStatus): DependencyStatus {
  if (status === "OK") return "SATISFIED";
  if (status === "UNVERIFIED") return "UNVERIFIED";
  return "UNMET"; // BLOCKED or WARNING = a real, data-backed deficiency
}

/** Expand the P3 readiness gate into one dependency per BLOCKING requirement, so the →READY dependencies
 *  match requirements.ts exactly (and never re-declare which requirements are blocking). When no blocking
 *  requirement exists yet, emit a single UNMET gate — mirroring isReadyGateSatisfied (an empty set is
 *  never "ready"). */
function expandReadyGate(requirements: Requirement[]): Dependency[] {
  const blocking = requirements.filter((r) => r.blocking);
  if (blocking.length === 0) {
    return [{
      id: "ready_gate",
      label: "Readiness requirements generated",
      satisfiedBy: { kind: "ready-gate" },
      blocking: true,
      status: "UNMET",
      detail: "No blocking readiness requirements have been generated yet — the event is not ready.",
    }];
  }
  return blocking.map((r) => ({
    id: `ready:${r.id}`,
    label: r.label,
    satisfiedBy: { kind: "requirement", requirementId: r.id } as SatisfiedBy,
    blocking: true,
    status: statusFromRequirement(r.status),
    detail: r.resolution,
  }));
}

function resolveSpec(spec: DependencySpec, view: EventView, requirements: Requirement[]): Dependency {
  if (spec.satisfiedBy.kind === "requirement") {
    const req = requirements.find((r) => r.id === (spec.satisfiedBy as { requirementId: string }).requirementId);
    if (!req) {
      return { ...spec, status: "UNVERIFIED", detail: `Requirement "${(spec.satisfiedBy as { requirementId: string }).requirementId}" not generated for this event — cannot verify.` };
    }
    return { ...spec, status: statusFromRequirement(req.status), detail: req.resolution };
  }
  if (spec.satisfiedBy.kind === "fact") {
    const resolved = resolveFact(spec.satisfiedBy.factId, view);
    return { ...spec, status: resolved.status, detail: resolved.detail };
  }
  // ready-gate specs are expanded upstream in resolveDependencies and never reach here.
  return { ...spec, status: "UNVERIFIED", detail: "Unhandled dependency kind." };
}

/** Pure resolvers for each EventView-derivable fact. */
function resolveFact(factId: EventFactId, view: EventView): { status: DependencyStatus; detail: string } {
  switch (factId) {
    case "truck_assigned":
      return factTruckAssigned(view);
    case "owned_inventory_confirmed":
      return {
        status: "UNVERIFIED",
        detail: "No owned-inventory master exists (inventory.ts); owned stock cannot be confirmed from data (not a deficiency).",
      };
    case "pickup_completed":
      return factPickupCompleted(view);
    case "owned_inventory_reconciled":
      return {
        status: "UNVERIFIED",
        detail: "Owned-inventory reconciliation has no backing source (no owned master); cannot verify (not a deficiency).",
      };
    case "financial_closeout":
      return factFinancialCloseout(view);
    case "issues_recorded":
      return {
        status: "UNVERIFIED",
        detail: "No issue/exception capture is wired to the Event view; cannot verify issues were recorded (not a deficiency).",
      };
  }
}

function factTruckAssigned(view: EventView): { status: DependencyStatus; detail: string } {
  const stops = view.logistics.stops;
  if (!view.logistics.present || stops.length === 0) {
    return { status: "UNMET", detail: "No route/stops exist yet, so no truck is assigned." };
  }
  const assigned = stops.some((s) => typeof s.truckId === "string" && s.truckId.trim() !== "");
  return assigned
    ? { status: "SATISFIED", detail: "A truck is assigned to the routed stops." }
    : { status: "UNMET", detail: "Routed stops carry no truck assignment." };
}

function factPickupCompleted(view: EventView): { status: DependencyStatus; detail: string } {
  const o = view.outcome;
  if (o.present && o.allCompleted === true) {
    return { status: "SATISFIED", detail: "event_outcomes: route closed with every stop completed." };
  }
  const pickups = view.logistics.stops.filter((s) => s.kind === "pickup");
  if (pickups.length > 0) {
    const done = pickups.every((s) => s.state === "Completed" || s.state === "Returned");
    return done
      ? { status: "SATISFIED", detail: "The pickup/teardown stop(s) are completed/returned." }
      : { status: "UNMET", detail: "A pickup/teardown stop is not yet completed." };
  }
  if (o.present && o.allCompleted === false) {
    return { status: "UNMET", detail: "event_outcomes: route closed but not every stop completed." };
  }
  return { status: "UNVERIFIED", detail: "No pickup stop and no closed outcome — pickup completion cannot be confirmed." };
}

function factFinancialCloseout(view: EventView): { status: DependencyStatus; detail: string } {
  const c = view.commercial;
  if (!c.present) return { status: "UNVERIFIED", detail: "No commercial record — financial closeout cannot be confirmed." };
  if (c.amountDue != null) {
    return c.amountDue <= 0
      ? { status: "SATISFIED", detail: "No balance due — the event is paid in full." }
      : { status: "UNMET", detail: `$${round(c.amountDue)} balance still due.` };
  }
  if (c.amountPaid != null && c.grandTotal != null) {
    return c.amountPaid >= c.grandTotal
      ? { status: "SATISFIED", detail: "Amount paid covers the grand total." }
      : { status: "UNMET", detail: `Paid $${round(c.amountPaid)} of $${round(c.grandTotal)}.` };
  }
  return { status: "UNVERIFIED", detail: "No payment figures on the booking — financial closeout cannot be confirmed." };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

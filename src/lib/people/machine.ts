// People Lifecycle state machine — the PURE, guarded transition table. This is the ONLY definition of a
// legal employee state change: rules calculate, the engine moves state only through a guarded transition.
//
// Modeled 1:1 on src/lib/event/machine.ts (fixed TRANSITIONS table, canTransition guard, trip/terminal
// states). PURE: no DB, no net, no AI, fully unit-tested.
//
//   HIRE → ONBOARD → READY → ACTIVE          the happy path (onboarding → employed)
//   …any live state… → OFFBOARD → OFFBOARDED  offboarding (OFFBOARD is a trip reachable from anywhere)
//
// OFFBOARD mirrors CANCELLED on the event machine: a safety exit reachable from ANY non-terminal state
// (you can let someone go mid-onboarding). OFFBOARDED is terminal. Note OFFBOARDED means "the HR process
// is done", NOT "all access removed" — outstanding manual revokes live on in lifecycle_task (see
// lifecycle.ts); this machine deliberately does not conflate the two.

import type { LifecycleState } from "./types";

/** The forward happy path (onboarding → active). Trip/terminal states are deliberately NOT in this list. */
export const LIFECYCLE_ORDER: LifecycleState[] = ["HIRE", "ONBOARD", "READY", "ACTIVE"];

/** Fully terminal — no transition out at all. */
export const TERMINAL_STATES: LifecycleState[] = ["OFFBOARDED"];

/** "Trip" state reachable from ANY non-terminal state regardless of the forward map — the deliberate
 *  off-path exit (an employee leaves). Mirrors the event machine's CANCELLED/LOST. */
const TRIP_STATES: LifecycleState[] = ["OFFBOARD"];

// Forward transitions out of each state — exactly one step forward, no skips. The OFFBOARD trip edges are
// NOT listed here; they are granted by canTransition from any non-terminal state. ACTIVE moves forward
// only by being offboarded (its single exit is the trip), so its forward list is empty.
const TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  HIRE: ["ONBOARD"],
  ONBOARD: ["READY"],
  READY: ["ACTIVE"],
  ACTIVE: [],
  OFFBOARD: ["OFFBOARDED"],
  OFFBOARDED: [],
};

/** Is this a terminal state (no transition out possible)? PURE. */
export function isTerminal(state: LifecycleState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Is `to` a legal transition from `from`? PURE.
 *  - no self-transition,
 *  - nothing leaves a terminal state,
 *  - a trip to OFFBOARD is legal from ANY non-terminal state,
 *  - otherwise only the single forward step in the transition map is allowed (no skipping).
 */
export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  if (from === to) return false;
  if (isTerminal(from)) return false;
  if (TRIP_STATES.includes(to)) return true;
  return TRANSITIONS[from].includes(to);
}

/** Every legal next state from `from` (the forward step plus the always-available OFFBOARD trip), or []
 *  when terminal. PURE. */
export function nextStates(from: LifecycleState): LifecycleState[] {
  if (isTerminal(from)) return [];
  const forward = TRANSITIONS[from];
  const trips = TRIP_STATES.filter((t) => t !== from && !forward.includes(t));
  return [...forward, ...trips];
}

/** Guarded transition: the new state for a legal move, or an error for an illegal one. PURE. The only
 *  sanctioned way a write may change an employee's lifecycle state. */
export function transition(
  from: LifecycleState,
  to: LifecycleState,
): { ok: true; state: LifecycleState } | { ok: false; error: string } {
  if (canTransition(from, to)) return { ok: true, state: to };
  return { ok: false, error: `illegal transition ${from} -> ${to}` };
}

/** The happy-path order index of a state (0-based along LIFECYCLE_ORDER), or -1 for the off-path
 *  OFFBOARD/OFFBOARDED states. PURE. */
export function lifecycleIndex(state: LifecycleState): number {
  return LIFECYCLE_ORDER.indexOf(state);
}

/** Narrowing guard: whether an arbitrary value is a known LifecycleState. PURE. */
export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === "string" && value in TRANSITIONS;
}

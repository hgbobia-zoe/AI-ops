// Event Lifecycle state machine — the PURE, guarded transition table. This is the heart of
// "RULES CALCULATE": the set of LEGAL transitions is fixed here, in code, and this module is the ONLY
// definition of what a legal event state change is. The AI never decides a transition — state only ever
// changes through a guarded transition (see lifecycle.ts for how the CURRENT state is derived from facts).
//
// Modeled 1:1 on src/lib/ai/improvement/machine.ts (fixed TRANSITIONS table, canTransition guard,
// trip/terminal states). PURE: no DB, no net, no AI, fully unit-tested.
//
// Phase-2 boundary: this machine DEFINES/GUARDS valid transitions for when state-writes land in a later
// phase. P2 performs no writes and stores no state — the current state is a pure DERIVATION of facts
// (lifecycle.ts). A transition is the sanctioned shape a future write must take to be legal.

/** The whole-event lifecycle state. The happy path OPPORTUNITY → … → CLOSED plus the two trip/terminal
 *  states an event can fall into from anywhere: CANCELLED (a booked event called off) and LOST (a
 *  quote/opportunity that never booked). */
export type LifecycleState =
  | "OPPORTUNITY"
  | "QUOTED"
  | "BOOKED"
  | "PLANNING"
  | "READY"
  | "DISPATCHED"
  | "SETUP"
  | "LIVE"
  | "PICKUP"
  | "CLOSEOUT"
  | "CLOSED"
  | "CANCELLED"
  | "LOST";

/** The happy-path order (commercial → planning → logistics → closeout). Trip states are deliberately NOT
 *  in this list — they are off the forward path and reachable only as safety exits. */
export const LIFECYCLE_ORDER: LifecycleState[] = [
  "OPPORTUNITY",
  "QUOTED",
  "BOOKED",
  "PLANNING",
  "READY",
  "DISPATCHED",
  "SETUP",
  "LIVE",
  "PICKUP",
  "CLOSEOUT",
  "CLOSED",
];

/** Fully terminal states — no transition out at all. CLOSED is the happy-path end; CANCELLED/LOST are the
 *  trip ends. */
export const TERMINAL_STATES: LifecycleState[] = ["CLOSED", "CANCELLED", "LOST"];

/** "Trip" states reachable from ANY non-terminal state, regardless of the forward map — the deliberate
 *  off-path exits (an event is called off, or a quote is lost). Mirrors improvement-machine's TRIP_STATES. */
const TRIP_STATES: LifecycleState[] = ["CANCELLED", "LOST"];

// The forward happy-path transitions out of each state — exactly one step forward, no skips. Trip edges
// are NOT listed here; they are granted by canTransition from any non-terminal state (see below).
const TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  OPPORTUNITY: ["QUOTED"],
  QUOTED: ["BOOKED"],
  BOOKED: ["PLANNING"],
  PLANNING: ["READY"],
  READY: ["DISPATCHED"],
  DISPATCHED: ["SETUP"],
  SETUP: ["LIVE"],
  LIVE: ["PICKUP"],
  PICKUP: ["CLOSEOUT"],
  CLOSEOUT: ["CLOSED"],
  CLOSED: [], //      terminal (happy-path end)
  CANCELLED: [], //   terminal (trip end)
  LOST: [], //        terminal (trip end)
};

/** Is this a terminal state (no transition out possible)? PURE. */
export function isTerminal(state: LifecycleState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Is `to` a legal transition from `from`? PURE.
 *  - no self-transition,
 *  - nothing leaves a terminal state,
 *  - a trip to CANCELLED/LOST is legal from ANY non-terminal state,
 *  - otherwise only the single forward step in the transition map is allowed (no skipping).
 */
export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  if (from === to) return false;
  if (isTerminal(from)) return false;
  if (TRIP_STATES.includes(to)) return true;
  return TRANSITIONS[from].includes(to);
}

/** Every legal next state from `from` (the forward step plus the always-available trips), or [] when
 *  terminal. PURE. */
export function nextStates(from: LifecycleState): LifecycleState[] {
  if (isTerminal(from)) return [];
  const forward = TRANSITIONS[from];
  const trips = TRIP_STATES.filter((t) => t !== from);
  return [...forward, ...trips];
}

/** Guarded transition: the new state for a legal move, or an error for an illegal one. PURE. This is the
 *  only sanctioned way a future write may change state. */
export function transition(
  from: LifecycleState,
  to: LifecycleState,
): { ok: true; state: LifecycleState } | { ok: false; error: string } {
  if (canTransition(from, to)) return { ok: true, state: to };
  return { ok: false, error: `illegal transition ${from} -> ${to}` };
}

/** The happy-path order index of a state (0-based along LIFECYCLE_ORDER), or -1 for the off-path trip
 *  states CANCELLED/LOST. PURE. */
export function lifecycleIndex(state: LifecycleState): number {
  return LIFECYCLE_ORDER.indexOf(state);
}

/** Compare two states by happy-path order: negative if `a` is earlier, positive if later, 0 if equal.
 *  Trip states (index -1) sort before the whole happy path — they are not comparable progress, so callers
 *  that care should branch on isTerminal/trip first. PURE. */
export function compareLifecycle(a: LifecycleState, b: LifecycleState): number {
  return lifecycleIndex(a) - lifecycleIndex(b);
}

/** Narrowing guard: whether an arbitrary value is a known LifecycleState. PURE. */
export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === "string" && (value in TRANSITIONS);
}

// Self-Improvement Controller — the state machine. This is the heart of "RULES CONTROL EXECUTION": the set
// of LEGAL transitions is fixed here, in code, and the controller is the only thing allowed to move a run
// between states. The AI never decides a transition. PURE (no DB, no IO) — fully unit-tested.

import { type RunState, TERMINAL_RUN_STATES, FAILURE_RUN_STATES } from "./types";

// The happy-path + normal failure transitions out of each state.
const TRANSITIONS: Record<RunState, RunState[]> = {
  requested: ["investigating"],
  investigating: ["planned"],
  planned: ["coding"],
  coding: ["validating"],
  validating: ["pr_created", "validation_failed"],
  validation_failed: ["coding"], //          bounded self-repair (controller checks the retry budget first)
  pr_created: ["ci_running"],
  ci_running: ["ready_to_merge", "ci_failed"],
  ci_failed: ["coding"], //                   bounded self-repair
  ready_to_merge: ["merged"], //              merge only when the controller confirms all gates are green
  merged: ["deploying"],
  deploying: ["deployed", "deployment_failed"],
  deployed: ["verifying"],
  verifying: ["verified", "health_check_failed"],
  verified: [], //                            terminal success
  deployment_failed: ["rollback_required"],
  health_check_failed: ["rollback_required"],
  rollback_required: ["rolled_back"],
  rolled_back: [], //                         terminal
  scope_exceeded: ["human_review_required"], //  stopped — escalate to a human
  session_failed: ["human_review_required"], //  stopped — escalate to a human
  human_review_required: ["investigating", "planned", "coding", "validating", "ready_to_merge", "rollback_required", "rolled_back"],
};

// "Trip" states the CONTROLLER may force from ANY live state, regardless of the normal map: an unexpected
// error (session_failed), a scope/budget breach (scope_exceeded), or a deliberate stop for a human
// (human_review_required). These are safety exits — always reachable while a run is live.
const TRIP_STATES: RunState[] = ["session_failed", "scope_exceeded", "human_review_required"];

// Fully terminal: no transition out at all.
const FULLY_TERMINAL: RunState[] = ["verified", "rolled_back"];

// Hold states: the run has STOPPED and is waiting on a human. They move only via their explicit map edges
// (a human escalation/resume) — never a free safety trip (they are already a safety stop).
const HOLD_STATES: RunState[] = ["scope_exceeded", "session_failed", "human_review_required"];

/** Is this a terminal state (no autonomous progress possible)? PURE. */
export function isTerminal(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

/** Is this a failure/hold state? PURE. */
export function isFailure(state: RunState): boolean {
  return FAILURE_RUN_STATES.includes(state);
}

/** Does this state require a human before anything else happens? PURE. */
export function needsHuman(state: RunState): boolean {
  return state === "human_review_required";
}

/** Is `to` a legal transition from `from`? A trip to a safety-exit state is legal from any non-terminal
 *  state; otherwise only the states listed in the transition map are allowed. PURE. */
export function canTransition(from: RunState, to: RunState): boolean {
  if (from === to) return false;
  if (FULLY_TERMINAL.includes(from)) return false;
  // Hold states (already stopped for a human) move only via their explicit map edges — no free trips.
  if (HOLD_STATES.includes(from)) return TRANSITIONS[from].includes(to);
  // Any other live state can always take a safety trip, or follow its normal map edges.
  if (TRIP_STATES.includes(to)) return true;
  return TRANSITIONS[from].includes(to);
}

/** The single happy-path next state (the first non-failure target), or null if none/terminal. PURE. */
export function nextOnSuccess(from: RunState): RunState | null {
  const outs = TRANSITIONS[from] ?? [];
  const happy = outs.find((s) => !isFailure(s));
  return happy ?? null;
}

/** The normal failure target out of a state (e.g. validating→validation_failed), or null. PURE. */
export function failureTarget(from: RunState): RunState | null {
  const outs = TRANSITIONS[from] ?? [];
  return outs.find((s) => isFailure(s)) ?? null;
}

/** Guarded transition: returns the new state or an error if the transition is illegal. PURE. */
export function transition(from: RunState, to: RunState): { ok: true; state: RunState } | { ok: false; error: string } {
  if (canTransition(from, to)) return { ok: true, state: to };
  return { ok: false, error: `illegal transition ${from} -> ${to}` };
}

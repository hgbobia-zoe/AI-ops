// Event Lifecycle DERIVATION — the pure function that computes the CURRENT lifecycle state of an Event
// from FACTS. Modeled on src/lib/scheduling/lifecycle.ts (deriveShiftLifecycle) and src/lib/salesos/
// state.ts (deterministicState): the state is ALWAYS a deterministic roll-up of the facts, FACT always
// wins, and we never fabricate a state the data can't justify.
//
// Governing law: RULES CALCULATE, AI INTERPRETS. This core is PURE (no DB/net/AI). It reads the typed
// EventView (Phase 1's read-model) plus a small, optional bag of extra deterministic facts the CALLER
// resolves (so the pure core stays free of DB calls — the P1 "compose, don't duplicate" rule). It returns
// the state, the `reasons[]` that cite which facts drove it, and the raw `signals` so a later AI layer can
// EXPLAIN the state without re-deriving it (and never assert a state the engine didn't compute).
//
// Reused, not re-derived:
//   • Commercial stage (OPPORTUNITY/QUOTED/BOOKED + the lost/cancelled signal) comes from
//     `deterministicState` in src/lib/salesos/state.ts — the existing FACT-wins customer-state resolver.
//     We do not re-implement the signed/quote/lost logic here; we map its output to lifecycle states.
//   • Logistics phase comes from the EventView logistics slice's stop states (StopState, the dispatch
//     grain from src/lib/stateMachine.ts) — the same stop states the tablet/dispatch already drive.

import { deterministicState, type StateFacts } from "@/lib/salesos/state";
import type { RouteStatus, StopState } from "@/lib/types";
import type { EventView, LogisticsStop } from "./types";
import { isLifecycleState, type LifecycleState } from "./machine";

/** Extra deterministic facts the caller may resolve and pass in (the pure core never reads a DB). All
 *  optional — the derivation is total without them; they only refine/confirm what the EventView implies. */
export interface LifecycleFacts {
  /** Days since the last customer touch — forwarded to the salesos resolver (affects QUOTED vs DORMANT,
   *  both of which map to the QUOTED lifecycle state; never changes lifecycle on its own). */
  daysSinceLastActivity?: number | null;
  /** The primary route's status (routes.status), when the caller resolved it. "active" confirms the truck
   *  is dispatched even before a stop flips off Waiting; "done" corroborates closeout. */
  routeStatus?: RouteStatus | null;
  /** The postevent engine's verdict that the whole event (incl. follow-up) is fully closed. When true it
   *  forces CLOSED. P2 never calls the postevent engine itself — a caller may pass this if it has it. */
  posteventClosed?: boolean;
}

/** The raw boolean/enum signals the derivation computed — surfaced so an AI layer can explain the state
 *  by citing facts, without re-deriving anything. */
export interface LifecycleSignals {
  commercial: {
    present: boolean;
    signed: boolean;
    quoteSent: boolean;
    statusLabel: string | null;
    /** Goodshuffle marks this lost/cancelled/dead (the salesos resolver returned LOST). */
    lostOrCancelled: boolean;
    cancelled: boolean;
    lost: boolean;
    /** The commercial lifecycle tier the salesos resolver mapped to: OPPORTUNITY | QUOTED | BOOKED. */
    commercialState: Extract<LifecycleState, "OPPORTUNITY" | "QUOTED" | "BOOKED">;
  };
  logistics: {
    present: boolean;
    stopCount: number;
    /** A truck is on the move / a stop has left Waiting, or the route status is "active". */
    anyDispatched: boolean;
    /** The delivery/setup leg is on-site (Arrived) but not yet completed. */
    deliveryArrived: boolean;
    /** The delivery/setup leg is completed (items dropped, event can go live). */
    deliveryCompleted: boolean;
    /** The pickup/teardown leg has begun (en route, arrived, or heading back with the load). */
    pickupStarted: boolean;
    /** The pickup/teardown leg is completed/returned. */
    pickupCompleted: boolean;
    /** The derived logistics phase, or null when there is no dispatch activity yet. */
    phase: Extract<LifecycleState, "DISPATCHED" | "SETUP" | "LIVE" | "PICKUP"> | null;
  };
  outcome: {
    present: boolean;
    allCompleted: boolean;
    posteventClosed: boolean;
  };
}

export interface LifecycleDerivation {
  state: LifecycleState;
  /** FACT/INFERENCE-labelled explanations, each citing the fact(s) that drove the state. */
  reasons: string[];
  signals: LifecycleSignals;
}

// StopState groupings (from src/lib/stateMachine.ts). A stop that has left Waiting is "in motion".
const DISPATCHED_FROM_WAITING: ReadonlySet<StopState> = new Set<StopState>([
  "EnRoute",
  "Arrived",
  "Completed",
  "Exception",
  "HeadingBack",
  "Returned",
]);
const COMPLETED_STATES: ReadonlySet<StopState> = new Set<StopState>(["Completed", "Returned"]);
const PICKUP_IN_MOTION: ReadonlySet<StopState> = new Set<StopState>([
  "EnRoute",
  "Arrived",
  "HeadingBack",
]);

/** Pick the representative stop of a kind (lowest sequence). Returns null when the event has none of that
 *  kind. When no stop carries an explicit kind, callers fall back to the whole-stop aggregate below. */
function stopOfKind(stops: LogisticsStop[], kind: "delivery" | "pickup"): LogisticsStop | null {
  const matches = stops.filter((s) => s.kind === kind).sort((a, b) => a.sequence - b.sequence);
  return matches[0] ?? null;
}

/**
 * Compute the current whole-event lifecycle state from the EventView (plus optional caller facts),
 * deterministically. FACT wins: a Goodshuffle lost/cancelled marking trumps everything; a state is only
 * returned when the facts justify it (a booking with no routes is BOOKED/PLANNING, never LIVE).
 *
 * Honesty notes:
 *  - READY is a Phase-2 PLACEHOLDER. There is no readiness engine yet, so this function never emits READY
 *    (it would be fabricating "this event is ready"). The pre-dispatch ceiling is PLANNING; READY is left
 *    to be gated by the Phase-3 readiness engine. PLANNING therefore covers "booked and being worked, not
 *    yet dispatched."
 *  - The logistics slice is the PRIMARY route only (P1 boundary: `primaryRouteOnly`); multi-route rollup
 *    is a later phase. The phase derived here reflects that primary route's stops.
 *  - Any fact the EventView could not supply stays absent and never invents a forward state.
 */
export function deriveLifecycle(view: EventView, facts: LifecycleFacts = {}): LifecycleDerivation {
  const reasons: string[] = [];
  const c = view.commercial;

  // ── Commercial tier via the existing salesos FACT-wins resolver (no re-derivation here) ──────────
  const stateFacts: StateFacts = {
    signed: c.signed === true,
    statusLabel: c.statusLabel,
    everSent: c.quoteSentAt != null,
    daysSinceLastActivity: facts.daysSinceLastActivity ?? null,
  };
  const commercial = deterministicState(stateFacts);

  const lostOrCancelled = commercial.state === "LOST";
  // Distinguish the two trip states deterministically: a signed/booked event that ends is a CANCELLATION;
  // an explicit "cancel" marking is a CANCELLED; anything else lost/dead is a LOST (quote never booked).
  const cancelled = lostOrCancelled && (stateFacts.signed || /cancel/i.test(c.statusLabel ?? ""));
  const lost = lostOrCancelled && !cancelled;

  // Map the salesos customer-state to the commercial lifecycle tier (OPPORTUNITY/QUOTED/BOOKED).
  const commercialState: LifecycleSignals["commercial"]["commercialState"] =
    commercial.state === "WON" ? "BOOKED" : commercial.state === "NEW" ? "OPPORTUNITY" : "QUOTED";

  // ── Logistics signals from the primary route's stops (dispatch grain) ────────────────────────────
  const stops = view.logistics.stops;
  const routeActive = facts.routeStatus === "active";
  const anyDispatched = routeActive || stops.some((s) => DISPATCHED_FROM_WAITING.has(s.state));

  const delivery = stopOfKind(stops, "delivery");
  const pickup = stopOfKind(stops, "pickup");

  // When stops carry an explicit kind we read the two legs directly; otherwise we fall back to the whole-
  // stop aggregate (any-completed / any-in-motion) so an un-kinded route still derives honestly.
  const haveKinds = delivery != null || pickup != null;
  const deliveryArrived = haveKinds ? delivery?.state === "Arrived" : stops.some((s) => s.state === "Arrived");
  const deliveryCompleted = haveKinds
    ? delivery != null && COMPLETED_STATES.has(delivery.state)
    : stops.length > 0 && stops.some((s) => COMPLETED_STATES.has(s.state));
  const pickupStarted = pickup != null && PICKUP_IN_MOTION.has(pickup.state);
  const pickupCompleted = pickup != null && COMPLETED_STATES.has(pickup.state);

  // Furthest-along logistics phase wins: PICKUP > LIVE > SETUP > DISPATCHED.
  let phase: LifecycleSignals["logistics"]["phase"] = null;
  if (pickupStarted || pickupCompleted) phase = "PICKUP";
  else if (deliveryCompleted) phase = "LIVE";
  else if (deliveryArrived) phase = "SETUP";
  else if (anyDispatched) phase = "DISPATCHED";

  // ── Outcome / closeout facts (latest-stage; corroborated by postevent if the caller passed it) ───
  const posteventClosed = facts.posteventClosed === true;
  const outcomePresent = view.outcome.present;
  const allCompleted = view.outcome.allCompleted === true;

  const signals: LifecycleSignals = {
    commercial: {
      present: c.present,
      signed: stateFacts.signed,
      quoteSent: stateFacts.everSent,
      statusLabel: c.statusLabel,
      lostOrCancelled,
      cancelled,
      lost,
      commercialState,
    },
    logistics: {
      present: view.logistics.present,
      stopCount: stops.length,
      anyDispatched,
      deliveryArrived: deliveryArrived === true,
      deliveryCompleted: deliveryCompleted === true,
      pickupStarted,
      pickupCompleted,
      phase,
    },
    outcome: { present: outcomePresent, allCompleted, posteventClosed },
  };

  // ── Resolve the state, FACT wins, in strict precedence ───────────────────────────────────────────
  const state = resolveState(signals, reasons);

  // Total-function guarantee: the derivation must only ever return a state the machine recognizes.
  if (!isLifecycleState(state)) {
    // Unreachable by construction (resolveState only returns LifecycleState literals); defensive.
    return { state: "OPPORTUNITY", reasons: ["FACT: no facts available — defaulting to OPPORTUNITY."], signals };
  }
  return { state, reasons, signals };
}

/** The strict precedence resolver. Returns a LifecycleState literal (TS guarantees the union), pushing a
 *  FACT-labelled reason for each decision. */
function resolveState(signals: LifecycleSignals, reasons: string[]): LifecycleState {
  const { commercial, logistics, outcome } = signals;

  // 1) Trip states — FACT wins over everything (an event called off / a lost quote is nothing else).
  if (commercial.cancelled) {
    reasons.push(`FACT: Goodshuffle marks this lost/cancelled ("${commercial.statusLabel ?? ""}") and the contract was booked -> CANCELLED.`);
    return "CANCELLED";
  }
  if (commercial.lost) {
    reasons.push(`FACT: Goodshuffle marks this lost/dead ("${commercial.statusLabel ?? ""}") and it never booked -> LOST.`);
    return "LOST";
  }

  // 2) Not yet booked -> the event is still a commercial record; it cannot honestly be dispatched/live.
  if (commercial.commercialState !== "BOOKED") {
    if (commercial.commercialState === "OPPORTUNITY") {
      reasons.push("FACT: no quote sent to the client yet -> OPPORTUNITY.");
    } else {
      reasons.push("FACT: quote sent, contract not signed -> QUOTED.");
    }
    return commercial.commercialState;
  }

  // From here on the contract is signed (BOOKED). Later stages require this FACT.
  reasons.push("FACT: contract is signed in Goodshuffle -> booked.");

  // 3) Closeout / closed — latest stage, corroborated by the outcome row (route closed) / postevent.
  if (outcome.posteventClosed) {
    reasons.push("FACT: postevent engine reports the event fully closed -> CLOSED.");
    return "CLOSED";
  }
  if (outcome.present) {
    if (outcome.allCompleted) {
      reasons.push("FACT: route closed with every stop completed (event_outcomes) -> CLOSED.");
      return "CLOSED";
    }
    reasons.push("FACT: route closed but not every stop completed (event_outcomes) -> CLOSEOUT.");
    return "CLOSEOUT";
  }

  // 4) Logistics phase from the primary route's stops.
  if (logistics.phase === "PICKUP") {
    reasons.push("FACT: pickup/teardown leg is in motion or done -> PICKUP.");
    return "PICKUP";
  }
  if (logistics.phase === "LIVE") {
    reasons.push("FACT: delivery/setup leg completed, event is live, pickup not started -> LIVE.");
    return "LIVE";
  }
  if (logistics.phase === "SETUP") {
    reasons.push("FACT: delivery/setup crew is on-site (stop Arrived) -> SETUP.");
    return "SETUP";
  }
  if (logistics.phase === "DISPATCHED") {
    reasons.push("FACT: a truck/stop has left the warehouse (or route active) -> DISPATCHED.");
    return "DISPATCHED";
  }

  // 5) Booked, not yet dispatched. READY is deferred to the Phase-3 readiness engine (we never fabricate
  //    readiness), so the pre-dispatch ceiling is PLANNING when a route exists, else plain BOOKED.
  if (logistics.present && logistics.stopCount > 0) {
    reasons.push("FACT: booked with a route planned but not yet dispatched (all stops Waiting) -> PLANNING. (READY is gated by the Phase-3 readiness engine.)");
    return "PLANNING";
  }
  reasons.push("FACT: booked, no route planned yet -> BOOKED.");
  return "BOOKED";
}

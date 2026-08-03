// ─────────────────────────────────────────────────────────────────────────────
// State machine — the single source of truth for legal stop transitions.
//
// This same definition drives BOTH:
//   1. the tablet UI (which buttons to render for the current state), and
//   2. the intake validator in app/api/action (what transitions are accepted).
//
// It is mirrored into the Zapier `Transitions` table (see zapier/transitions.seed.json
// generated from TRANSITIONS below) so the no-code Zaps validate against the exact
// same rules. Change it here, regenerate the seed, re-import to Zapier.
// ─────────────────────────────────────────────────────────────────────────────

import type { ActionType, StopState } from "./types";

export type ButtonVariant = "default" | "destructive" | "secondary";

export interface TransitionDef {
  from: StopState;
  action: ActionType;
  to: StopState;
  /** Default button label. Some labels are contextual (see getAvailableActions). */
  label: string;
  /** Guarded transition — hidden on the tablet, requires supervisor/admin. */
  requiresApproval?: boolean;
  /** Must pass the pre-departure checklist before firing. */
  requiresChecklist?: boolean;
  /** Only valid when this is the last stop of the route. */
  lastStopOnly?: boolean;
  /** Only valid when this is NOT the last stop. */
  notLastStop?: boolean;
  variant?: ButtonVariant;
}

export const ALL_STATES: StopState[] = [
  "Waiting",
  "EnRoute",
  "Arrived",
  "DeliveryInProgress",
  "Completed",
  "Exception",
  "HeadingBack",
  "Returned",
];

// The complete transition table. Order matters only for display.
export const TRANSITIONS: TransitionDef[] = [
  // Depart to the first stop.
  {
    from: "Waiting",
    action: "LEAVING_WAREHOUSE",
    to: "EnRoute",
    label: "Leaving Warehouse",
  },
  // Arrive at the current stop.
  { from: "EnRoute", action: "ARRIVED", to: "Arrived", label: "Arrived" },
  // Begin the delivery.
  {
    from: "Arrived",
    action: "START_DELIVERY",
    to: "DeliveryInProgress",
    label: "Start Delivery",
  },
  // Complete this stop and head to the next (checklist gate). Backend moves the
  // next stop to EnRoute and sends its SMS.
  {
    from: "DeliveryInProgress",
    action: "HEADING_NEXT",
    to: "Completed",
    label: "Heading To Next Customer",
    requiresChecklist: true,
    notLastStop: true,
  },
  // Complete the final stop and start heading back to the warehouse.
  {
    from: "DeliveryInProgress",
    action: "COMPLETE_AND_RETURN",
    to: "Completed",
    label: "Complete & Head Back",
    requiresChecklist: true,
    lastStopOnly: true,
  },
  // Truck arrived back at the warehouse — route done.
  {
    from: "HeadingBack",
    action: "ARRIVED_WAREHOUSE",
    to: "Returned",
    label: "Arrived at Warehouse",
  },

  // Exceptions can be raised from any active state.
  {
    from: "Waiting",
    action: "REPORT_EXCEPTION",
    to: "Exception",
    label: "Report Exception",
    variant: "destructive",
  },
  {
    from: "EnRoute",
    action: "REPORT_EXCEPTION",
    to: "Exception",
    label: "Report Exception",
    variant: "destructive",
  },
  {
    from: "Arrived",
    action: "REPORT_EXCEPTION",
    to: "Exception",
    label: "Report Exception",
    variant: "destructive",
  },
  {
    from: "DeliveryInProgress",
    action: "REPORT_EXCEPTION",
    to: "Exception",
    label: "Report Exception",
    variant: "destructive",
  },

  // Resolving an exception.
  {
    from: "Exception",
    action: "RESOLVE_CONTINUE",
    to: "DeliveryInProgress",
    label: "Resolve & Continue",
  },
  {
    from: "Exception",
    action: "RETURN_ITEM",
    to: "HeadingBack",
    label: "Return Item to Warehouse",
    variant: "secondary",
  },

  // Guarded: reopening a completed stop needs supervisor approval (admin only).
  {
    from: "Completed",
    action: "REOPEN",
    to: "EnRoute",
    label: "Reopen Stop (Supervisor)",
    requiresApproval: true,
    variant: "secondary",
  },
];

export interface ActionContext {
  isFirstStop?: boolean;
  isLastStop?: boolean;
  isAdmin?: boolean;
}

/** A concrete, ready-to-render action for the current state + context. */
export interface AvailableAction {
  action: ActionType;
  to: StopState;
  label: string;
  requiresChecklist: boolean;
  variant: ButtonVariant;
}

/**
 * Returns the actions a driver may take from `state`, honoring first/last-stop
 * and admin context. Guarded (requiresApproval) transitions are excluded unless
 * `isAdmin` is set — this is what keeps the tablet from ever showing an illegal
 * or supervisor-only button.
 */
export function getAvailableActions(
  state: StopState,
  ctx: ActionContext = {},
): AvailableAction[] {
  return TRANSITIONS.filter((t) => t.from === state)
    .filter((t) => (t.requiresApproval ? Boolean(ctx.isAdmin) : true))
    .filter((t) => (t.lastStopOnly ? Boolean(ctx.isLastStop) : true))
    .filter((t) => (t.notLastStop ? !ctx.isLastStop : true))
    .map((t) => ({
      action: t.action,
      to: t.to,
      label: labelFor(t, ctx),
      requiresChecklist: Boolean(t.requiresChecklist),
      variant: t.variant ?? "default",
    }));
}

function labelFor(t: TransitionDef, ctx: ActionContext): string {
  if (t.action === "LEAVING_WAREHOUSE" && ctx.isFirstStop === false) {
    return "Head to Customer";
  }
  return t.label;
}

/**
 * Authoritative validity check used by the intake. Returns the resulting state
 * for a legal transition, or null if the (from, action) pair is not allowed.
 * Context is applied so last-stop-only / approval rules are enforced server-side
 * too — the client map is convenience, this is the guard.
 */
export function resolveTransition(
  from: StopState,
  action: ActionType,
  ctx: ActionContext = {},
): StopState | null {
  const match = TRANSITIONS.find((t) => t.from === from && t.action === action);
  if (!match) return null;
  if (match.requiresApproval && !ctx.isAdmin) return null;
  if (match.lastStopOnly && !ctx.isLastStop) return null;
  if (match.notLastStop && ctx.isLastStop) return null;
  return match.to;
}

export function isTerminal(state: StopState): boolean {
  return state === "Returned";
}

/**
 * Side actions are NOT state transitions — they only fan out to Slack/logging
 * (e.g. messaging dispatch, logging fuel). The intake accepts them without a
 * transition check and forwards them for automation.
 */
export const SIDE_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "NOTIFY_DISPATCH",
  "GAS_LOG",
]);

export function isSideAction(action: ActionType): boolean {
  return SIDE_ACTIONS.has(action);
}

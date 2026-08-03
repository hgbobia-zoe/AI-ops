// What each action triggers in the backend. This is the single source for:
//   - the action "receipt" shown after a tap, and
//   - the per-stop notification-status card.
// It mirrors the Zapier fan-out design (see SETUP.md) so the tablet's picture of
// "what happened" matches what the Zaps actually do.

import type { ActionType } from "./types";

export const AUTOMATIONS: Partial<Record<ActionType, string[]>> = {
  LEAVING_WAREHOUSE: [
    "Customer texted — on the way",
    "Live tracking link sent",
    "Dispatch notified — departed",
  ],
  ARRIVED: ["Customer texted — arrived", "Dispatch notified — arrived"],
  START_DELIVERY: ["Delivery started — logged"],
  HEADING_NEXT: [
    "Stop marked complete",
    "Next customer texted — on the way",
    "ETA recalculated",
  ],
  COMPLETE_AND_RETURN: ["Final stop complete", "Dispatch notified — heading back"],
  ARRIVED_WAREHOUSE: ["Route complete", "Dispatch notified"],
  REPORT_EXCEPTION: ["Dispatch alerted on Slack", "Exception logged + audited"],
  RESOLVE_CONTINUE: ["Exception resolved — logged"],
  RETURN_ITEM: ["Return logged", "Dispatch notified"],
  NOTIFY_DISPATCH: ["Message delivered to dispatch on Slack"],
  GAS_LOG: ["Fuel status logged for the truck"],
};

/** The list of backend automations an action kicks off (may be empty). */
export function automationsFor(action: ActionType): string[] {
  return AUTOMATIONS[action] ?? [];
}

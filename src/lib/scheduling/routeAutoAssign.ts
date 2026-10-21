// Connecteam → ROUTE auto-assign DECISION (pure). Turns the scheduledUnrouted detector's output into a
// per-person verdict: AUTO-ASSIGN to a route when the match is UNAMBIGUOUS, else leave it for the existing
// one-click prompt. This is the "automatic, not just prompted" behavior the user asked for — but only when
// it is safe to decide without a human, so we never guess the wrong route.
//
// DESIGN LAW (unchanged from scheduledUnrouted.ts / preCheck.ts): a Connecteam work shift is NOT route
// coverage. Auto-assign doesn't credit the schedule — it performs a REAL app assignment through the same
// path the dispatcher's one-click uses (see routeAutoSync.ts applyRouteAutoAssign), so the staffing gate
// clears honestly because an actual assignment now exists. Prep that isn't route-tied never reaches here:
// the detector only surfaces people with a fillable ROUTE seat (driver/field).
//
// UNAMBIGUOUS = exactly ONE eligible route. The detector already filtered to routes with a real gap in the
// person's seat AND a compatible window; if only one such route exists, there is nothing to guess. When two
// or more routes fit (e.g. a field helper who could join either truck, or a driver whose unset window
// overlaps several), the choice is genuinely a human's — we fall back to the prompt rather than pick wrong.

import type { ScheduledUnroutedResult, ScheduledUnroutedPerson } from "./scheduledUnrouted";
import type { RouteCrewRole } from "./preCheck";

/**
 * Whether the AUTO path may SILENTLY place this scheduled person on a delivery route without a human. Keys
 * on the TITLE-derived `routeEligible` signal computed at classification time (connecteam.routeEligibleFromTitle):
 * a DRIVER or a WAREHOUSE associate (warehouse helps deliver on the ground) → eligible; an ASSET-PREP /
 * back-of-warehouse worker ("Event Asset Processor"), office/"other", or an untitled worker → NOT eligible.
 * It keys on `routeEligible` rather than the coarse `role` because warehouse and asset-prep share role "prep"
 * (both load trucks, so "prep" must stay a single loading-coverage bucket) — only the title tells them apart.
 * A route-ineligible prep worker is still surfaced to the dispatcher's one-click PROMPT (manual is untouched);
 * only the automatic path excludes them. Honest default: an unproven/untitled worker is never auto-routed.
 */
export function isAutoRouteEligible(person: Pick<ScheduledUnroutedPerson, "routeEligible">): boolean {
  return person.routeEligible === true;
}

/** One person the engine will AUTO-ASSIGN to a specific route (unambiguous match). */
export interface AutoAssignDecision {
  userId: number;
  name: string;
  routeId: string;
  fillRole: RouteCrewRole;
  /** Deterministic, human-free facts behind the decision (for audit / narration). */
  reasons: string[];
}

/** One person left for the existing one-click prompt (ambiguous — more than one route fits). */
export interface PromptDecision {
  userId: number;
  name: string;
  fillRole: RouteCrewRole;
  suggestedRouteId: string | null;
  eligibleRouteIds: string[];
  reason: string;
}

export interface RouteAutoAssignPlan {
  /** False → Connecteam was unreachable; the plan is empty (honest unknown, never a fabricated "nobody"). */
  reachable: boolean;
  autoAssign: AutoAssignDecision[];
  prompt: PromptDecision[];
}

/**
 * PURE. Split the scheduled-but-unrouted people into unambiguous auto-assigns vs ambiguous prompts.
 * Connecteam unreachable → empty plan, reachable:false (the caller does nothing).
 */
export function planRouteAutoAssign(result: ScheduledUnroutedResult): RouteAutoAssignPlan {
  if (!result.reachable) return { reachable: false, autoAssign: [], prompt: [] };

  const autoAssign: AutoAssignDecision[] = [];
  const prompt: PromptDecision[] = [];

  for (const p of result.people) {
    // AUTO-path eligibility gate (the fix for a back-of-warehouse worker landing on a delivery route): a
    // DRIVER or WAREHOUSE associate may be auto-routed; an ASSET-PREP / office worker the detector surfaced
    // for the field-helper seat is NEVER auto-assigned — they fall to the prompt so a dispatcher decides
    // deliberately. Keys on the title-derived routeEligible signal (warehouse vs asset share role "prep").
    const autoEligible = isAutoRouteEligible(p);
    const unambiguous = autoEligible && p.eligibleRouteIds.length === 1 && p.suggestedRouteId != null;
    if (unambiguous) {
      autoAssign.push({
        userId: p.userId,
        name: p.name,
        routeId: p.suggestedRouteId!,
        fillRole: p.fillRole,
        reasons: ["exactly one route has an open seat this person fits — unambiguous", ...p.reasons],
      });
    } else {
      prompt.push({
        userId: p.userId,
        name: p.name,
        fillRole: p.fillRole,
        suggestedRouteId: p.suggestedRouteId,
        eligibleRouteIds: p.eligibleRouteIds,
        reason: !autoEligible
          ? `${p.role === "prep" ? "asset-prep (back of warehouse)" : "non-route-eligible"} worker — not auto-routed; a dispatcher assigns route crew manually`
          : p.eligibleRouteIds.length > 1
            ? `fits ${p.eligibleRouteIds.length} routes — ambiguous, a dispatcher picks`
            : "no single unambiguous route — left for the prompt",
      });
    }
  }

  return { reachable: true, autoAssign, prompt };
}

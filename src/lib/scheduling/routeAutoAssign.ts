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

import type { ScheduledUnroutedResult } from "./scheduledUnrouted";
import type { RouteCrewRole } from "./preCheck";

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
    const unambiguous = p.eligibleRouteIds.length === 1 && p.suggestedRouteId != null;
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
        reason:
          p.eligibleRouteIds.length > 1
            ? `fits ${p.eligibleRouteIds.length} routes — ambiguous, a dispatcher picks`
            : "no single unambiguous route — left for the prompt",
      });
    }
  }

  return { reachable: true, autoAssign, prompt };
}

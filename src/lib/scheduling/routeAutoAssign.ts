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
// or more routes fit, the plain verdict here leaves it ambiguous — but a DRIVER who fits several routes is
// then resolved deterministically by seniority routing (driverSeniority.ts), so staggered-time driver gaps
// still get filled. A FIELD helper who fits several routes has no such tiebreak and stays on the prompt.
//
// POLICY NOTE — WAREHOUSE/FIELD CREW ARE NOW AUTO-ROUTED (reverses the earlier #81 exclusion, authorized by
// the owner 2026-10-23). Previously ONLY a genuine driver could be auto-placed; a "prep" (warehouse) worker
// mapped to a field-helper seat was always held for the one-click prompt. The owner's call: if someone is
// scheduled in Connecteam and there is exactly one open route seat they fit, place them — don't nag a human
// to do the obvious. The honesty invariant is untouched (a schedule is still never credited as coverage; a
// REAL assignment is made), and the care is preserved by keeping it to the UNAMBIGUOUS case for field: a
// warehouse worker is auto-placed only when there is a single matching route, never guessed across several.

import type { ScheduledUnroutedResult } from "./scheduledUnrouted";
import type { RouteCrewRole } from "./preCheck";
import type { CrewRole } from "@/lib/connecteam";

/**
 * Which Connecteam crew roles the AUTO path may place on a route without a human. A genuine internal DRIVER
 * fills a driver seat (their actual job) and a "prep" (warehouse / asset-processor) worker fills a
 * field-helper seat — BOTH are auto-route-eligible as of the owner-authorized reversal of the #81 exclusion
 * (see the POLICY NOTE above). Office/admin ("other") is non-crew and is still never eligible, and the
 * detector never surfaces them onto a route anyway (scheduledUnrouted.fillRoleFor → null). Any role we don't
 * positively recognize as driver or prep is treated as NOT auto-eligible (honest: don't guess an unproven
 * worker onto a delivery route). The UNAMBIGUOUS guard in planRouteAutoAssign still bounds this — a prep
 * worker is auto-placed only when exactly one route fits; a multi-route prep stays on the one-click prompt.
 */
export function isAutoRouteEligible(role: CrewRole): boolean {
  return role === "driver" || role === "prep";
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
    // AUTO-path role gate (the fix for a warehouse/prep worker landing on a delivery route): only a genuine
    // driver may be auto-routed. A prep/office worker whom the detector surfaced for the field-helper seat is
    // NEVER auto-assigned — they fall to the prompt so a dispatcher decides deliberately. Manual stays open.
    const autoEligible = isAutoRouteEligible(p.role);
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
          ? "non-crew role — not auto-routed; a dispatcher assigns route crew manually"
          : p.eligibleRouteIds.length > 1
            ? `fits ${p.eligibleRouteIds.length} routes — ambiguous, a dispatcher picks`
            : "no single unambiguous route — left for the prompt",
      });
    }
  }

  return { reachable: true, autoAssign, prompt };
}

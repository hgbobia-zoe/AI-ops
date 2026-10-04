// Scheduling plan VIEW helpers — pure, deterministic surfacing over the engines that already compute the
// facts (optimize.ts / coverage.ts / cost.ts / readiness.ts / exceptions.ts). These add NO new staffing
// decision and reach no integration: they only roll the already-computed numbers into the shapes the
// merged AUTO STAFF board renders (a plan summary, a day-level staffing-health state, and move-to-route
// eligibility labels). RULES CALCULATE; no LLM here.
//
// HONESTY (the house law): an unknown stays null, never fabricated. A health state is derived only from
// facts the engines already gate for verification (exceptions suppress understaffed on an unreachable
// integration; readiness goes UNVERIFIED), so nothing here invents a deficiency.

import type { CrewRole } from "@/lib/connecteam";
import { candidateRoles } from "./availability";
import type { DayCoverage } from "./coverage";
import type { StaffingPlan } from "./optimize";
import type { ShiftReadinessLevel } from "./readiness";
import type { ShiftRole } from "./types";

// ── Plan summary rollup ──────────────────────────────────────────────────────────────────────────
// A single header card above the route grid, built entirely from values the engines already produced.

export interface PlanSummary {
  routes: number; // active route cards on the day
  peopleNeeded: number; // sum of shift headcount
  internalAvailable: number; // people covered internally today (explicit + Connecteam-scheduled) — coverage.internalTotal
  internalAssigned: number; // internal seats the optimizer places in the proposed plan
  staffingGap: number; // proposed plan's temp seats (seats internal cannot cover)
  instaworkRequired: number; // = staffingGap (the gap that falls to Instawork)
  readinessPct: number | null; // mean shift readiness score (0..100), null when there are no shifts
  estInstaworkCost: number | null; // the day's known temp cost (null when unknown — never fabricated)
  tempHoursSaved: number | null; // optimizer's honest saving vs current (null when hours unknown)
}

export function summarizePlan(input: {
  routes: number;
  peopleNeeded: number;
  coverage: Pick<DayCoverage, "internalTotal">;
  plan: StaffingPlan;
  estInstaworkCost: number | null;
  readinessScores: number[];
}): PlanSummary {
  const internalAssigned = input.plan.assignments.filter((a) => a.kind === "internal").length;
  const staffingGap = input.plan.planTempCount;
  const readinessPct =
    input.readinessScores.length > 0
      ? Math.round(input.readinessScores.reduce((n, s) => n + s, 0) / input.readinessScores.length)
      : null;
  return {
    routes: input.routes,
    peopleNeeded: input.peopleNeeded,
    internalAvailable: input.coverage.internalTotal,
    internalAssigned,
    staffingGap,
    instaworkRequired: staffingGap,
    readinessPct,
    estInstaworkCost: input.estInstaworkCost,
    tempHoursSaved: input.plan.tempHoursSaved,
  };
}

// ── Day-level Staffing Health ──────────────────────────────────────────────────────────────────────
// A single deterministic roll-up chip. Worst state wins. Returns null when there is nothing to staff.

export type StaffingHealth =
  | "FULLY_STAFFED" // every needed seat covered internally; no temp needed; no open RED
  | "READY" // fully staffed AND every shift's readiness is READY (published / linked / confirmed)
  | "PARTIALLY_STAFFED" // a gap remains that is not (yet) a RED exception and is not a temp-only gap
  | "INSTAWORK_REQUIRED" // the optimizer exhausted internal crew; temp seats remain to be filled
  | "ACTION_REQUIRED"; // an open RED exception (urgent understaffing near start, no truck, no-show, ...)

export const STAFFING_HEALTH_LABEL: Record<StaffingHealth, string> = {
  FULLY_STAFFED: "Fully staffed",
  READY: "Ready",
  PARTIALLY_STAFFED: "Partially staffed",
  INSTAWORK_REQUIRED: "Instawork required",
  ACTION_REQUIRED: "Action required",
};

/** worst-first deterministic ladder. `redExceptions` is already honesty-gated by the exception scan
 *  (an unreachable integration never raises understaffed), so an unknown never becomes a red here. */
export function computeStaffingHealth(input: {
  hasShifts: boolean;
  redExceptions: number;
  planTempCount: number; // optimizer temp seats (internal could not cover)
  currentGapTotal: number; // coverage gap across all shifts
  readinessLevels: ShiftReadinessLevel[];
}): StaffingHealth | null {
  if (!input.hasShifts) return null;
  if (input.redExceptions > 0) return "ACTION_REQUIRED";
  if (input.planTempCount > 0) return "INSTAWORK_REQUIRED";
  if (input.currentGapTotal > 0) return "PARTIALLY_STAFFED";
  const allReady = input.readinessLevels.length > 0 && input.readinessLevels.every((l) => l === "READY");
  return allReady ? "READY" : "FULLY_STAFFED";
}

// ── Move-to-route eligibility ───────────────────────────────────────────────────────────────────────
// When moving a warehouse/prep person onto a route as a field helper, label each candidate route with the
// SAME deterministic predicates the optimizer uses (candidateRoles + window overlap) — so an invalid
// assignment is shown as such BEFORE it is made, never discovered later.

export type MoveFit = "good-fit" | "exceeds-availability" | "qualification-mismatch";

export interface MoveEligibility {
  fit: MoveFit;
  label: string;
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd && bStart < aEnd;

export function moveEligibility(input: {
  workerRole: CrewRole; // the person's Connecteam role
  targetRole: ShiftRole; // the role they would fill on the route (field for a move)
  routeWindow: { startMs: number; endMs: number } | null; // null = window unknown (can't check overlap)
  workerBusyWindows: Array<[number, number]>; // the worker's Connecteam shifts + existing plan seats that day
}): MoveEligibility {
  if (!candidateRoles(input.targetRole).includes(input.workerRole)) {
    return { fit: "qualification-mismatch", label: "qualification mismatch" };
  }
  if (input.routeWindow) {
    const conflict = input.workerBusyWindows.some(([s, e]) => overlaps(input.routeWindow!.startMs, input.routeWindow!.endMs, s, e));
    if (conflict) return { fit: "exceeds-availability", label: "exceeds availability" };
  }
  return { fit: "good-fit", label: "good fit" };
}

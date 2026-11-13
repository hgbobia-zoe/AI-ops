// Client-safe VIEW helper over the pure eligibility classifier (eligibility.ts). It turns an
// EligibilityResult into a short deterministic label + a tone the board renders, and bundles the raw
// feeds a client panel needs so it can classify a worker for ITS own window (a route card, a shift). No
// server imports (only eligibility.ts + connecteam TYPES, both erased/pure), so "use client" panels can
// import it. RULES CALCULATE: the state is the classifier's; this only formats it.

import { eligibilityFor, type AssignmentWindow, type EligibilityResult } from "./eligibility";
import type { CrewShift, UnavailabilityBlock } from "@/lib/connecteam";
import { unavailabilityLabel } from "./unavailabilityLabel";

/** The day's eligibility ingredients, passed from the server so panels don't re-pull anything. */
export interface WorkerDayEligibilityData {
  /** Connecteam work-schedule shifts for the day (any workers). */
  dayShifts: CrewShift[];
  /** Zoe route assignments across the day (staff_shifts.assignees → windows). */
  assignments: AssignmentWindow[];
  /** Connecteam time-off / unavailability blocks for the day, flat (each carries userId). */
  unavailability: UnavailabilityBlock[];
  /** Did the Connecteam availability feed answer for the day? false → "availability unverified". */
  availabilityKnown: boolean;
}

export type EligibilityTone = "available" | "preferred" | "conflict" | "assigned" | "unavailable" | "unknown";

export interface EligibilityView {
  state: EligibilityResult["state"];
  eligible: boolean;
  preferred: boolean;
  tone: EligibilityTone;
  text: string;
  /** Short badge for the worker pickers. For UNAVAILABLE it carries the hours ("unavailable until 2:00 PM"),
   *  so a partial block never reads as the whole day. */
  badge: string;
}

/** The ops timezone to render block/schedule windows in (Connecteam carries it per shift). */
export function dayTz(data: WorkerDayEligibilityData): string {
  return data.dayShifts[0]?.timezone || "America/New_York";
}

/** Classify one worker for a given candidate window, from the day data. Pure passthrough to eligibilityFor. */
export function classifyWorkerFor(
  data: WorkerDayEligibilityData,
  userId: number,
  routeWindow: { start: number; end: number } | null,
  thisShiftId?: string,
): EligibilityResult {
  return eligibilityFor({
    userId,
    routeWindow,
    dayShifts: data.dayShifts,
    assignments: data.assignments,
    unavailability: data.unavailability.filter((b) => b.userId === userId),
    availabilityKnown: data.availabilityKnown,
    thisShiftId,
  });
}

function clock(unix: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(unix * 1000));
}

/** Format the classifier's result into the board's short label + tone. */
export function eligibilityView(elig: EligibilityResult, tz: string): EligibilityView {
  const unver = elig.availabilityKnown ? "" : " · availability unverified";
  const base = { state: elig.state, eligible: elig.eligible, preferred: elig.preferred, badge: elig.state.replace("_", " ").toLowerCase() };

  switch (elig.state) {
    case "UNAVAILABLE": {
      if (!elig.block) return { ...base, tone: "unavailable", text: "Unavailable" };
      const b = { kind: elig.block.kind, startUnix: elig.block.start, endUnix: elig.block.end };
      const text = unavailabilityLabel({ ...b, reason: elig.block.reason }, { tz });
      const short = unavailabilityLabel(b, { tz });
      return { ...base, tone: "unavailable", text, badge: short.charAt(0).toLowerCase() + short.slice(1) };
    }
    case "ASSIGNED":
      return { ...base, tone: "assigned", text: `On another route this window${unver}` };
    case "SCHEDULED_UNASSIGNED": {
      const win = elig.scheduleWindow ? ` ${clock(elig.scheduleWindow.start, tz)} to ${clock(elig.scheduleWindow.end, tz)}` : "";
      return { ...base, tone: "preferred", text: `On the schedule${win}, not yet on a route${unver}` };
    }
    case "SCHEDULE_CONFLICT": {
      const win = elig.scheduleWindow ? ` ${clock(elig.scheduleWindow.start, tz)} to ${clock(elig.scheduleWindow.end, tz)}` : "";
      return { ...base, tone: "conflict", text: `Scheduled${win}, does not fully cover this route${unver}` };
    }
    default:
      return { ...base, tone: elig.availabilityKnown ? "available" : "unknown", text: `Free this window${unver}` };
  }
}

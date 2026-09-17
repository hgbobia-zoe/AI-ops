// Event Radar — outreach timing engine. PURE and deterministic. Answers "when should Zoe engage?" from
// the event date, size, category and recurrence — NOT from a procurement deadline we don't have. The
// output is always honest: inferredFromDateOnly=true says the recommendation rests on the calendar
// alone, because we have no verified procurement signal.

import { DEFAULT_RADAR_CONFIG, type RadarConfig } from "./config";
import type { EventCategory, TimingView } from "./types";

export interface TimingInput {
  startDate: string | null; // YYYY-MM-DD
  category: EventCategory;
  expectedAttendance: number | null;
  recurring: boolean;
  today: string; // YYYY-MM-DD
  /** True when a real procurement signal exists (an RFP, a stated deadline). MVP: always false — we
   *  never pretend to know the organizer's actual deadline. */
  hasProcurementSignal?: boolean;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Large / recurring / gala-class events warrant earlier engagement — they lock vendors sooner. */
function windowLabel(input: TimingInput): string {
  const big = (input.expectedAttendance ?? 0) >= 750;
  const earlyCategory: EventCategory[] = ["CONFERENCE", "TRADE_SHOW", "EXPO", "GALA", "MEDICAL"];
  if (big || input.recurring || earlyCategory.includes(input.category)) return "6–9 months before";
  return "4–6 months before";
}

export function deriveTiming(input: TimingInput, config: RadarConfig = DEFAULT_RADAR_CONFIG): TimingView {
  const window = windowLabel(input);
  if (!input.startDate) {
    return {
      phase: "DATE_UNKNOWN",
      status: "Date unknown",
      recommendedAction: "Confirm the event date before planning outreach",
      outreachWindow: window,
      daysToEvent: null,
      inferredFromDateOnly: false,
    };
  }

  const d = daysBetween(input.today, input.startDate);
  const t = config.timing;
  const inferred = !input.hasProcurementSignal;

  if (d < 0) {
    return { phase: "PAST", status: "Event has passed", recommendedAction: "Log outcome; watch for the next in the series", outreachWindow: window, daysToEvent: d, inferredFromDateOnly: inferred };
  }
  if (d <= t.imminentDays) {
    return { phase: "IMMINENT", status: "Imminent", recommendedAction: "Vendors are locked — engage only for last-minute needs", outreachWindow: window, daysToEvent: d, inferredFromDateOnly: inferred };
  }
  if (d <= t.activelyShoppingDays) {
    return { phase: "ACTIVELY_SHOPPING", status: "Likely shopping vendors", recommendedAction: "Reach out now — the planner is likely selecting vendors", outreachWindow: window, daysToEvent: d, inferredFromDateOnly: inferred };
  }
  if (d <= t.outreachWindowStartDays) {
    return { phase: "OUTREACH_WINDOW", status: "Outreach window", recommendedAction: "Begin relationship outreach", outreachWindow: window, daysToEvent: d, inferredFromDateOnly: inferred };
  }
  if (d <= t.planningWindowStartDays) {
    return { phase: "PLANNING_WINDOW", status: "Planning window", recommendedAction: "Identify the organizer and warm up the relationship early", outreachWindow: window, daysToEvent: d, inferredFromDateOnly: inferred };
  }
  return { phase: "TOO_EARLY", status: "Too early", recommendedAction: "Monitor — set a reminder for the outreach window", outreachWindow: window, daysToEvent: d, inferredFromDateOnly: inferred };
}

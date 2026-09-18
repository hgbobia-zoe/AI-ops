// Opportunity Radar — signal maturity engine (§5). PURE and deterministic. Turns the event/project
// date (and any procurement deadline) into a maturity phase + a plain headline, so Zoe engages early
// enough to build the relationship rather than waiting until an event is obvious.

import { DEFAULT_OPPORTUNITY_CONFIG, type OpportunityConfig } from "./config";
import { MATURITY_LABEL, type MaturityView, type SignalMaturity } from "./types";

export interface MaturityInput {
  estimatedDate: string | null; // YYYY-MM-DD
  deadline: string | null; // YYYY-MM-DD procurement response deadline
  today: string; // YYYY-MM-DD
  hasProcurementSignal?: boolean; // a real deadline/RFP exists
}

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}

const HEADLINE: Record<SignalMaturity, string> = {
  EARLY_SIGNAL: "Potential opportunity detected",
  PLANNING: "Planning activity detected",
  PROCUREMENT_WINDOW: "Procurement / venue activity likely",
  OPERATIONALLY_ACTIVE: "Event appears operationally active",
  IMMEDIATE: "Immediate sales opportunity",
  PAST: "Date has passed",
  DATE_UNKNOWN: "Date not yet known",
};

export function deriveMaturity(input: MaturityInput, config: OpportunityConfig = DEFAULT_OPPORTUNITY_CONFIG): MaturityView {
  const m = config.maturityDays;
  const daysToEvent = input.estimatedDate ? daysBetween(input.today, input.estimatedDate) : null;
  const daysToDeadline = input.deadline ? daysBetween(input.today, input.deadline) : null;
  const inferred = !input.hasProcurementSignal;

  let maturity: SignalMaturity;
  if (daysToEvent == null && daysToDeadline == null) {
    maturity = "DATE_UNKNOWN";
  } else {
    // Use the nearer of event date / deadline as the urgency driver.
    const driver = [daysToEvent, daysToDeadline].filter((d): d is number => d != null).sort((a, b) => a - b)[0];
    if (driver < 0) maturity = "PAST";
    else if (driver <= m.immediate) maturity = "IMMEDIATE";
    else if (driver <= m.operational) maturity = "OPERATIONALLY_ACTIVE";
    else if (driver <= m.procurement) maturity = "PROCUREMENT_WINDOW";
    else if (driver <= m.planning) maturity = "PLANNING";
    else maturity = "EARLY_SIGNAL";
  }

  return {
    maturity,
    label: MATURITY_LABEL[maturity],
    headline: HEADLINE[maturity],
    daysToEvent,
    daysToDeadline,
    inferredFromDateOnly: inferred,
  };
}

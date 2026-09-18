// Event Radar — qualification engine. PURE and deterministic: given an event's facts + config, it
// returns a 0–100 rental-fit score, a tier, and a TRANSPARENT explanation (which signals added/
// subtracted points, and which are unknown). No AI, no DB, no network — "RULES CALCULATE".
//
// The whole point is that a manager can read WHY an event scored the way it did, and that the same
// facts always produce the same score.

import { DEFAULT_RADAR_CONFIG, TINY_EVENT_MAX, type RadarConfig } from "./config";
import { ATTRIBUTE_LABEL, CATEGORY_LABEL, type Attributes, type EventCategory, type Qualification, type ScoreSignal } from "./types";
import { isInServiceArea, REGION_LABEL, type Region } from "./geo";

export interface QualifyInput {
  category: EventCategory;
  region: Region;
  startDate: string | null; // YYYY-MM-DD
  endDate: string | null;
  expectedAttendance: number | null;
  attendanceConfidence: "VERIFIED" | "INFERRED" | "UNKNOWN";
  recurring: boolean;
  attributes: Attributes;
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Multi-day when end_date is strictly after start_date. */
export function isMultiDay(startDate: string | null, endDate: string | null): boolean {
  return !!startDate && !!endDate && endDate > startDate;
}

/** The deterministic qualification. Positives/negatives/unknowns together explain the score fully. */
export function qualify(input: QualifyInput, config: RadarConfig = DEFAULT_RADAR_CONFIG): Qualification {
  const positives: ScoreSignal[] = [];
  const negatives: ScoreSignal[] = [];
  const unknowns: ScoreSignal[] = [];

  // Category — the base relevance.
  const catPts = config.categoryWeight[input.category] ?? 0;
  if (catPts > 0) positives.push({ key: "category", label: CATEGORY_LABEL[input.category], direction: "positive", weight: catPts });

  // Geography.
  if (input.region === "OUT_OF_AREA") {
    negatives.push({ key: "out_of_area", label: "Outside DMV service area", direction: "negative", weight: config.outOfAreaPenalty });
  } else if (input.region === "UNKNOWN") {
    unknowns.push({ key: "region", label: "Location within service area", direction: "unknown", weight: 0 });
  } else if (isInServiceArea(input.region)) {
    positives.push({ key: "in_region", label: `${REGION_LABEL[input.region]} (in service area)`, direction: "positive", weight: config.inRegionPoints });
  }

  // Attendance band (or unknown, or tiny-event penalty).
  if (input.expectedAttendance == null || input.attendanceConfidence === "UNKNOWN") {
    unknowns.push({ key: "attendance", label: "Expected attendance", direction: "unknown", weight: 0 });
  } else if (input.expectedAttendance <= TINY_EVENT_MAX) {
    negatives.push({ key: "tiny_event", label: `Very small event (~${input.expectedAttendance})`, direction: "negative", weight: config.tinyEventPenalty });
  } else {
    const band = config.attendanceBands.find((b) => input.expectedAttendance! >= b.min);
    if (band) positives.push({ key: "attendance", label: band.label, direction: "positive", weight: band.points });
  }

  // Multi-day.
  if (isMultiDay(input.startDate, input.endDate)) {
    positives.push({ key: "multi_day", label: "Multi-day event", direction: "positive", weight: config.multiDayPoints });
  }

  // Recurring.
  if (input.recurring) {
    positives.push({ key: "recurring", label: "Recurring event", direction: "positive", weight: config.recurringPoints });
  }

  // Rental attributes (PRESENT adds; UNKNOWN listed as unknown; ABSENT is silent).
  for (const key of Object.keys(ATTRIBUTE_LABEL) as (keyof typeof ATTRIBUTE_LABEL)[]) {
    const status = input.attributes[key];
    const label = ATTRIBUTE_LABEL[key];
    if (key === "virtual") {
      if (status === "PRESENT") negatives.push({ key: "virtual", label: "Fully virtual event", direction: "negative", weight: config.virtualPenalty });
      continue;
    }
    if (status === "PRESENT") positives.push({ key, label, direction: "positive", weight: config.attributeWeight[key] ?? 0 });
    else if (status === "UNKNOWN") unknowns.push({ key, label, direction: "unknown", weight: 0 });
  }

  const rawPositive = positives.reduce((s, p) => s + p.weight, 0);
  const rawNegative = negatives.reduce((s, n) => s + n.weight, 0);
  const rentalFitScore = Math.round(clamp(rawPositive + rawNegative));

  // Commercial opportunity = rental fit tempered by how much we actually KNOW. Each unknown that would
  // otherwise be a scorable signal shaves confidence, so a high-fit-but-unverified event ranks below an
  // equally-fit fully-verified one. It never inflates above rental fit.
  const knownDrivers = positives.length + negatives.length;
  const confidence = knownDrivers + unknowns.length === 0 ? 1 : knownDrivers / (knownDrivers + unknowns.length);
  const commercialOpportunityScore = Math.round(rentalFitScore * (0.7 + 0.3 * confidence));

  const tier = tierFor(rentalFitScore, config);

  return {
    rentalFitScore,
    commercialOpportunityScore,
    tier,
    outreachPriority: tier,
    positives: positives.sort((a, b) => b.weight - a.weight),
    negatives,
    unknowns,
    estimatedValue: estimateValue(input, config),
  };
}

/** Map a rental-fit score to a tier via configured thresholds. */
export function tierFor(score: number, config: RadarConfig = DEFAULT_RADAR_CONFIG): "HIGH" | "MEDIUM" | "LOW" | "UNQUALIFIED" {
  for (const t of config.tierThresholds) if (score >= t.min) return t.tier;
  return "UNQUALIFIED";
}

/** Coarse indicative rental-spend range — ONLY when attendance is known and the category has a rate.
 *  Deliberately wide and clearly indicative; null otherwise. Never a revenue prediction. */
export function estimateValue(input: QualifyInput, config: RadarConfig = DEFAULT_RADAR_CONFIG): { low: number; high: number } | null {
  if (input.expectedAttendance == null || input.attendanceConfidence === "UNKNOWN") return null;
  if (input.region === "OUT_OF_AREA") return null;
  const rate = config.valuePerAttendee[input.category];
  if (!rate) return null;
  const round = (n: number) => Math.round(n / 500) * 500;
  return { low: round(input.expectedAttendance * rate.low), high: round(input.expectedAttendance * rate.high) };
}

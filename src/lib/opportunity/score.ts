// Opportunity Radar — scoring engine. PURE and deterministic. Given an opportunity's facts + config it
// returns a 0–100 relevance score, a 0–100 opportunity score, a tier, and a TRANSPARENT explanation
// (which signals added/subtracted points, and which are unknown). The user must always see WHY (§12).

import { DEFAULT_OPPORTUNITY_CONFIG, type OpportunityConfig } from "./config";
import { ZOE_CATEGORY_LABEL, type Confidence, type OpportunityScore, type ScoreSignal, type Verification, type ZoeCategory } from "./types";
import { isInServiceArea, REGION_LABEL, type Region } from "@/lib/radar/geo";

export interface ScoreInput {
  region: Region;
  governmentInvolved: boolean;
  zoeCategories: ZoeCategory[];
  expectedAttendance: number | null;
  attendanceConfidence: Confidence;
  daysToEvent: number | null;
  daysToDeadline: number | null; // null when no deadline; negative = passed
  hasKnownContractor: boolean; // a prime / GC / event-mgmt / production company is identified
  hasKnownPlanner: boolean;
  hasExistingRelationship: boolean; // buyer/contractor already in Zoe's customer history
  verificationStatus: Verification; // detection confidence
  fullyVirtual: boolean;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export function scoreOpportunity(input: ScoreInput, config: OpportunityConfig = DEFAULT_OPPORTUNITY_CONFIG): OpportunityScore {
  const w = config.weights;
  const positives: ScoreSignal[] = [];
  const negatives: ScoreSignal[] = [];
  const unknowns: ScoreSignal[] = [];

  // Geography
  if (input.region === "OUT_OF_AREA") negatives.push({ key: "out_of_area", label: "Outside DMV service area", direction: "negative", weight: w.outOfArea });
  else if (input.region === "UNKNOWN") unknowns.push({ key: "region", label: "Location within service area", direction: "unknown", weight: 0 });
  else if (isInServiceArea(input.region)) positives.push({ key: "in_area", label: `${REGION_LABEL[input.region]} (in service area)`, direction: "positive", weight: w.inServiceArea });

  // Government involvement
  if (input.governmentInvolved) positives.push({ key: "government", label: "Government / public buyer involved", direction: "positive", weight: w.governmentInvolvement });

  // Size band
  if (input.expectedAttendance == null || input.attendanceConfidence === "UNKNOWN") {
    unknowns.push({ key: "size", label: "Event / project size", direction: "unknown", weight: 0 });
  } else {
    const band = config.sizeBands.find((b) => input.expectedAttendance! >= b.min);
    if (band) positives.push({ key: "size", label: band.label, direction: "positive", weight: band.points });
  }

  // Zoe category fit
  if (input.zoeCategories.length > 0) {
    const pts = Math.min(config.weights.zoeCategoryCap, input.zoeCategories.length * w.perZoeCategory);
    positives.push({ key: "categories", label: `Zoe categories: ${input.zoeCategories.map((c) => ZOE_CATEGORY_LABEL[c]).join(", ")}`, direction: "positive", weight: pts });
  } else {
    unknowns.push({ key: "categories", label: "Zoe rental requirements", direction: "unknown", weight: 0 });
  }

  // Relationship signals
  if (input.hasKnownContractor) positives.push({ key: "contractor", label: "Prime / contractor / event-mgmt identified", direction: "positive", weight: w.knownPrimeOrContractor });
  if (input.hasKnownPlanner) positives.push({ key: "planner", label: "Event planner identified", direction: "positive", weight: w.knownPlanner });
  if (input.hasExistingRelationship) positives.push({ key: "relationship", label: "Existing Zoe relationship", direction: "positive", weight: w.existingZoeRelationship });

  // Procurement deadline actionability
  if (input.daysToDeadline != null) {
    if (input.daysToDeadline < 0) negatives.push({ key: "deadline_passed", label: "Procurement deadline has passed", direction: "negative", weight: w.expiredDeadline });
    else positives.push({ key: "deadline", label: `Actionable deadline in ${input.daysToDeadline}d`, direction: "positive", weight: w.actionableDeadline });
  }

  // Fully virtual → nothing to rent into
  if (input.fullyVirtual) negatives.push({ key: "virtual", label: "Fully virtual / no physical footprint", direction: "negative", weight: w.fullyVirtualOrRemote });

  const rawPositive = positives.reduce((s, p) => s + p.weight, 0);
  const rawNegative = negatives.reduce((s, n) => s + n.weight, 0);
  const relevanceScore = Math.round(clamp(rawPositive + rawNegative));

  // Opportunity score = relevance tempered by how confident we are (detection status + how many
  // scorable signals are still unknown). Never inflates above relevance.
  const detConf = input.verificationStatus === "VERIFIED" ? 1 : input.verificationStatus === "INFERRED" ? 0.8 : input.verificationStatus === "NOT_YET_VERIFIED" ? 0.6 : 0.5;
  const known = positives.length + negatives.length;
  const knownRatio = known + unknowns.length === 0 ? 1 : known / (known + unknowns.length);
  const confidence = 0.5 * detConf + 0.5 * knownRatio;
  const opportunityScore = Math.round(relevanceScore * (0.6 + 0.4 * confidence));

  const tier = tierFor(relevanceScore, config);

  return {
    relevanceScore,
    opportunityScore,
    tier,
    positives: positives.sort((a, b) => b.weight - a.weight),
    negatives,
    unknowns,
    estimatedValue: estimateValue(input, config),
  };
}

export function tierFor(score: number, config: OpportunityConfig = DEFAULT_OPPORTUNITY_CONFIG): "HIGH" | "MEDIUM" | "LOW" | "UNQUALIFIED" {
  for (const t of config.tierThresholds) if (score >= t.min) return t.tier;
  return "UNQUALIFIED";
}

/** Indicative rental-spend range — attendance × per-attendee when size is known, else a category floor,
 *  else null. Coarse and clearly indicative; never a revenue prediction. */
export function estimateValue(input: ScoreInput, config: OpportunityConfig = DEFAULT_OPPORTUNITY_CONFIG): { low: number; high: number } | null {
  if (input.region === "OUT_OF_AREA" || input.fullyVirtual) return null;
  const round = (n: number) => Math.round(n / 500) * 500;
  if (input.expectedAttendance != null && input.attendanceConfidence !== "UNKNOWN") {
    return { low: round(input.expectedAttendance * config.valuePerAttendee.low), high: round(input.expectedAttendance * config.valuePerAttendee.high) };
  }
  if (input.zoeCategories.length > 0) return { ...config.categoryValueFloor };
  return null;
}

// Opportunity Radar — configurable scoring weights, tier thresholds, maturity windows, value bands
// and alert thresholds. Everything the deterministic engine keys off lives here (§12: the score must
// never be a black box, and weights must be tunable without touching the UI or engine body).

import type { ZoeCategory } from "./types";

export interface OpportunityConfig {
  /** Points a matched signal contributes toward the 0–100 relevance score. */
  weights: {
    inServiceArea: number; // opportunity is inside Zoe's DMV footprint
    outOfArea: number; // negative — outside the footprint
    governmentInvolvement: number; // a public buyer / procurement is involved
    perZoeCategory: number; // points per matched Zoe rental category (capped)
    zoeCategoryCap: number; // max total from category fit
    knownPrimeOrContractor: number; // a prime / GC / event-mgmt company is identified
    knownPlanner: number; // an event planner is identified
    existingZoeRelationship: number; // buyer/contractor already in Zoe's customer history
    actionableDeadline: number; // a procurement deadline still in the future (a concrete action)
    expiredDeadline: number; // negative — the deadline has passed
    fullyVirtualOrRemote: number; // negative — no physical footprint to rent into
  };
  /** Estimated-attendance/size bands → points (evaluated high-to-low; first match wins). */
  sizeBands: { min: number; points: number; label: string }[];
  /** Relevance score → tier (evaluated high-to-low). */
  tierThresholds: { min: number; tier: "HIGH" | "MEDIUM" | "LOW" }[];
  /** Indicative rental spend per attendee (dollars) for a coarse value RANGE — never a prediction. */
  valuePerAttendee: { low: number; high: number };
  /** Fallback value range (dollars) when attendance is unknown but Zoe categories were detected. */
  categoryValueFloor: { low: number; high: number };
  /** Signal-maturity day windows (§5), relative to the event/project date. */
  maturityDays: { earlySignal: number; planning: number; procurement: number; operational: number; immediate: number };
  /** Alert thresholds (§18) — meaningful-only. */
  alerts: { minValueHigh: number; minOpportunityScore: number };
}

export const DEFAULT_OPPORTUNITY_CONFIG: OpportunityConfig = {
  weights: {
    inServiceArea: 16,
    outOfArea: -45,
    governmentInvolvement: 14,
    perZoeCategory: 7,
    zoeCategoryCap: 30,
    knownPrimeOrContractor: 10,
    knownPlanner: 8,
    existingZoeRelationship: 12,
    actionableDeadline: 8,
    expiredDeadline: -25,
    fullyVirtualOrRemote: -40,
  },
  sizeBands: [
    { min: 2000, points: 20, label: "2,000+ expected attendees" },
    { min: 750, points: 16, label: "750+ expected attendees" },
    { min: 300, points: 12, label: "300+ expected attendees" },
    { min: 100, points: 7, label: "100+ expected attendees" },
    { min: 1, points: 3, label: "small expected size" },
  ],
  tierThresholds: [
    { min: 70, tier: "HIGH" },
    { min: 45, tier: "MEDIUM" },
    { min: 20, tier: "LOW" },
  ],
  valuePerAttendee: { low: 10, high: 30 },
  categoryValueFloor: { low: 3000, high: 12000 },
  maturityDays: { earlySignal: 365, planning: 270, procurement: 180, operational: 90, immediate: 30 },
  alerts: { minValueHigh: 25000, minOpportunityScore: 80 },
};

/** Deterministic keyword → Zoe rental category map (§ "RULES CALCULATE"). Matched against the
 *  opportunity's title + description; each hit adds its category. Order-independent. */
export const ZOE_CATEGORY_KEYWORDS: { category: ZoeCategory; patterns: RegExp }[] = [
  { category: "tent", patterns: /\b(tent|tents|canop(y|ies)|marquee|pavilion)\b/i },
  { category: "tables", patterns: /\b(table|tables|banquet table|cocktail table)\b/i },
  { category: "chairs", patterns: /\b(chair|chairs|seating|chiavari)\b/i },
  { category: "flooring", patterns: /\b(floor|flooring|subfloor|turf protection|carpet)\b/i },
  { category: "linens", patterns: /\b(linen|linens|tablecloth|napkin|drap(e|ing))\b/i },
  { category: "staging", patterns: /\b(stage|staging|riser|platform|grandstand|bleacher)\b/i },
  { category: "lighting", patterns: /\b(lighting|stage lights|uplight|string lights)\b/i },
  { category: "dance_floor", patterns: /\b(dance floor|dancefloor)\b/i },
  { category: "climate", patterns: /\b(heater|heating|hvac|air condition|climate|cooling|misting)\b/i },
  { category: "restrooms", patterns: /\b(restroom|portable toilet|porta[- ]?john|sanitation)\b/i },
  { category: "furniture", patterns: /\b(furniture|lounge|soft seating|event furniture|barstool)\b/i },
  { category: "structures", patterns: /\b(temporary structure|clearspan|staging structure|bleachers|scaffold(ing)?|barricade|crowd control)\b/i },
];

/** Broad "this is event-adjacent" keywords used for relevance when no explicit category matches, and
 *  for classifying a procurement notice as event-relevant. */
export const EVENT_RELEVANCE_KEYWORDS =
  /\b(event|events|conference|festival|gala|reception|ceremon(y|ies)|graduation|commencement|rental|rentals|tent|catering|hospitality|expo|trade show|grand opening|celebration|banquet|fair|summit)\b/i;

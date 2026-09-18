// Event Radar — domain types.
//
// Design law: "RULES CALCULATE. AI INTERPRETS." The types below split cleanly into FACTS (what a
// source told us, each carrying its provenance) and DERIVED values (scores, tiers, timing, opportunity
// value) that the pure engine computes deterministically from those facts. Nothing here fabricates a
// planner, attendance, date or contact — an unknown is UNKNOWN, never a guess.

// ── Provenance ────────────────────────────────────────────────────────────────────────────────────
/** How sure we are of a fact. NOT_YET_VERIFIED = we have it but haven't re-checked the source. */
export type Verification = "VERIFIED" | "INFERRED" | "UNKNOWN" | "NOT_YET_VERIFIED";
/** Confidence a fact carries (attendance, a planner, a series). */
export type Confidence = "VERIFIED" | "INFERRED" | "UNKNOWN";

// ── Event category ──────────────────────────────────────────────────────────────────────────────
export type EventCategory =
  | "CONFERENCE"
  | "ASSOCIATION_MEETING"
  | "CORPORATE"
  | "TRADE_SHOW"
  | "EXPO"
  | "GALA"
  | "FUNDRAISER"
  | "GOVERNMENT"
  | "UNIVERSITY"
  | "NONPROFIT"
  | "MEDICAL"
  | "NETWORKING"
  | "AWARDS"
  | "OUTDOOR_RECEPTION"
  | "HOSPITALITY"
  | "OTHER";

export const CATEGORY_LABEL: Record<EventCategory, string> = {
  CONFERENCE: "Conference",
  ASSOCIATION_MEETING: "Association meeting",
  CORPORATE: "Corporate event",
  TRADE_SHOW: "Trade show",
  EXPO: "Expo",
  GALA: "Gala",
  FUNDRAISER: "Fundraiser",
  GOVERNMENT: "Government event",
  UNIVERSITY: "University event",
  NONPROFIT: "Nonprofit event",
  MEDICAL: "Medical conference",
  NETWORKING: "Networking event",
  AWARDS: "Awards event",
  OUTDOOR_RECEPTION: "Outdoor reception",
  HOSPITALITY: "Hospitality event",
  OTHER: "Other",
};

// ── Rental signal attributes (facts from the source) ────────────────────────────────────────────
/** Each attribute is a rental-relevant feature the source may or may not confirm. Stored per event as
 *  a map of key → status. UNKNOWN is first-class — the qualification explanation surfaces it, never
 *  treating "unknown" as "absent". */
export type AttributeStatus = "PRESENT" | "ABSENT" | "UNKNOWN";
export type AttributeKey =
  | "reception"
  | "exhibitors"
  | "networking"
  | "gala"
  | "outdoor"
  | "hospitality"
  | "vip"
  | "sponsor_activation"
  | "virtual"; // PRESENT = fully virtual (a NEGATIVE signal)

export const ATTRIBUTE_LABEL: Record<AttributeKey, string> = {
  reception: "Reception",
  exhibitors: "Exhibitors",
  networking: "Networking",
  gala: "Gala / awards dinner",
  outdoor: "Outdoor component",
  hospitality: "Hospitality suite",
  vip: "VIP program",
  sponsor_activation: "Sponsor activation",
  virtual: "Fully virtual",
};

export type Attributes = Partial<Record<AttributeKey, AttributeStatus>>;

// ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────────
export type EventStatus = "DETECTED" | "QUALIFYING" | "QUALIFIED" | "HANDED_OFF" | "ARCHIVED";
export type SalesStatus = "NONE" | "OPPORTUNITY_CREATED" | "LINKED";

// ── Qualification output (DERIVED) ────────────────────────────────────────────────────────────────
export type OpportunityTier = "HIGH" | "MEDIUM" | "LOW" | "UNQUALIFIED";
export type OutreachPriority = OpportunityTier;

/** One line of the transparent score explanation. `weight` is the points this signal contributed. */
export interface ScoreSignal {
  key: string;
  label: string;
  /** positive = adds fit, negative = subtracts, unknown = missing evidence (0 points, shown as "?"). */
  direction: "positive" | "negative" | "unknown";
  weight: number;
}

export interface Qualification {
  rentalFitScore: number; // 0..100
  commercialOpportunityScore: number; // 0..100
  tier: OpportunityTier; // from rentalFitScore vs configured thresholds
  outreachPriority: OutreachPriority;
  positives: ScoreSignal[];
  negatives: ScoreSignal[];
  unknowns: ScoreSignal[];
  /** Indicative only — a coarse rental-spend range derived from attendance × category, shown only when
   *  attendance is known. NEVER a revenue prediction. null when we can't responsibly estimate. */
  estimatedValue: { low: number; high: number } | null;
}

// ── Recurrence (DERIVED) ────────────────────────────────────────────────────────────────────────
export interface RecurrenceView {
  recurring: boolean;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  seriesId?: string;
  seriesName?: string;
  cadence?: string;
  /** Past instances we actually hold (facts). */
  history: { id: string; name: string; date: string | null; isSeed: boolean }[];
  /** A PREDICTED/UNANNOUNCED next occurrence — never a fabricated event, only a projection with its
   *  supporting evidence. null when we won't project. */
  predictedNext: { year: number; basis: string } | null;
}

// ── Timing (DERIVED) ──────────────────────────────────────────────────────────────────────────────
export type OutreachPhase =
  | "TOO_EARLY"
  | "PLANNING_WINDOW"
  | "OUTREACH_WINDOW"
  | "ACTIVELY_SHOPPING"
  | "IMMINENT"
  | "PAST"
  | "DATE_UNKNOWN";

export interface TimingView {
  phase: OutreachPhase;
  status: string; // human phase label
  recommendedAction: string;
  /** The engagement window relative to the event, e.g. "4–6 months before". */
  outreachWindow: string;
  daysToEvent: number | null;
  /** true when the recommendation rests on the event date only (no verified procurement signal). */
  inferredFromDateOnly: boolean;
}

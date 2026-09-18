// Opportunity Radar — domain types for the unified Opportunity Intelligence layer.
//
// Event Radar, Procurement Radar and web/facility signals all normalize into ONE Opportunity record.
// FACTS live in the DB; scores, signal maturity and timing are DERIVED deterministically (see
// score.ts / maturity.ts / lifecycle.ts). Provenance + the score-explanation shape are reused from the
// existing radar module so both halves speak the same visual/labelling language.

import type { Verification, Confidence, ScoreSignal } from "@/lib/radar/types";

export type { Verification, Confidence, ScoreSignal };

// ── Kind ────────────────────────────────────────────────────────────────────────────────────────
export type OpportunityKind = "EVENT" | "PROCUREMENT" | "FACILITY_SIGNAL" | "WEB_SIGNAL";
export const KIND_LABEL: Record<OpportunityKind, string> = {
  EVENT: "Event",
  PROCUREMENT: "Procurement",
  FACILITY_SIGNAL: "Facility / construction",
  WEB_SIGNAL: "Web signal",
};

// ── Jurisdiction (expandable) ─────────────────────────────────────────────────────────────────────
export type Jurisdiction =
  | "FEDERAL"
  | "STATE_MD"
  | "DC"
  | "MONTGOMERY_CO"
  | "ROCKVILLE"
  | "GAITHERSBURG"
  | "PRINCE_GEORGES_CO"
  | "HOWARD_CO"
  | "BALTIMORE"
  | "NOVA"
  | "OTHER"
  | "UNKNOWN";
export const JURISDICTION_LABEL: Record<Jurisdiction, string> = {
  FEDERAL: "Federal",
  STATE_MD: "Maryland (state)",
  DC: "Washington, DC",
  MONTGOMERY_CO: "Montgomery County",
  ROCKVILLE: "City of Rockville",
  GAITHERSBURG: "City of Gaithersburg",
  PRINCE_GEORGES_CO: "Prince George's County",
  HOWARD_CO: "Howard County",
  BALTIMORE: "Baltimore",
  NOVA: "Northern Virginia",
  OTHER: "Other jurisdiction",
  UNKNOWN: "Unknown jurisdiction",
};

// ── Zoe rental categories (deterministic keyword classification) ─────────────────────────────────
export type ZoeCategory = "tent" | "tables" | "chairs" | "flooring" | "linens" | "staging" | "lighting" | "dance_floor" | "climate" | "restrooms" | "furniture" | "structures";
export const ZOE_CATEGORY_LABEL: Record<ZoeCategory, string> = {
  tent: "Tents", tables: "Tables", chairs: "Chairs", flooring: "Flooring", linens: "Linens",
  staging: "Staging", lighting: "Lighting", dance_floor: "Dance floor", climate: "Climate control",
  restrooms: "Restrooms", furniture: "Event furniture", structures: "Temporary structures",
};

// ── Lifecycle (§6) ────────────────────────────────────────────────────────────────────────────────
export type LifecycleStage =
  | "DISCOVERED"
  | "VALIDATED"
  | "RELEVANT"
  | "RESEARCHING"
  | "TARGET_IDENTIFIED"
  | "OUTREACH_READY"
  | "CONTACTED"
  | "ENGAGED"
  | "OPPORTUNITY"
  | "QUOTED"
  | "WON"
  | "LOST"
  | "ARCHIVED";
/** Canonical order for progress display + auto-advance comparisons. WON/LOST/ARCHIVED are terminal. */
export const STAGE_ORDER: LifecycleStage[] = [
  "DISCOVERED", "VALIDATED", "RELEVANT", "RESEARCHING", "TARGET_IDENTIFIED", "OUTREACH_READY", "CONTACTED", "ENGAGED", "OPPORTUNITY", "QUOTED", "WON",
];
export const STAGE_LABEL: Record<LifecycleStage, string> = {
  DISCOVERED: "Discovered", VALIDATED: "Validated", RELEVANT: "Relevant", RESEARCHING: "Researching",
  TARGET_IDENTIFIED: "Target identified", OUTREACH_READY: "Outreach ready", CONTACTED: "Contacted",
  ENGAGED: "Engaged", OPPORTUNITY: "Opportunity", QUOTED: "Quoted", WON: "Won", LOST: "Lost", ARCHIVED: "Archived",
};

// ── Signal maturity (§5) ──────────────────────────────────────────────────────────────────────────
export type SignalMaturity = "EARLY_SIGNAL" | "PLANNING" | "PROCUREMENT_WINDOW" | "OPERATIONALLY_ACTIVE" | "IMMEDIATE" | "PAST" | "DATE_UNKNOWN";
export const MATURITY_LABEL: Record<SignalMaturity, string> = {
  EARLY_SIGNAL: "Early signal", PLANNING: "Planning activity", PROCUREMENT_WINDOW: "Procurement window",
  OPERATIONALLY_ACTIVE: "Operationally active", IMMEDIATE: "Immediate opportunity", PAST: "Past", DATE_UNKNOWN: "Date unknown",
};

// ── Relationship graph (§7/§8) ────────────────────────────────────────────────────────────────────
export type EntityKind = "AGENCY" | "PRIME" | "EVENT_PLANNER" | "FACILITIES" | "PRODUCTION" | "CATERING" | "VENDOR" | "PARTNER" | "CONTACT" | "UNKNOWN";
export const ENTITY_KIND_LABEL: Record<EntityKind, string> = {
  AGENCY: "Government agency", PRIME: "Prime contractor", EVENT_PLANNER: "Event planner", FACILITIES: "Facilities contractor",
  PRODUCTION: "Production company", CATERING: "Catering company", VENDOR: "Vendor", PARTNER: "Partner", CONTACT: "Contact", UNKNOWN: "Unknown",
};
export type RelationshipRole =
  | "DIRECT_BUYER"
  | "PRIME_CONTRACTOR"
  | "EVENT_PLANNER"
  | "FACILITIES_CONTRACTOR"
  | "EVENT_MGMT"
  | "PRODUCTION"
  | "VENDOR"
  | "PARTNER"
  | "PROCUREMENT_CONTACT"
  | "UNKNOWN";
export const RELATIONSHIP_LABEL: Record<RelationshipRole, string> = {
  DIRECT_BUYER: "Direct buyer", PRIME_CONTRACTOR: "Prime contractor", EVENT_PLANNER: "Event planner",
  FACILITIES_CONTRACTOR: "Facilities contractor", EVENT_MGMT: "Event management company", PRODUCTION: "Production company",
  VENDOR: "Vendor", PARTNER: "Partner", PROCUREMENT_CONTACT: "Procurement contact", UNKNOWN: "Unknown",
};

export type SalesStatus = "NONE" | "OPPORTUNITY_CREATED" | "LINKED";

// ── Derived views ─────────────────────────────────────────────────────────────────────────────────
/** The transparent opportunity score (§12). Same explanation shape as radar qualify. */
export interface OpportunityScore {
  relevanceScore: number; // 0..100 — how relevant to Zoe at all
  opportunityScore: number; // 0..100 — relevance tempered by confidence + timing (the ranking number)
  tier: "HIGH" | "MEDIUM" | "LOW" | "UNQUALIFIED";
  positives: ScoreSignal[];
  negatives: ScoreSignal[];
  unknowns: ScoreSignal[];
  estimatedValue: { low: number; high: number } | null;
}

export interface MaturityView {
  maturity: SignalMaturity;
  label: string;
  headline: string; // e.g. "Procurement / venue activity detected"
  daysToEvent: number | null;
  daysToDeadline: number | null;
  inferredFromDateOnly: boolean;
}

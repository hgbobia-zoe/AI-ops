// Opportunity Radar — service layer. Reads FACTS and runs the PURE engines to produce the fully-derived
// views the UI renders: transparent score, signal maturity, effective lifecycle stage, the recommended
// primary target (who to contact), and relationship memory. Nothing here is persisted — same facts
// always yield the same view. Assembles the four dashboard lanes + metrics (§13).

import { todayInOpsTz } from "@/lib/dates";
import { getEvent } from "@/lib/radar/store";
import { scoreOpportunity, type ScoreInput } from "./score";
import { deriveMaturity } from "./maturity";
import { autoStage, effectiveStage, type LifecycleFacts } from "./lifecycle";
import { targetRank } from "./classify";
import { buildCustomerIndex, matchEntity, type RelationshipMemo } from "./relationship";
import {
  getOpportunities, getOpportunity, getEntitiesForOpportunity, getProcurement, type StoredOpportunity, type EdgeWithEntity, type StoredProcurement,
} from "./store";
import { RELATIONSHIP_LABEL, type LifecycleStage, type MaturityView, type OpportunityScore, type Confidence } from "./types";

const CONTRACTOR_ROLES = new Set(["PRIME_CONTRACTOR", "EVENT_MGMT", "FACILITIES_CONTRACTOR", "PRODUCTION"]);

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}

export interface PrimaryTarget {
  edge: EdgeWithEntity;
  relationshipLabel: string;
}

export interface OpportunityView {
  opp: StoredOpportunity;
  score: OpportunityScore;
  maturity: MaturityView;
  stage: LifecycleStage;
  entities: EdgeWithEntity[];
  primaryTarget: PrimaryTarget | null;
  hasExistingRelationship: boolean;
  recommendedAction: string;
  /** Effective value: the source's hard figure when present, else the derived indicative range. */
  value: { low: number; high: number; indicative: boolean } | null;
}

export interface ViewContext {
  today: string;
  customerIndex: ReturnType<typeof buildCustomerIndex>;
}

function makeContext(today: string): ViewContext {
  return { today, customerIndex: buildCustomerIndex(today) };
}

function pickPrimary(edges: EdgeWithEntity[]): PrimaryTarget | null {
  if (edges.length === 0) return null;
  const flagged = edges.find((e) => e.isPrimaryTarget);
  const chosen = flagged ?? [...edges].sort((a, b) => targetRank(a.relationship) - targetRank(b.relationship))[0];
  return { edge: chosen, relationshipLabel: RELATIONSHIP_LABEL[chosen.relationship] };
}

/** Derive the full view for one stored opportunity. */
export function viewFor(opp: StoredOpportunity, ctx: ViewContext): OpportunityView {
  const edges = getEntitiesForOpportunity(opp.id);

  // Attendance (size): the opportunity's own figure (source/manual import) first, else the linked event.
  let expectedAttendance: number | null = opp.expectedAttendance;
  let attendanceConfidence: Confidence = opp.attendanceConfidence;
  if (expectedAttendance == null && opp.eventId) {
    const ev = getEvent(opp.eventId);
    if (ev) { expectedAttendance = ev.expectedAttendance; attendanceConfidence = ev.attendanceConfidence; }
  }

  const hasKnownContractor = edges.some((e) => CONTRACTOR_ROLES.has(e.relationship));
  const hasKnownPlanner = edges.some((e) => e.relationship === "EVENT_PLANNER");
  const hasExistingRelationship = edges.some((e) => e.entity.matchedCustomerKey != null);
  const fullyVirtual = opp.region === "UNKNOWN" && /\b(virtual|online|webinar)\b/i.test(`${opp.name} ${opp.description ?? ""}`);

  const scoreInput: ScoreInput = {
    region: opp.region,
    governmentInvolved: opp.kind === "PROCUREMENT",
    zoeCategories: opp.zoeCategories,
    expectedAttendance,
    attendanceConfidence,
    daysToEvent: opp.estimatedDate ? daysBetween(ctx.today, opp.estimatedDate) : null,
    daysToDeadline: opp.deadline ? daysBetween(ctx.today, opp.deadline) : null,
    hasKnownContractor,
    hasKnownPlanner,
    hasExistingRelationship,
    verificationStatus: opp.verificationStatus,
    fullyVirtual,
  };
  const score = scoreOpportunity(scoreInput);
  const maturity = deriveMaturity({ estimatedDate: opp.estimatedDate, deadline: opp.deadline, today: ctx.today, hasProcurementSignal: opp.kind === "PROCUREMENT" && !!opp.deadline });
  const primaryTarget = pickPrimary(edges);

  const facts: LifecycleFacts = {
    hasCoreFields: !!opp.name && (!!opp.estimatedDate || !!opp.deadline) && opp.jurisdiction !== "UNKNOWN",
    isRelevant: score.tier !== "UNQUALIFIED",
    hasEntities: edges.length > 0,
    hasPrimaryTarget: primaryTarget != null,
    hasOutreachDraft: opp.stage === "OUTREACH_READY" && opp.stageSource === "manual",
  };
  const auto = autoStage(facts);
  const stage = effectiveStage(auto, opp.stageSource === "manual" ? opp.stage : null);

  const recommendedAction = deriveRecommendedAction(opp, primaryTarget, edges.length, maturity);

  const value =
    opp.estValueLow != null || opp.estValueHigh != null
      ? { low: opp.estValueLow ?? opp.estValueHigh ?? 0, high: opp.estValueHigh ?? opp.estValueLow ?? 0, indicative: false }
      : score.estimatedValue
        ? { ...score.estimatedValue, indicative: true }
        : null;

  return { opp, score, maturity, stage, entities: edges, primaryTarget, hasExistingRelationship, recommendedAction, value };
}

function deriveRecommendedAction(opp: StoredOpportunity, primary: PrimaryTarget | null, entityCount: number, maturity: MaturityView): string {
  if (opp.salesStatus !== "NONE") return "In Sales OS — continue the sales process";
  if (primary) {
    const verb = maturity.maturity === "IMMEDIATE" || maturity.maturity === "OPERATIONALLY_ACTIVE" ? "Contact now" : "Begin relationship outreach";
    return `${verb}: ${primary.edge.entity.name} (${primary.relationshipLabel})`;
  }
  if (entityCount > 0) return "Confirm the right contact among the identified companies";
  return "Research the organizer / prime to identify who to approach";
}

/** Relationship memory for a single entity (used on the detail page). */
export function relationshipFor(entity: { name: string; email?: string | null }, ctx: ViewContext): RelationshipMemo {
  return matchEntity(entity, ctx.customerIndex);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────────────────────────
export type Lane = "NEW_SIGNALS" | "EARLY_SIGNALS" | "OUTREACH_READY" | "ACTIVE";

const ACTIVE_STAGES = new Set<LifecycleStage>(["CONTACTED", "ENGAGED", "OPPORTUNITY", "QUOTED", "WON"]);

export function laneOf(v: OpportunityView): Lane {
  if (v.opp.salesStatus !== "NONE" || ACTIVE_STAGES.has(v.stage)) return "ACTIVE";
  const outreachStage = v.stage === "TARGET_IDENTIFIED" || v.stage === "OUTREACH_READY";
  const readyMaturity = v.maturity.maturity === "IMMEDIATE" || v.maturity.maturity === "OPERATIONALLY_ACTIVE" || v.maturity.maturity === "PROCUREMENT_WINDOW";
  if (v.score.tier !== "UNQUALIFIED" && (outreachStage || (v.primaryTarget && readyMaturity))) return "OUTREACH_READY";
  if (v.maturity.maturity === "EARLY_SIGNAL" || v.maturity.maturity === "PLANNING") return "EARLY_SIGNALS";
  return "NEW_SIGNALS";
}

export interface OpportunityBoard {
  today: string;
  lanes: Record<Lane, OpportunityView[]>;
  all: OpportunityView[];
  metrics: {
    discovered: number;
    qualified: number;
    companiesIdentified: number;
    contactsIdentified: number;
    enteringOutreach: number;
    highValue: number;
    recurring: number;
  };
  hasSeedData: boolean;
}

const TIER_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, UNQUALIFIED: 0 } as const;

export function opportunityBoard(today: string = todayInOpsTz()): OpportunityBoard {
  const ctx = makeContext(today);
  const opps = getOpportunities();
  const all = opps
    .map((o) => viewFor(o, ctx))
    .sort((a, b) => TIER_RANK[b.score.tier] - TIER_RANK[a.score.tier] || b.score.opportunityScore - a.score.opportunityScore || (a.opp.estimatedDate ?? "9999").localeCompare(b.opp.estimatedDate ?? "9999"));

  const lanes: Record<Lane, OpportunityView[]> = { NEW_SIGNALS: [], EARLY_SIGNALS: [], OUTREACH_READY: [], ACTIVE: [] };
  const companies = new Set<string>();
  let contacts = 0;
  for (const v of all) {
    lanes[laneOf(v)].push(v);
    for (const e of v.entities) { companies.add(e.entity.id); if (e.entity.kind === "CONTACT" || e.entity.email) contacts++; }
  }

  const metrics = {
    discovered: all.length,
    qualified: all.filter((v) => v.score.tier !== "UNQUALIFIED").length,
    companiesIdentified: companies.size,
    contactsIdentified: contacts,
    enteringOutreach: lanes.OUTREACH_READY.length,
    highValue: all.filter((v) => (v.value?.high ?? 0) >= 25000).length,
    recurring: 0,
  };

  return { today, lanes, all, metrics, hasSeedData: opps.some((o) => o.isSeed) };
}

// ── Detail ──────────────────────────────────────────────────────────────────────────────────────
export interface OpportunityDetail extends OpportunityView {
  entityMemos: { edge: EdgeWithEntity; memo: RelationshipMemo }[];
  procurement: StoredProcurement | null;
  awarded: boolean;
  awardee: string | null;
}

/** A single opportunity's derived view (builds its own context). For alerts and one-off reads. */
export function singleView(id: string, today: string = todayInOpsTz()): OpportunityView | null {
  const opp = getOpportunity(id);
  if (!opp) return null;
  return viewFor(opp, makeContext(today));
}

export function opportunityDetail(id: string, today: string = todayInOpsTz()): OpportunityDetail | null {
  const opp = getOpportunity(id);
  if (!opp) return null;
  const ctx = makeContext(today);
  const base = viewFor(opp, ctx);
  const entityMemos = base.entities.map((edge) => ({ edge, memo: matchEntity({ name: edge.entity.name, email: edge.entity.email }, ctx.customerIndex) }));
  const procurement = getProcurement(opp.procurementId);
  const awardee = procurement?.awardee ?? null;
  const awarded = !!awardee || /award/i.test(opp.status ?? "");
  return { ...base, entityMemos, procurement, awarded, awardee };
}

export { getOpportunity };

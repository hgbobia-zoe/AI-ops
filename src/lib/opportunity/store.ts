// Opportunity Radar — persistence + reads. FACTS ONLY (scores/maturity/lifecycle are derived in
// service.ts). Upserts key off a stable identity so a re-pull updates in place, never duplicates:
// opportunities by dedupe_key, entities by (name, kind), edges by (opportunity, entity, relationship).
// Human-owned fields (manual stage, sales handoff, campaign) are preserved across re-ingestion.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { EntityKind, Jurisdiction, LifecycleStage, OpportunityKind, RelationshipRole, SalesStatus, Verification, ZoeCategory } from "./types";
import type { Region } from "@/lib/radar/geo";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Stored shapes ───────────────────────────────────────────────────────────────────────────────
export interface StoredOpportunity {
  id: string;
  dedupeKey: string;
  kind: OpportunityKind;
  name: string;
  description: string | null;
  sourceId: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  jurisdiction: Jurisdiction;
  region: Region;
  city: string | null;
  state: string | null;
  organization: string | null;
  estimatedDate: string | null;
  deadline: string | null;
  discoveredAt: string;
  lastReviewedAt: string | null;
  nextActionDate: string | null;
  stage: LifecycleStage; // stored value (manual override when stageSource=manual, else auto cache)
  stageSource: "auto" | "manual";
  status: string | null;
  estValueLow: number | null;
  estValueHigh: number | null;
  zoeCategories: ZoeCategory[];
  verificationStatus: Verification;
  confidence: number | null;
  eventId: string | null;
  procurementId: string | null;
  campaignId: string | null;
  bookingId: string | null;
  salesStatus: SalesStatus;
  recommendedAction: string | null;
  isSeed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredEntity {
  id: string;
  name: string;
  kind: EntityKind;
  website: string | null;
  email: string | null;
  phone: string | null;
  jurisdiction: string | null;
  verificationStatus: Verification;
  matchedCustomerKey: string | null;
  notes: string | null;
  isSeed: boolean;
}

export interface StoredEdge {
  id: string;
  opportunityId: string;
  entityId: string;
  relationship: RelationshipRole;
  isPrimaryTarget: boolean;
  confidence: number | null;
  evidence: string | null;
}

export interface StoredCampaign {
  id: string;
  name: string;
  description: string | null;
  criteria: Record<string, unknown> | null;
  createdBy: string | null;
  isSeed: boolean;
}

function toOpportunity(r: any): StoredOpportunity {
  return {
    id: r.id, dedupeKey: r.dedupe_key, kind: r.kind, name: r.name, description: r.description ?? null,
    sourceId: r.source_id ?? null, sourceName: r.source_name ?? null, sourceUrl: r.source_url ?? null,
    jurisdiction: (r.jurisdiction as Jurisdiction) ?? "UNKNOWN", region: (r.region as Region) ?? "UNKNOWN",
    city: r.city ?? null, state: r.state ?? null, organization: r.organization ?? null,
    estimatedDate: r.estimated_date ?? null, deadline: r.deadline ?? null, discoveredAt: r.discovered_at,
    lastReviewedAt: r.last_reviewed_at ?? null, nextActionDate: r.next_action_date ?? null,
    stage: r.stage as LifecycleStage, stageSource: (r.stage_source as "auto" | "manual") ?? "auto", status: r.status ?? null,
    estValueLow: r.est_value_low ?? null, estValueHigh: r.est_value_high ?? null,
    zoeCategories: r.zoe_categories ? (JSON.parse(r.zoe_categories) as ZoeCategory[]) : [],
    verificationStatus: (r.verification_status as Verification) ?? "NOT_YET_VERIFIED", confidence: r.confidence ?? null,
    eventId: r.event_id ?? null, procurementId: r.procurement_id ?? null, campaignId: r.campaign_id ?? null,
    bookingId: r.booking_id ?? null, salesStatus: (r.sales_status as SalesStatus) ?? "NONE",
    recommendedAction: r.recommended_action ?? null, isSeed: !!r.is_seed, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function toEntity(r: any): StoredEntity {
  return { id: r.id, name: r.name, kind: r.kind as EntityKind, website: r.website ?? null, email: r.email ?? null, phone: r.phone ?? null, jurisdiction: r.jurisdiction ?? null, verificationStatus: r.verification_status as Verification, matchedCustomerKey: r.matched_customer_key ?? null, notes: r.notes ?? null, isSeed: !!r.is_seed };
}
function toEdge(r: any): StoredEdge {
  return { id: r.id, opportunityId: r.opportunity_id, entityId: r.entity_id, relationship: r.relationship as RelationshipRole, isPrimaryTarget: !!r.is_primary_target, confidence: r.confidence ?? null, evidence: r.evidence ?? null };
}
function toCampaign(r: any): StoredCampaign {
  return { id: r.id, name: r.name, description: r.description ?? null, criteria: r.criteria ? JSON.parse(r.criteria) : null, createdBy: r.created_by ?? null, isSeed: !!r.is_seed };
}

// ── Opportunity upsert ──────────────────────────────────────────────────────────────────────────
export interface OpportunityInput {
  dedupeKey: string;
  kind: OpportunityKind;
  name: string;
  description?: string | null;
  sourceId?: string | null;
  sourceName?: string | null;
  sourceUrl?: string | null;
  jurisdiction: Jurisdiction;
  region: Region;
  city?: string | null;
  state?: string | null;
  organization?: string | null;
  estimatedDate?: string | null;
  deadline?: string | null;
  status?: string | null;
  estValueLow?: number | null;
  estValueHigh?: number | null;
  zoeCategories?: ZoeCategory[];
  verificationStatus?: Verification;
  confidence?: number | null;
  eventId?: string | null;
  procurementId?: string | null;
  recommendedAction?: string | null;
  isSeed?: boolean;
}

/** Insert or update an opportunity by dedupe_key. Human-owned fields (stage when manual, sales handoff,
 *  campaign, next action, last reviewed) are preserved on update; only discovery facts refresh. */
export function upsertOpportunity(input: OpportunityInput, now: Date = new Date()): StoredOpportunity {
  const db = getDb();
  const ts = now.toISOString();
  const existing = db.prepare("SELECT * FROM opportunities WHERE dedupe_key = ?").get(input.dedupeKey) as any;
  const facts = {
    kind: input.kind, name: input.name, description: input.description ?? null,
    source_id: input.sourceId ?? null, source_name: input.sourceName ?? null, source_url: input.sourceUrl ?? null,
    jurisdiction: input.jurisdiction, region: input.region, city: input.city ?? null, state: input.state ?? null,
    organization: input.organization ?? null, estimated_date: input.estimatedDate ?? null, deadline: input.deadline ?? null,
    status: input.status ?? null, est_value_low: input.estValueLow ?? null, est_value_high: input.estValueHigh ?? null,
    zoe_categories: input.zoeCategories ? JSON.stringify(input.zoeCategories) : null,
    verification_status: input.verificationStatus ?? "NOT_YET_VERIFIED", confidence: input.confidence ?? null,
    event_id: input.eventId ?? null, procurement_id: input.procurementId ?? null,
    recommended_action: input.recommendedAction ?? null, is_seed: input.isSeed ? 1 : 0,
  };
  if (existing) {
    db.prepare(
      `UPDATE opportunities SET kind=@kind, name=@name, description=@description, source_id=@source_id,
         source_name=@source_name, source_url=@source_url, jurisdiction=@jurisdiction, region=@region, city=@city,
         state=@state, organization=@organization, estimated_date=@estimated_date, deadline=@deadline, status=@status,
         est_value_low=@est_value_low, est_value_high=@est_value_high, zoe_categories=@zoe_categories,
         verification_status=@verification_status, confidence=@confidence, event_id=@event_id, procurement_id=@procurement_id,
         recommended_action=@recommended_action, is_seed=@is_seed, updated_at=@ts WHERE dedupe_key=@dedupe_key`,
    ).run({ ...facts, dedupe_key: input.dedupeKey, ts });
    return toOpportunity(db.prepare("SELECT * FROM opportunities WHERE dedupe_key = ?").get(input.dedupeKey));
  }
  const id = `OPP-${randomUUID()}`;
  db.prepare(
    `INSERT INTO opportunities (id, dedupe_key, kind, name, description, source_id, source_name, source_url, jurisdiction,
       region, city, state, organization, estimated_date, deadline, discovered_at, stage, stage_source, status,
       est_value_low, est_value_high, zoe_categories, verification_status, confidence, event_id, procurement_id,
       sales_status, recommended_action, is_seed, created_at, updated_at)
     VALUES (@id,@dedupe_key,@kind,@name,@description,@source_id,@source_name,@source_url,@jurisdiction,@region,@city,
       @state,@organization,@estimated_date,@deadline,@ts,'DISCOVERED','auto',@status,@est_value_low,@est_value_high,
       @zoe_categories,@verification_status,@confidence,@event_id,@procurement_id,'NONE',@recommended_action,@is_seed,@ts,@ts)`,
  ).run({ ...facts, id, dedupe_key: input.dedupeKey, ts });
  return toOpportunity(db.prepare("SELECT * FROM opportunities WHERE id = ?").get(id));
}

// ── Entities + edges ──────────────────────────────────────────────────────────────────────────────
export function upsertEntity(e: Omit<StoredEntity, "id"> & { id?: string }, now: Date = new Date()): StoredEntity {
  const db = getDb();
  const ts = now.toISOString();
  const found = e.id
    ? (db.prepare("SELECT id FROM radar_entities WHERE id = ?").get(e.id) as { id: string } | undefined)
    : (db.prepare("SELECT id FROM radar_entities WHERE lower(name) = lower(?) AND kind = ?").get(e.name, e.kind) as { id: string } | undefined);
  const id = found?.id ?? e.id ?? `ENT-${randomUUID()}`;
  if (found) {
    db.prepare("UPDATE radar_entities SET name=?, kind=?, website=?, email=?, phone=?, jurisdiction=?, verification_status=?, matched_customer_key=COALESCE(?, matched_customer_key), notes=?, is_seed=?, updated_at=? WHERE id=?")
      .run(e.name, e.kind, e.website, e.email, e.phone, e.jurisdiction, e.verificationStatus, e.matchedCustomerKey, e.notes, e.isSeed ? 1 : 0, ts, id);
  } else {
    db.prepare("INSERT INTO radar_entities (id, name, kind, website, email, phone, jurisdiction, verification_status, matched_customer_key, notes, is_seed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, e.name, e.kind, e.website, e.email, e.phone, e.jurisdiction, e.verificationStatus, e.matchedCustomerKey, e.notes, e.isSeed ? 1 : 0, ts, ts);
  }
  return toEntity(db.prepare("SELECT * FROM radar_entities WHERE id = ?").get(id));
}

export function linkEntity(opportunityId: string, entityId: string, relationship: RelationshipRole, opts: { isPrimaryTarget?: boolean; confidence?: number; evidence?: string } = {}, now: Date = new Date()): void {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM opportunity_entities WHERE opportunity_id=? AND entity_id=? AND relationship=?").get(opportunityId, entityId, relationship) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE opportunity_entities SET is_primary_target=?, confidence=?, evidence=? WHERE id=?")
      .run(opts.isPrimaryTarget ? 1 : 0, opts.confidence ?? null, opts.evidence ?? null, existing.id);
  } else {
    db.prepare("INSERT INTO opportunity_entities (id, opportunity_id, entity_id, relationship, is_primary_target, confidence, evidence, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(`OE-${randomUUID()}`, opportunityId, entityId, relationship, opts.isPrimaryTarget ? 1 : 0, opts.confidence ?? null, opts.evidence ?? null, now.toISOString());
  }
}

export function setPrimaryTarget(opportunityId: string, entityId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE opportunity_entities SET is_primary_target=0 WHERE opportunity_id=?").run(opportunityId);
    db.prepare("UPDATE opportunity_entities SET is_primary_target=1 WHERE opportunity_id=? AND entity_id=?").run(opportunityId, entityId);
  })();
}

// ── Lifecycle + handoff writes ────────────────────────────────────────────────────────────────────
export function setOpportunityStage(id: string, stage: LifecycleStage, now: Date = new Date()): boolean {
  const info = getDb().prepare("UPDATE opportunities SET stage=?, stage_source='manual', last_reviewed_at=?, updated_at=? WHERE id=?").run(stage, now.toISOString(), now.toISOString(), id);
  return info.changes > 0;
}

/** Cache the derived auto stage (only when the row is not under a manual override). Keeps the stored
 *  value roughly in sync for any query that reads it directly, without clobbering a human's stage. */
export function cacheAutoStage(id: string, stage: LifecycleStage): void {
  getDb().prepare("UPDATE opportunities SET stage=?, updated_at=updated_at WHERE id=? AND stage_source='auto'").run(stage, id);
}

/** Sales OS handoff — the opportunity stays the source record; this marks the bridge. Idempotent. */
export function createHandoff(id: string, opts: { bookingId?: string; nextAction?: string } = {}, now: Date = new Date()): StoredOpportunity | null {
  const db = getDb();
  const ts = now.toISOString();
  const opp = db.prepare("SELECT id FROM opportunities WHERE id=?").get(id);
  if (!opp) return null;
  db.prepare("UPDATE opportunities SET sales_status=?, booking_id=COALESCE(?, booking_id), stage=CASE WHEN stage_source='manual' THEN stage ELSE 'OPPORTUNITY' END, next_action_date=COALESCE(?, next_action_date), updated_at=? WHERE id=?")
    .run(opts.bookingId ? "LINKED" : "OPPORTUNITY_CREATED", opts.bookingId ?? null, opts.nextAction ?? null, ts, id);
  return getOpportunity(id);
}

export function setCampaign(opportunityId: string, campaignId: string | null): void {
  getDb().prepare("UPDATE opportunities SET campaign_id=? WHERE id=?").run(campaignId, opportunityId);
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────
export function getOpportunities(): StoredOpportunity[] {
  return (getDb().prepare("SELECT * FROM opportunities ORDER BY estimated_date IS NULL, estimated_date ASC").all() as any[]).map(toOpportunity);
}
export function getOpportunity(id: string): StoredOpportunity | null {
  const r = getDb().prepare("SELECT * FROM opportunities WHERE id = ?").get(id);
  return r ? toOpportunity(r) : null;
}
export function getOpportunityCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM opportunities").get() as { n: number }).n;
}
export function getOpportunityByDedupe(key: string): StoredOpportunity | null {
  const r = getDb().prepare("SELECT * FROM opportunities WHERE dedupe_key = ?").get(key);
  return r ? toOpportunity(r) : null;
}
export function getOpportunityByEvent(eventId: string): StoredOpportunity | null {
  const r = getDb().prepare("SELECT * FROM opportunities WHERE event_id = ?").get(eventId);
  return r ? toOpportunity(r) : null;
}
export function getEntity(id: string): StoredEntity | null {
  const r = getDb().prepare("SELECT * FROM radar_entities WHERE id = ?").get(id);
  return r ? toEntity(r) : null;
}
export interface EdgeWithEntity extends StoredEdge { entity: StoredEntity }
export function getEntitiesForOpportunity(opportunityId: string): EdgeWithEntity[] {
  const db = getDb();
  const edges = (db.prepare("SELECT * FROM opportunity_entities WHERE opportunity_id = ?").all(opportunityId) as any[]).map(toEdge);
  return edges
    .map((e) => { const ent = getEntity(e.entityId); return ent ? { ...e, entity: ent } : null; })
    .filter((x): x is EdgeWithEntity => x !== null);
}
export function getEntities(): StoredEntity[] {
  return (getDb().prepare("SELECT * FROM radar_entities ORDER BY name ASC").all() as any[]).map(toEntity);
}
/** Opportunities an entity is linked to (with the entity's role on each). */
export function getOpportunitiesForEntity(entityId: string): { opportunity: StoredOpportunity; relationship: RelationshipRole; isPrimaryTarget: boolean }[] {
  const db = getDb();
  const edges = db.prepare("SELECT opportunity_id, relationship, is_primary_target FROM opportunity_entities WHERE entity_id = ?").all(entityId) as any[];
  const out: { opportunity: StoredOpportunity; relationship: RelationshipRole; isPrimaryTarget: boolean }[] = [];
  for (const e of edges) {
    const opp = getOpportunity(e.opportunity_id);
    if (opp) out.push({ opportunity: opp, relationship: e.relationship as RelationshipRole, isPrimaryTarget: !!e.is_primary_target });
  }
  return out;
}
/** How many distinct opportunities each entity touches (for the companies list). */
export function getEntityOpportunityCounts(): Map<string, number> {
  const rows = getDb().prepare("SELECT entity_id, COUNT(DISTINCT opportunity_id) AS n FROM opportunity_entities GROUP BY entity_id").all() as { entity_id: string; n: number }[];
  return new Map(rows.map((r) => [r.entity_id, r.n]));
}

export function getCampaigns(): StoredCampaign[] {
  return (getDb().prepare("SELECT * FROM radar_campaigns ORDER BY created_at DESC").all() as any[]).map(toCampaign);
}
export function getCampaign(id: string): StoredCampaign | null {
  const r = getDb().prepare("SELECT * FROM radar_campaigns WHERE id = ?").get(id);
  return r ? toCampaign(r) : null;
}
export interface StoredProcurement {
  id: string; solicitationNumber: string | null; noticeType: string | null; agency: string | null; subAgency: string | null;
  jurisdiction: string | null; naics: string | null; psc: string | null; setAside: string | null; postedDate: string | null;
  responseDeadline: string | null; archiveDate: string | null; awardAmount: number | null; awardee: string | null; awardDate: string | null;
  city: string | null; state: string | null; sourceUrl: string | null;
}
/** Procurement satellite facts for an opportunity (solicitation #, notice type, award, deadlines). */
export function getProcurement(id: string | null): StoredProcurement | null {
  if (!id) return null;
  const r = getDb().prepare("SELECT * FROM radar_procurements WHERE id = ?").get(id) as any;
  if (!r) return null;
  return {
    id: r.id, solicitationNumber: r.solicitation_number ?? null, noticeType: r.notice_type ?? null, agency: r.agency ?? null, subAgency: r.sub_agency ?? null,
    jurisdiction: r.jurisdiction ?? null, naics: r.naics ?? null, psc: r.psc ?? null, setAside: r.set_aside ?? null, postedDate: r.posted_date ?? null,
    responseDeadline: r.response_deadline ?? null, archiveDate: r.archive_date ?? null, awardAmount: r.award_amount ?? null, awardee: r.awardee ?? null, awardDate: r.award_date ?? null,
    city: r.city ?? null, state: r.state ?? null, sourceUrl: r.source_url ?? null,
  };
}

export interface SourceRegistryRow {
  id: string; name: string; kind: string; url: string | null; region: string | null; enabled: boolean;
  acquisitionMethod: string | null; authStatus: string | null; frequency: string | null; adapter: string | null;
  lastRunAt: string | null; lastStatus: string | null; lastFailureAt: string | null; recordsDiscovered: number | null;
  parserVersion: string | null; isSeed: boolean;
}
/** The source registry (§14) for the management UI — includes the Opportunity Radar columns. */
export function getSourceRegistry(): SourceRegistryRow[] {
  return (getDb().prepare("SELECT * FROM radar_sources ORDER BY is_seed ASC, enabled DESC, name ASC").all() as any[]).map((r) => ({
    id: r.id, name: r.name, kind: r.kind, url: r.url ?? null, region: r.region ?? null, enabled: !!r.enabled,
    acquisitionMethod: r.acquisition_method ?? null, authStatus: r.auth_status ?? null, frequency: r.frequency ?? null, adapter: r.adapter ?? null,
    lastRunAt: r.last_run_at ?? null, lastStatus: r.last_status ?? null, lastFailureAt: r.last_failure_at ?? null,
    recordsDiscovered: r.records_discovered ?? null, parserVersion: r.parser_version ?? null, isSeed: !!r.is_seed,
  }));
}

export interface ChangeRow { ts: string; kind: string; field: string; from: string | null; to: string | null }
/** Change-detection history for one opportunity (from the shared history_changes log), newest first. */
export function getOpportunityChanges(dedupeKey: string): ChangeRow[] {
  return (getDb().prepare("SELECT ts, kind, field, from_value AS \"from\", to_value AS \"to\" FROM history_changes WHERE source='radar' AND entity='opportunity' AND entity_id=? ORDER BY ts DESC LIMIT 20").all(dedupeKey) as any[])
    .map((r) => ({ ts: r.ts, kind: r.kind, field: r.field, from: r.from ?? null, to: r.to ?? null }));
}

export function createCampaign(c: Omit<StoredCampaign, "id">, now: Date = new Date()): StoredCampaign {
  const id = `CMP-${randomUUID()}`;
  const ts = now.toISOString();
  getDb().prepare("INSERT INTO radar_campaigns (id, name, description, criteria, created_by, is_seed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, c.name, c.description, c.criteria ? JSON.stringify(c.criteria) : null, c.createdBy, c.isSeed ? 1 : 0, ts, ts);
  return getCampaign(id)!;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

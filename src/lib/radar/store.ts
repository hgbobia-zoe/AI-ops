// Event Radar — persistence + reads. FACTS ONLY (scores/tiers/timing are derived in service.ts, never
// stored). Upserts key off a stable identity so a re-pull updates in place, never duplicates:
// events by dedupe_key, orgs/series by id, planners by a natural key, sources by id.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { Attributes, EventCategory, EventStatus, SalesStatus, Verification, Confidence } from "./types";
import { normalizeRegion, type Region } from "./geo";

// ── Stored shapes ───────────────────────────────────────────────────────────────────────────────
export interface StoredEvent {
  id: string;
  dedupeKey: string;
  name: string;
  description: string | null;
  category: EventCategory;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  region: Region;
  sourceId: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  discoveredAt: string;
  lastVerifiedAt: string | null;
  verificationStatus: Verification;
  expectedAttendance: number | null;
  attendanceConfidence: Confidence;
  recurring: boolean;
  recurrenceConfidence: string | null;
  parentSeriesId: string | null;
  eventStatus: EventStatus;
  organizationId: string | null;
  plannerStatus: Verification;
  salesStatus: SalesStatus;
  attributes: Attributes;
  isSeed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredOrganization {
  id: string;
  name: string;
  website: string | null;
  orgType: string | null;
  verificationStatus: Verification;
  notes: string | null;
  isSeed: boolean;
}

export interface StoredSeries {
  id: string;
  name: string;
  organizationId: string | null;
  category: string | null;
  cadence: string | null;
  recurrenceConfidence: string | null;
  notes: string | null;
  isSeed: boolean;
}

export interface StoredPlanner {
  id: string;
  organizationId: string | null;
  eventId: string | null;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  agency: string | null;
  contactStatus: Verification;
  confidence: number | null;
  evidence: string | null;
  isSeed: boolean;
}

export interface StoredSource {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  region: string | null;
  enabled: boolean;
  adapter: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  isSeed: boolean;
}

export interface StoredOpportunity {
  id: string;
  eventId: string;
  status: "CREATED" | "LINKED" | "ARCHIVED";
  bookingId: string | null;
  nextAction: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Row → Stored converters ───────────────────────────────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
function toEvent(r: any): StoredEvent {
  return {
    id: r.id,
    dedupeKey: r.dedupe_key,
    name: r.name,
    description: r.description ?? null,
    category: r.category as EventCategory,
    startDate: r.start_date ?? null,
    endDate: r.end_date ?? null,
    venue: r.venue ?? null,
    address: r.address ?? null,
    city: r.city ?? null,
    state: r.state ?? null,
    region: (r.region as Region) ?? "UNKNOWN",
    sourceId: r.source_id ?? null,
    sourceName: r.source_name ?? null,
    sourceUrl: r.source_url ?? null,
    discoveredAt: r.discovered_at,
    lastVerifiedAt: r.last_verified_at ?? null,
    verificationStatus: r.verification_status as Verification,
    expectedAttendance: r.expected_attendance ?? null,
    attendanceConfidence: (r.attendance_confidence as Confidence) ?? "UNKNOWN",
    recurring: !!r.recurring,
    recurrenceConfidence: r.recurrence_confidence ?? null,
    parentSeriesId: r.parent_series_id ?? null,
    eventStatus: r.event_status as EventStatus,
    organizationId: r.organization_id ?? null,
    plannerStatus: r.planner_status as Verification,
    salesStatus: r.sales_status as SalesStatus,
    attributes: r.attributes_json ? (JSON.parse(r.attributes_json) as Attributes) : {},
    isSeed: !!r.is_seed,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function toOrg(r: any): StoredOrganization {
  return { id: r.id, name: r.name, website: r.website ?? null, orgType: r.org_type ?? null, verificationStatus: r.verification_status as Verification, notes: r.notes ?? null, isSeed: !!r.is_seed };
}
function toSeries(r: any): StoredSeries {
  return { id: r.id, name: r.name, organizationId: r.organization_id ?? null, category: r.category ?? null, cadence: r.cadence ?? null, recurrenceConfidence: r.recurrence_confidence ?? null, notes: r.notes ?? null, isSeed: !!r.is_seed };
}
function toPlanner(r: any): StoredPlanner {
  return { id: r.id, organizationId: r.organization_id ?? null, eventId: r.event_id ?? null, name: r.name, role: r.role ?? null, email: r.email ?? null, phone: r.phone ?? null, agency: r.agency ?? null, contactStatus: r.contact_status as Verification, confidence: r.confidence ?? null, evidence: r.evidence ?? null, isSeed: !!r.is_seed };
}
function toSource(r: any): StoredSource {
  return { id: r.id, name: r.name, kind: r.kind, url: r.url ?? null, region: r.region ?? null, enabled: !!r.enabled, adapter: r.adapter ?? null, lastRunAt: r.last_run_at ?? null, lastStatus: r.last_status ?? null, isSeed: !!r.is_seed };
}
function toOpportunity(r: any): StoredOpportunity {
  return { id: r.id, eventId: r.event_id, status: r.status, bookingId: r.booking_id ?? null, nextAction: r.next_action ?? null, note: r.note ?? null, createdBy: r.created_by ?? null, createdAt: r.created_at, updatedAt: r.updated_at };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Upserts (ingestion writes) ────────────────────────────────────────────────────────────────────
export interface EventInput {
  dedupeKey: string;
  name: string;
  description?: string | null;
  category: EventCategory;
  startDate?: string | null;
  endDate?: string | null;
  venue?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  sourceId?: string | null;
  sourceName?: string | null;
  sourceUrl?: string | null;
  verificationStatus: Verification;
  expectedAttendance?: number | null;
  attendanceConfidence?: Confidence;
  recurring?: boolean;
  recurrenceConfidence?: string | null;
  parentSeriesId?: string | null;
  organizationId?: string | null;
  plannerStatus?: Verification;
  attributes?: Attributes;
  isSeed?: boolean;
}

/** Insert or update an event by dedupe_key. Preserves lifecycle fields the pipeline shouldn't clobber
 *  (event_status, sales_status) on update — those advance through app actions, not re-ingestion. */
export function upsertEvent(input: EventInput, now: Date = new Date()): StoredEvent {
  const db = getDb();
  const ts = now.toISOString();
  const region = normalizeRegion({ city: input.city, state: input.state, address: input.address });
  const existing = db.prepare("SELECT * FROM radar_events WHERE dedupe_key = ?").get(input.dedupeKey) as Record<string, unknown> | undefined;

  const common = {
    name: input.name,
    description: input.description ?? null,
    category: input.category,
    start_date: input.startDate ?? null,
    end_date: input.endDate ?? null,
    venue: input.venue ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    region,
    source_id: input.sourceId ?? null,
    source_name: input.sourceName ?? null,
    source_url: input.sourceUrl ?? null,
    verification_status: input.verificationStatus,
    expected_attendance: input.expectedAttendance ?? null,
    attendance_confidence: input.attendanceConfidence ?? "UNKNOWN",
    recurring: input.recurring ? 1 : 0,
    recurrence_confidence: input.recurrenceConfidence ?? null,
    parent_series_id: input.parentSeriesId ?? null,
    organization_id: input.organizationId ?? null,
    planner_status: input.plannerStatus ?? "UNKNOWN",
    attributes_json: input.attributes ? JSON.stringify(input.attributes) : null,
    is_seed: input.isSeed ? 1 : 0,
  };

  if (existing) {
    db.prepare(
      `UPDATE radar_events SET name=@name, description=@description, category=@category, start_date=@start_date,
         end_date=@end_date, venue=@venue, address=@address, city=@city, state=@state, region=@region,
         source_id=@source_id, source_name=@source_name, source_url=@source_url, verification_status=@verification_status,
         expected_attendance=@expected_attendance, attendance_confidence=@attendance_confidence, recurring=@recurring,
         recurrence_confidence=@recurrence_confidence, parent_series_id=@parent_series_id, organization_id=@organization_id,
         planner_status=@planner_status, attributes_json=@attributes_json, is_seed=@is_seed, last_verified_at=@ts, updated_at=@ts
       WHERE dedupe_key=@dedupe_key`,
    ).run({ ...common, dedupe_key: input.dedupeKey, ts });
    return toEvent(db.prepare("SELECT * FROM radar_events WHERE dedupe_key = ?").get(input.dedupeKey));
  }

  const id = `EV-${randomUUID()}`;
  db.prepare(
    `INSERT INTO radar_events (id, dedupe_key, name, description, category, start_date, end_date, venue, address, city,
       state, region, source_id, source_name, source_url, discovered_at, last_verified_at, verification_status,
       expected_attendance, attendance_confidence, recurring, recurrence_confidence, parent_series_id, event_status,
       organization_id, planner_status, sales_status, attributes_json, is_seed, created_at, updated_at)
     VALUES (@id,@dedupe_key,@name,@description,@category,@start_date,@end_date,@venue,@address,@city,@state,@region,
       @source_id,@source_name,@source_url,@ts,@ts,@verification_status,@expected_attendance,@attendance_confidence,
       @recurring,@recurrence_confidence,@parent_series_id,'DETECTED',@organization_id,@planner_status,'NONE',
       @attributes_json,@is_seed,@ts,@ts)`,
  ).run({ ...common, id, dedupe_key: input.dedupeKey, ts });
  return toEvent(db.prepare("SELECT * FROM radar_events WHERE id = ?").get(id));
}

export function upsertOrganization(o: Omit<StoredOrganization, "id"> & { id?: string }, now: Date = new Date()): StoredOrganization {
  const db = getDb();
  const ts = now.toISOString();
  const id = o.id ?? `ORG-${randomUUID()}`;
  const existing = db.prepare("SELECT id FROM radar_organizations WHERE id = ?").get(id);
  if (existing) {
    db.prepare("UPDATE radar_organizations SET name=?, website=?, org_type=?, verification_status=?, notes=?, is_seed=?, updated_at=? WHERE id=?")
      .run(o.name, o.website, o.orgType, o.verificationStatus, o.notes, o.isSeed ? 1 : 0, ts, id);
  } else {
    db.prepare("INSERT INTO radar_organizations (id, name, website, org_type, verification_status, notes, is_seed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, o.name, o.website, o.orgType, o.verificationStatus, o.notes, o.isSeed ? 1 : 0, ts, ts);
  }
  return toOrg(db.prepare("SELECT * FROM radar_organizations WHERE id = ?").get(id));
}

export function upsertSeries(s: Omit<StoredSeries, "id"> & { id?: string }, now: Date = new Date()): StoredSeries {
  const db = getDb();
  const ts = now.toISOString();
  const id = s.id ?? `SER-${randomUUID()}`;
  const existing = db.prepare("SELECT id FROM radar_series WHERE id = ?").get(id);
  if (existing) {
    db.prepare("UPDATE radar_series SET name=?, organization_id=?, category=?, cadence=?, recurrence_confidence=?, notes=?, is_seed=?, updated_at=? WHERE id=?")
      .run(s.name, s.organizationId, s.category, s.cadence, s.recurrenceConfidence, s.notes, s.isSeed ? 1 : 0, ts, id);
  } else {
    db.prepare("INSERT INTO radar_series (id, name, organization_id, category, cadence, recurrence_confidence, notes, is_seed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, s.name, s.organizationId, s.category, s.cadence, s.recurrenceConfidence, s.notes, s.isSeed ? 1 : 0, ts, ts);
  }
  return toSeries(db.prepare("SELECT * FROM radar_series WHERE id = ?").get(id));
}

/** Upsert a planner by (event_id|org_id, name) so a re-pull doesn't duplicate the same person. */
export function upsertPlanner(p: Omit<StoredPlanner, "id"> & { id?: string }, now: Date = new Date()): StoredPlanner {
  const db = getDb();
  const ts = now.toISOString();
  const found = p.id
    ? (db.prepare("SELECT id FROM radar_planners WHERE id = ?").get(p.id) as { id: string } | undefined)
    : (db.prepare("SELECT id FROM radar_planners WHERE name = ? AND IFNULL(event_id,'')=? AND IFNULL(organization_id,'')=?").get(p.name, p.eventId ?? "", p.organizationId ?? "") as { id: string } | undefined);
  const id = found?.id ?? p.id ?? `PLN-${randomUUID()}`;
  if (found) {
    db.prepare("UPDATE radar_planners SET organization_id=?, event_id=?, name=?, role=?, email=?, phone=?, agency=?, contact_status=?, confidence=?, evidence=?, is_seed=?, updated_at=? WHERE id=?")
      .run(p.organizationId, p.eventId, p.name, p.role, p.email, p.phone, p.agency, p.contactStatus, p.confidence, p.evidence, p.isSeed ? 1 : 0, ts, id);
  } else {
    db.prepare("INSERT INTO radar_planners (id, organization_id, event_id, name, role, email, phone, agency, contact_status, confidence, evidence, is_seed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, p.organizationId, p.eventId, p.name, p.role, p.email, p.phone, p.agency, p.contactStatus, p.confidence, p.evidence, p.isSeed ? 1 : 0, ts, ts);
  }
  // Keep the event's planner_status in sync (best known contact wins: VERIFIED > INFERRED > UNKNOWN).
  if (p.eventId) syncPlannerStatus(p.eventId);
  return toPlanner(db.prepare("SELECT * FROM radar_planners WHERE id = ?").get(id));
}

function syncPlannerStatus(eventId: string): void {
  const db = getDb();
  const rows = db.prepare("SELECT contact_status FROM radar_planners WHERE event_id = ?").all(eventId) as { contact_status: string }[];
  const rank: Record<string, number> = { VERIFIED: 3, INFERRED: 2, UNKNOWN: 1 };
  let best = "UNKNOWN";
  for (const r of rows) if ((rank[r.contact_status] ?? 0) > (rank[best] ?? 0)) best = r.contact_status;
  db.prepare("UPDATE radar_events SET planner_status=? WHERE id=?").run(best, eventId);
}

export function upsertSource(s: Omit<StoredSource, "lastRunAt" | "lastStatus"> & { lastRunAt?: string | null; lastStatus?: string | null }, now: Date = new Date()): StoredSource {
  const db = getDb();
  const ts = now.toISOString();
  const existing = db.prepare("SELECT id FROM radar_sources WHERE id = ?").get(s.id);
  if (existing) {
    db.prepare("UPDATE radar_sources SET name=?, kind=?, url=?, region=?, enabled=?, adapter=?, is_seed=? WHERE id=?")
      .run(s.name, s.kind, s.url, s.region, s.enabled ? 1 : 0, s.adapter, s.isSeed ? 1 : 0, s.id);
  } else {
    db.prepare("INSERT INTO radar_sources (id, name, kind, url, region, enabled, adapter, last_status, is_seed, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(s.id, s.name, s.kind, s.url, s.region, s.enabled ? 1 : 0, s.adapter, "NEVER_RUN", s.isSeed ? 1 : 0, ts);
  }
  return toSource(db.prepare("SELECT * FROM radar_sources WHERE id = ?").get(s.id));
}

export function markSourceRun(id: string, status: "OK" | "ERROR", now: Date = new Date()): void {
  getDb().prepare("UPDATE radar_sources SET last_run_at=?, last_status=? WHERE id=?").run(now.toISOString(), status, id);
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────
export function getEvents(): StoredEvent[] {
  return (getDb().prepare("SELECT * FROM radar_events ORDER BY start_date IS NULL, start_date ASC").all() as unknown[]).map(toEvent);
}
export function getEvent(id: string): StoredEvent | null {
  const r = getDb().prepare("SELECT * FROM radar_events WHERE id = ?").get(id);
  return r ? toEvent(r) : null;
}
export function getEventCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM radar_events").get() as { n: number }).n;
}
export function getOrganization(id: string | null): StoredOrganization | null {
  if (!id) return null;
  const r = getDb().prepare("SELECT * FROM radar_organizations WHERE id = ?").get(id);
  return r ? toOrg(r) : null;
}
export function getSeries(id: string | null): StoredSeries | null {
  if (!id) return null;
  const r = getDb().prepare("SELECT * FROM radar_series WHERE id = ?").get(id);
  return r ? toSeries(r) : null;
}
export function getSeriesInstances(seriesId: string): StoredEvent[] {
  return (getDb().prepare("SELECT * FROM radar_events WHERE parent_series_id = ? ORDER BY start_date ASC").all(seriesId) as unknown[]).map(toEvent);
}
export function getPlannersForEvent(eventId: string, organizationId: string | null): StoredPlanner[] {
  const db = getDb();
  const rows = organizationId
    ? db.prepare("SELECT * FROM radar_planners WHERE event_id = ? OR organization_id = ?").all(eventId, organizationId)
    : db.prepare("SELECT * FROM radar_planners WHERE event_id = ?").all(eventId);
  return (rows as unknown[]).map(toPlanner);
}
export function getSources(): StoredSource[] {
  return (getDb().prepare("SELECT * FROM radar_sources ORDER BY name ASC").all() as unknown[]).map(toSource);
}
export function getOpportunityForEvent(eventId: string): StoredOpportunity | null {
  const r = getDb().prepare("SELECT * FROM radar_opportunities WHERE event_id = ?").get(eventId);
  return r ? toOpportunity(r) : null;
}

// ── Lifecycle / handoff writes ────────────────────────────────────────────────────────────────────
export function setEventStatus(eventId: string, status: EventStatus): boolean {
  const info = getDb().prepare("UPDATE radar_events SET event_status=?, updated_at=? WHERE id=?").run(status, new Date().toISOString(), eventId);
  return info.changes > 0;
}

/** Create the Sales OS handoff for an event (or return the existing one). The event stays the source
 *  record; this is the bridge. Advances the event to HANDED_OFF and sales_status. Idempotent per event. */
export function createOpportunity(eventId: string, opts: { note?: string; nextAction?: string; bookingId?: string; createdBy?: string } = {}, now: Date = new Date()): StoredOpportunity {
  const db = getDb();
  const ts = now.toISOString();
  const existing = getOpportunityForEvent(eventId);
  const status = opts.bookingId ? "LINKED" : "CREATED";
  if (existing) {
    db.prepare("UPDATE radar_opportunities SET status=?, booking_id=COALESCE(?, booking_id), next_action=COALESCE(?, next_action), note=COALESCE(?, note), updated_at=? WHERE event_id=?")
      .run(status, opts.bookingId ?? null, opts.nextAction ?? null, opts.note ?? null, ts, eventId);
  } else {
    db.prepare("INSERT INTO radar_opportunities (id, event_id, status, booking_id, next_action, note, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(`OPP-${randomUUID()}`, eventId, status, opts.bookingId ?? null, opts.nextAction ?? null, opts.note ?? null, opts.createdBy ?? null, ts, ts);
  }
  db.prepare("UPDATE radar_events SET sales_status=?, event_status='HANDED_OFF', updated_at=? WHERE id=?")
    .run(opts.bookingId ? "LINKED" : "OPPORTUNITY_CREATED", ts, eventId);
  return getOpportunityForEvent(eventId)!;
}

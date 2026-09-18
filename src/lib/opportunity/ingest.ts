// Opportunity Radar — ingestion architecture. A source is anything that can acquire() raw opportunity
// records; the pipeline normalizes → classifies → deduplicates → detects change → stores. Each stage is
// independently replaceable, so an API client, a browser-agent feed, or a manual upload all plug in as
// the same OpportunitySource. Scoring/maturity/lifecycle are NOT done here — they're derived at read
// time (service.ts). AI's only allowed role inside an adapter is INTERPRETATION, never fabrication.
//
//   OpportunitySource.acquire() → normalize() → classify() → deduplicate() → detectChange() → store()

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { normalizeRegion } from "@/lib/radar/geo";
import { classifyZoeCategories, roleForEntityKind, pickPrimaryTargetRole } from "./classify";
import { normalizeJurisdiction } from "./jurisdiction";
import { upsertOpportunity, upsertEntity, linkEntity, setPrimaryTarget, getOpportunityByDedupe, type OpportunityInput } from "./store";
import { enrichEntityMatches } from "./relationship";
import { emitOpportunityAlerts, type AlertItem } from "./alerts";
import type { Confidence, EntityKind, OpportunityKind, RelationshipRole, Verification, ZoeCategory } from "./types";

// A raw record as an adapter emits it (loose — sources vary).
export interface RawOpportunity {
  externalId?: string;
  kind: OpportunityKind;
  name: string;
  description?: string;
  sourceUrl?: string;
  agency?: string;
  city?: string;
  state?: string;
  expectedAttendance?: number | null;
  attendanceConfidence?: Confidence;
  estimatedDate?: string | null; // YYYY-MM-DD
  deadline?: string | null; // YYYY-MM-DD
  status?: string;
  verificationStatus?: Verification;
  // Hard value when the source states one (contract ceiling / award). Indicative value is derived.
  valueLow?: number | null;
  valueHigh?: number | null;
  zoeCategoriesHint?: ZoeCategory[];
  // Procurement-specific facts (satellite row created when kind=PROCUREMENT).
  procurement?: {
    solicitationNumber?: string;
    noticeType?: string;
    naics?: string;
    psc?: string;
    setAside?: string;
    postedDate?: string;
    responseDeadline?: string;
    awardAmount?: number;
    awardee?: string;
    awardDate?: string;
  };
  entities?: { name: string; kind: EntityKind; role?: RelationshipRole; website?: string; email?: string; phone?: string; isPrimaryTarget?: boolean; confidence?: number; evidence?: string }[];
}

export interface OpportunitySource {
  id: string;
  name: string;
  kind: string; // source kind (registry), e.g. FEDERAL_API, COUNTY_PORTAL
  acquisitionMethod: "API" | "BROWSER" | "MANUAL";
  adapter: string;
  region?: string;
  isSeed?: boolean;
  acquire(): Promise<RawOpportunity[]> | RawOpportunity[];
}

export interface IngestResult {
  sourceId: string;
  acquired: number;
  stored: number;
  duplicatesCollapsed: number;
  changes: number;
  alertsPosted: number;
  errors: string[];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export function dedupeKeyFor(sourceId: string, r: RawOpportunity): string {
  if (r.externalId) return `${sourceId}:${r.externalId}`;
  return `${sourceId}:${slug(`${r.name}-${r.estimatedDate ?? r.deadline ?? "tbd"}-${r.city ?? ""}`)}`;
}

// Fields worth alerting on when they change on a re-pull (§16).
const WATCHED: (keyof RawOpportunity)[] = ["status", "deadline", "estimatedDate"];

/** Append an idempotent change row (reuses history_changes) and return a human label, or null. */
function detectAndLogChanges(dedupeKey: string, existing: { deadline: string | null; status: string | null; estimatedDate: string | null } | null, r: RawOpportunity, now: Date): string[] {
  if (!existing) return [];
  const db = getDb();
  const ts = now.toISOString();
  const prev: Record<string, string | null> = { status: existing.status, deadline: existing.deadline, estimatedDate: existing.estimatedDate };
  const next: Record<string, string | null> = { status: r.status ?? null, deadline: r.deadline ?? null, estimatedDate: r.estimatedDate ?? null };
  const labels: string[] = [];
  const insert = db.prepare("INSERT OR IGNORE INTO history_changes (id, ts, source, entity, entity_id, kind, field, from_value, to_value, change_key) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const f of WATCHED) {
    const key = f as string;
    if ((prev[key] ?? "") !== (next[key] ?? "")) {
      const changeKey = `opp:${dedupeKey}:${key}:${next[key] ?? ""}`;
      insert.run(`HC-${randomUUID()}`, ts, "radar", "opportunity", dedupeKey, "opportunity_changed", key, prev[key], next[key], changeKey);
      labels.push(`${key}: ${prev[key] ?? "—"} → ${next[key] ?? "—"}`);
    }
  }
  // Award = a special, high-value change (a new contractor may now be a Zoe partner/customer).
  if (r.procurement?.awardee) {
    const changeKey = `opp:${dedupeKey}:award:${slug(r.procurement.awardee)}`;
    const info = insert.run(`HC-${randomUUID()}`, ts, "radar", "opportunity", dedupeKey, "opportunity_awarded", "awardee", null, r.procurement.awardee, changeKey);
    if (info.changes > 0) labels.push(`awarded to ${r.procurement.awardee}`);
  }
  return labels;
}

function storeProcurement(r: RawOpportunity, dedupeKey: string, sourceId: string, jurisdiction: string, isSeed: boolean, now: Date): string | null {
  if (r.kind !== "PROCUREMENT" || !r.procurement) return null;
  const db = getDb();
  const ts = now.toISOString();
  const p = r.procurement;
  const id = `PRC-${slug(dedupeKey)}`;
  db.prepare(
    `INSERT INTO radar_procurements (id, dedupe_key, solicitation_number, notice_type, title, description, agency, jurisdiction,
       naics, psc, set_aside, posted_date, response_deadline, award_amount, awardee, award_date, city, state, source_id, source_url, is_seed, discovered_at, updated_at)
     VALUES (@id,@dedupe_key,@sol,@notice,@title,@desc,@agency,@jur,@naics,@psc,@setaside,@posted,@deadline,@award,@awardee,@awarddate,@city,@state,@source,@url,@seed,@ts,@ts)
     ON CONFLICT(dedupe_key) DO UPDATE SET notice_type=@notice, response_deadline=@deadline, award_amount=@award, awardee=@awardee, award_date=@awarddate, updated_at=@ts`,
  ).run({
    id, dedupe_key: dedupeKey, sol: p.solicitationNumber ?? null, notice: p.noticeType ?? null, title: r.name, desc: r.description ?? null,
    agency: r.agency ?? null, jur: jurisdiction, naics: p.naics ?? null, psc: p.psc ?? null, setaside: p.setAside ?? null,
    posted: p.postedDate ?? null, deadline: p.responseDeadline ?? r.deadline ?? null, award: p.awardAmount ?? null, awardee: p.awardee ?? null,
    awarddate: p.awardDate ?? null, city: r.city ?? null, state: r.state ?? null, source: sourceId, url: r.sourceUrl ?? null, seed: isSeed ? 1 : 0, ts,
  } as Record<string, unknown>);
  return id;
}

interface StoreOutcome { changes: string[]; opportunityId: string; isNew: boolean; awardee: string | null }

function normalizeAndStore(source: OpportunitySource, raw: RawOpportunity, now: Date): StoreOutcome {
  const dedupeKey = dedupeKeyFor(source.id, raw);
  const region = normalizeRegion({ city: raw.city, state: raw.state, address: raw.name });
  const jurisdiction = normalizeJurisdiction({ agency: raw.agency, text: `${raw.name} ${raw.description ?? ""}`, region });
  const zoeCategories = raw.zoeCategoriesHint ?? classifyZoeCategories(`${raw.name} ${raw.description ?? ""}`);

  const existing = getOpportunityByDedupe(dedupeKey);
  const changes = detectAndLogChanges(dedupeKey, existing ? { deadline: existing.deadline, status: existing.status, estimatedDate: existing.estimatedDate } : null, raw, now);

  const procurementId = storeProcurement(raw, dedupeKey, source.id, jurisdiction, !!source.isSeed, now);

  const input: OpportunityInput = {
    dedupeKey,
    kind: raw.kind,
    name: raw.name,
    description: raw.description ?? null,
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: raw.sourceUrl ?? null,
    jurisdiction,
    region,
    city: raw.city ?? null,
    state: raw.state ?? null,
    organization: raw.agency ?? null,
    expectedAttendance: raw.expectedAttendance ?? null,
    attendanceConfidence: raw.attendanceConfidence ?? (raw.expectedAttendance != null ? "INFERRED" : "UNKNOWN"),
    estimatedDate: raw.estimatedDate ?? null,
    deadline: raw.deadline ?? raw.procurement?.responseDeadline ?? null,
    status: raw.status ?? null,
    estValueLow: raw.valueLow ?? raw.procurement?.awardAmount ?? null,
    estValueHigh: raw.valueHigh ?? raw.procurement?.awardAmount ?? null,
    zoeCategories,
    verificationStatus: raw.verificationStatus ?? "NOT_YET_VERIFIED",
    procurementId,
    isSeed: !!source.isSeed,
  };
  const opp = upsertOpportunity(input, now);

  // Entities → graph nodes + edges, then pick the primary target deterministically.
  const roles: RelationshipRole[] = [];
  for (const e of raw.entities ?? []) {
    const ent = upsertEntity({ name: e.name, kind: e.kind, website: e.website ?? null, email: e.email ?? null, phone: e.phone ?? null, jurisdiction: null, verificationStatus: "INFERRED", matchedCustomerKey: null, notes: null, isSeed: !!source.isSeed }, now);
    const role = e.role ?? roleForEntityKind(e.kind);
    roles.push(role);
    linkEntity(opp.id, ent.id, role, { isPrimaryTarget: e.isPrimaryTarget, confidence: e.confidence, evidence: e.evidence }, now);
  }
  if (roles.length > 0 && !(raw.entities ?? []).some((e) => e.isPrimaryTarget)) {
    const best = pickPrimaryTargetRole(roles);
    if (best) {
      const edge = getDb().prepare("SELECT entity_id FROM opportunity_entities WHERE opportunity_id=? AND relationship=? LIMIT 1").get(opp.id, best) as { entity_id: string } | undefined;
      if (edge) setPrimaryTarget(opp.id, edge.entity_id);
    }
  }

  return { changes, opportunityId: opp.id, isNew: !existing, awardee: raw.procurement?.awardee ?? null };
}

/** Run one source through the full pipeline. Per-record errors are isolated. */
export async function runOpportunitySource(source: OpportunitySource, now: Date = new Date()): Promise<IngestResult> {
  const result: IngestResult = { sourceId: source.id, acquired: 0, stored: 0, duplicatesCollapsed: 0, changes: 0, alertsPosted: 0, errors: [] };
  const db = getDb();
  try {
    const raw = await source.acquire();
    result.acquired = raw.length;
    const byKey = new Map<string, RawOpportunity>();
    for (const r of raw) {
      const key = dedupeKeyFor(source.id, r);
      if (byKey.has(key)) result.duplicatesCollapsed++;
      byKey.set(key, r);
    }
    const alertItems: AlertItem[] = [];
    for (const r of byKey.values()) {
      try {
        const out = normalizeAndStore(source, r, now);
        result.stored++;
        result.changes += out.changes.length;
        alertItems.push({ opportunityId: out.opportunityId, isNew: out.isNew, changeLabels: out.changes, awardee: out.awardee });
      } catch (e) {
        result.errors.push(`${r.name}: ${(e as Error).message}`);
      }
    }
    db.prepare("UPDATE radar_sources SET last_run_at=?, last_status=?, records_discovered=?, last_failure_at=CASE WHEN ?='ERROR' THEN ? ELSE last_failure_at END WHERE id=?")
      .run(now.toISOString(), result.errors.length ? "ERROR" : "OK", result.stored, result.errors.length ? "ERROR" : "OK", now.toISOString(), source.id);

    // Enrich entity → Zoe-customer matches, then emit meaningful-only alerts for what we just stored.
    try { enrichEntityMatches(); } catch { /* non-fatal */ }
    try { result.alertsPosted = await emitOpportunityAlerts(alertItems, now); } catch { /* non-fatal */ }
  } catch (e) {
    result.errors.push(`acquire failed: ${(e as Error).message}`);
    db.prepare("UPDATE radar_sources SET last_run_at=?, last_status='ERROR', last_failure_at=? WHERE id=?").run(now.toISOString(), now.toISOString(), source.id);
  }
  return result;
}

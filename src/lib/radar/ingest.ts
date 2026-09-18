// Event Radar — ingestion architecture. The MVP proves the WORKFLOW, not internet-scale scraping.
// A source is anything that can discover() raw event records; the pipeline normalizes → deduplicates →
// verifies → stores them. Each stage is independently replaceable, so a real venue-calendar fetcher,
// a directory scraper, or an AI page-extractor can be added as a new EventSource without touching the
// rest. Scoring/timing are NOT done here — they're derived at read time (service.ts).
//
//   EventSource.discover() → normalize() → deduplicate() → verify() → store()
//
// AI's allowed role (per the design law) is INTERPRETATION inside a source's discover()/normalize()
// (e.g. extract fields from a messy page), never fabrication and never the score.

import {
  upsertEvent,
  upsertOrganization,
  upsertSeries,
  upsertPlanner,
  markSourceRun,
  type EventInput,
} from "./store";
import { CATEGORY_LABEL, type Attributes, type Confidence, type EventCategory, type Verification } from "./types";

/** A raw record as a source emits it, before normalization. Loose on purpose — sources vary. */
export interface RawEventRecord {
  externalId?: string; // stable id within the source, if it has one
  name: string;
  description?: string;
  category?: string; // free-form; normalized to EventCategory
  startDate?: string | null; // YYYY-MM-DD
  endDate?: string | null;
  venue?: string;
  address?: string;
  city?: string;
  state?: string;
  sourceUrl?: string;
  expectedAttendance?: number | null;
  attendanceConfidence?: Confidence;
  recurring?: boolean;
  attributes?: Attributes;
  /** Provenance of the event's core facts. Defaults to NOT_YET_VERIFIED. */
  verificationStatus?: Verification;
  /** The org behind the event (deduped by name). */
  organization?: { name: string; website?: string; orgType?: string; verificationStatus?: Verification; notes?: string };
  /** Recurring-series membership (deduped by key). */
  series?: { key: string; name: string; cadence?: string; recurrenceConfidence?: string; notes?: string };
  /** Known planners/contacts. NEVER invented — a source includes one only when it has a real name. */
  planners?: { name: string; role?: string; email?: string; phone?: string; agency?: string; contactStatus: Verification; confidence?: number; evidence?: string }[];
}

export interface EventSource {
  id: string;
  name: string;
  kind: string;
  region?: string;
  adapter: string;
  isSeed?: boolean;
  discover(): Promise<RawEventRecord[]> | RawEventRecord[];
}

export interface IngestResult {
  sourceId: string;
  discovered: number;
  stored: number;
  duplicatesCollapsed: number;
  errors: string[];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

// ── normalize ──────────────────────────────────────────────────────────────────────────────────
const CATEGORY_KEYS = Object.keys(CATEGORY_LABEL) as EventCategory[];

/** Map a free-form category string to a canonical EventCategory (OTHER when unrecognized). */
export function normalizeCategory(raw?: string): EventCategory {
  if (!raw) return "OTHER";
  const up = raw.trim().toUpperCase().replace(/\s+/g, "_");
  if ((CATEGORY_KEYS as string[]).includes(up)) return up as EventCategory;
  const hay = raw.toLowerCase();
  if (/trade\s*show/.test(hay)) return "TRADE_SHOW";
  if (/expo/.test(hay)) return "EXPO";
  if (/gala/.test(hay)) return "GALA";
  if (/fundrais|benefit/.test(hay)) return "FUNDRAISER";
  if (/medical|clinical|health|surgeon|physician/.test(hay)) return "MEDICAL";
  if (/award/.test(hay)) return "AWARDS";
  if (/network/.test(hay)) return "NETWORKING";
  if (/associ|society|chapter|annual meeting/.test(hay)) return "ASSOCIATION_MEETING";
  if (/university|college|campus|alumni/.test(hay)) return "UNIVERSITY";
  if (/gov|federal|agency|municipal/.test(hay)) return "GOVERNMENT";
  if (/nonprofit|charity|foundation/.test(hay)) return "NONPROFIT";
  if (/reception|outdoor/.test(hay)) return "OUTDOOR_RECEPTION";
  if (/hospitality/.test(hay)) return "HOSPITALITY";
  if (/corp|company|client/.test(hay)) return "CORPORATE";
  if (/conf|summit|symposium|forum|convention/.test(hay)) return "CONFERENCE";
  return "OTHER";
}

/** Deterministic dedupe identity: the source's externalId when present, else a slug of the event's
 *  distinguishing facts. Same event across re-pulls → same key → updated in place. */
export function dedupeKeyFor(sourceId: string, r: RawEventRecord): string {
  if (r.externalId) return `${sourceId}:${r.externalId}`;
  return `${sourceId}:${slug(`${r.name}-${r.startDate ?? "tbd"}-${r.city ?? ""}`)}`;
}

interface Normalized {
  input: EventInput;
  organization?: RawEventRecord["organization"];
  organizationId?: string;
  series?: RawEventRecord["series"];
  seriesId?: string;
  planners?: RawEventRecord["planners"];
}

function normalize(source: EventSource, r: RawEventRecord): Normalized {
  const dedupeKey = dedupeKeyFor(source.id, r);
  const organizationId = r.organization ? `ORG-${slug(r.organization.name)}` : undefined;
  const seriesId = r.series ? `SER-${slug(r.series.key)}` : undefined;
  const input: EventInput = {
    dedupeKey,
    name: r.name.trim(),
    description: r.description ?? null,
    category: normalizeCategory(r.category),
    startDate: r.startDate ?? null,
    endDate: r.endDate ?? null,
    venue: r.venue ?? null,
    address: r.address ?? null,
    city: r.city ?? null,
    state: r.state ?? null,
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: r.sourceUrl ?? null,
    verificationStatus: r.verificationStatus ?? "NOT_YET_VERIFIED",
    expectedAttendance: r.expectedAttendance ?? null,
    attendanceConfidence: r.attendanceConfidence ?? (r.expectedAttendance != null ? "INFERRED" : "UNKNOWN"),
    recurring: r.recurring ?? !!r.series,
    recurrenceConfidence: r.series?.recurrenceConfidence ?? null,
    parentSeriesId: seriesId ?? null,
    organizationId: organizationId ?? null,
    attributes: r.attributes,
    isSeed: !!source.isSeed,
  };
  return { input, organization: r.organization, organizationId, series: r.series, seriesId, planners: r.planners };
}

/** verify() hook — placeholder for a re-check against the live source. In the MVP it's a pass-through
 *  (the record keeps its source-declared verificationStatus). A real implementation would re-fetch and
 *  bump NOT_YET_VERIFIED → VERIFIED / INFERRED. */
function verify(n: Normalized): Normalized {
  return n;
}

// ── store ──────────────────────────────────────────────────────────────────────────────────────
function storeNormalized(n: Normalized, isSeed: boolean, now: Date): void {
  if (n.organization && n.organizationId) {
    upsertOrganization(
      {
        id: n.organizationId,
        name: n.organization.name,
        website: n.organization.website ?? null,
        orgType: n.organization.orgType ?? null,
        verificationStatus: n.organization.verificationStatus ?? "INFERRED",
        notes: n.organization.notes ?? null,
        isSeed,
      },
      now,
    );
  }
  if (n.series && n.seriesId) {
    upsertSeries(
      {
        id: n.seriesId,
        name: n.series.name,
        organizationId: n.organizationId ?? null,
        category: n.input.category,
        cadence: n.series.cadence ?? null,
        recurrenceConfidence: n.series.recurrenceConfidence ?? null,
        notes: n.series.notes ?? null,
        isSeed,
      },
      now,
    );
  }
  const event = upsertEvent(n.input, now);
  for (const p of n.planners ?? []) {
    upsertPlanner(
      {
        organizationId: n.organizationId ?? null,
        eventId: event.id,
        name: p.name,
        role: p.role ?? null,
        email: p.email ?? null,
        phone: p.phone ?? null,
        agency: p.agency ?? null,
        contactStatus: p.contactStatus,
        confidence: p.confidence ?? null,
        evidence: p.evidence ?? null,
        isSeed,
      },
      now,
    );
  }
}

/** Run one source through the full pipeline. Errors are collected per-record so one bad record never
 *  fails the whole pull. */
export async function runSource(source: EventSource, now: Date = new Date()): Promise<IngestResult> {
  const result: IngestResult = { sourceId: source.id, discovered: 0, stored: 0, duplicatesCollapsed: 0, errors: [] };
  try {
    const raw = await source.discover();
    result.discovered = raw.length;

    // deduplicate within the batch by dedupe key (last write wins).
    const byKey = new Map<string, RawEventRecord>();
    for (const r of raw) {
      const key = dedupeKeyFor(source.id, r);
      if (byKey.has(key)) result.duplicatesCollapsed++;
      byKey.set(key, r);
    }

    for (const r of byKey.values()) {
      try {
        storeNormalized(verify(normalize(source, r)), !!source.isSeed, now);
        result.stored++;
      } catch (e) {
        result.errors.push(`${r.name}: ${(e as Error).message}`);
      }
    }
    markSourceRun(source.id, result.errors.length ? "ERROR" : "OK", now);
  } catch (e) {
    result.errors.push(`discover failed: ${(e as Error).message}`);
    markSourceRun(source.id, "ERROR", now);
  }
  return result;
}

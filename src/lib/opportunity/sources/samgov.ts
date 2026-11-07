// Opportunity Radar — SAM.gov connector (federal solicitations). Acquisition method: API.
//
// DORMANT until SAM_API_KEY is set: with no key acquire() returns [] and the source shows
// auth_status=REQUIRED_MISSING. Free key from sam.gov → Account Details → Public API Key.
// Docs: https://open.gsa.gov/api/get-opportunities-public-api/ (GET /opportunities/v2/search).
//
// Quota: a key without a federal/entity role gets about 10 calls a DAY, so this pulls per DMV state
// (place of performance) incrementally: each state keeps a cursor (postedFrom date + page offset) in kv,
// and a run spends at most RADAR_SAM_MAX_CALLS calls (default 3, one per state). An unfinished state
// resumes next run. Errors are recorded (kv radar.sam.lastRun) and surfaced, never swallowed silently;
// the API key never appears in an error message.
//
// Only deterministic mapping happens here. The `description` field in v2 is a URL, not text, so the
// relevance gate reads the title plus the NAICS / PSC codes.

import { isEventRelevant } from "../classify";
import type { OpportunitySource, RawOpportunity } from "../ingest";
import type { EntityKind, RelationshipRole } from "../types";
import { getJson, setJson } from "@/lib/kv";

export const SAM_STATES = ["MD", "DC", "VA"] as const;
const DMV_STATES = new Set<string>(SAM_STATES);
const SAM_URL = "https://api.sam.gov/opportunities/v2/search";
const PAGE_LIMIT = 1000; // the API maximum

// Codes that mean "this is our kind of work" even when the title says nothing about events.
export const RELEVANT_NAICS = new Set([
  "532289", // all other consumer goods rental (party / event rental)
  "532310", // general rental centers
  "532490", // other commercial and industrial equipment rental
  "561920", // convention and trade show organizers
  "711310", // promoters of performing arts, sports and similar events with facilities
  "711320", // promoters without facilities
  "314910", // textile bag and canvas mills (tents)
]);
const RELEVANT_PSC_PREFIXES = ["8340", "7105", "7110", "7195", "W071", "W083"]; // tents, furniture, rental of furniture / textiles

function mapNoticeType(t: string | undefined): string {
  const s = (t ?? "").toLowerCase();
  if (s.includes("sources sought")) return "SOURCES_SOUGHT";
  if (s.includes("presolicitation")) return "PRESOLICITATION";
  if (s.includes("combined") || s.includes("solicitation")) return "RFP";
  if (s.includes("award")) return "AWARD";
  if (s.includes("special notice")) return "RFI";
  return "OTHER";
}

function toYmd(v: string | undefined | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export interface SamNotice {
  noticeId?: string;
  title?: string;
  solicitationNumber?: string;
  fullParentPathName?: string;
  type?: string;
  baseType?: string;
  active?: string; // "Yes" | "No"
  postedDate?: string;
  responseDeadLine?: string | null;
  naicsCode?: string;
  classificationCode?: string;
  typeOfSetAside?: string;
  uiLink?: string;
  description?: string; // a URL in v2
  awardee?: { name?: string };
  award?: { awardee?: { name?: string }; amount?: string; date?: string };
  placeOfPerformance?: { city?: { name?: string }; state?: { code?: string } };
}

/** PURE. Is this notice our kind of work? Title keywords, or a relevant NAICS / PSC code. */
export function isRelevantNotice(n: SamNotice): boolean {
  if (n.naicsCode && RELEVANT_NAICS.has(n.naicsCode)) return true;
  const psc = (n.classificationCode ?? "").toUpperCase();
  if (psc && RELEVANT_PSC_PREFIXES.some((p) => psc.startsWith(p))) return true;
  return isEventRelevant(n.title ?? "");
}

/** PURE. Status: cancelled / closed (inactive) / awarded / open. */
export function noticeStatus(n: SamNotice, awardeeName: string | undefined): string {
  const type = `${n.type ?? ""} ${n.baseType ?? ""}`.toLowerCase();
  if (type.includes("cancel")) return "cancelled";
  if (awardeeName || type.includes("award")) return "awarded";
  if ((n.active ?? "").toLowerCase() === "no") return "closed";
  return "open";
}

/** PURE. A SAM notice → our raw opportunity, or null when outside the DMV or not relevant. */
export function mapNotice(n: SamNotice): RawOpportunity | null {
  const state = n.placeOfPerformance?.state?.code;
  if (state && !DMV_STATES.has(state)) return null;
  if (!isRelevantNotice(n)) return null;

  const agency = n.fullParentPathName?.split(".")[0]?.trim() || n.fullParentPathName || "Federal agency";
  const awardeeName = n.award?.awardee?.name || n.awardee?.name;
  const entities: { name: string; kind: EntityKind; role?: RelationshipRole }[] = [{ name: agency, kind: "AGENCY", role: "DIRECT_BUYER" }];
  if (awardeeName) entities.push({ name: awardeeName, kind: "PRIME", role: "PRIME_CONTRACTOR" });

  return {
    externalId: n.noticeId,
    kind: "PROCUREMENT",
    name: n.title ?? "(untitled solicitation)",
    sourceUrl: n.uiLink,
    agency,
    city: n.placeOfPerformance?.city?.name,
    state,
    deadline: toYmd(n.responseDeadLine),
    status: noticeStatus(n, awardeeName),
    verificationStatus: "VERIFIED", // straight from the federal system of record
    entities,
    procurement: {
      solicitationNumber: n.solicitationNumber,
      noticeType: mapNoticeType(n.type),
      naics: n.naicsCode,
      psc: n.classificationCode,
      setAside: n.typeOfSetAside,
      postedDate: toYmd(n.postedDate) ?? undefined,
      responseDeadline: toYmd(n.responseDeadLine) ?? undefined,
      awardAmount: n.award?.amount ? Number(n.award.amount) || undefined : undefined,
      awardee: awardeeName,
      awardDate: toYmd(n.award?.date) ?? undefined,
    },
  };
}

export function samGovConfigured(): boolean {
  return Boolean(process.env.SAM_API_KEY?.trim());
}

// ── Incremental, quota-aware acquisition ─────────────────────────────────────────────────────────

export interface SamCursor {
  from: string; // YYYY-MM-DD, the postedFrom of the window being read
  offset: number; // next page offset inside that window
}
export type SamCursors = Partial<Record<string, SamCursor>>;

export interface SamRunReport {
  at: string;
  calls: number;
  fetched: number;
  kept: number;
  complete: boolean; // every state caught up this run
  errors: string[];
  states: Record<string, { calls: number; fetched: number; total: number | null; done: boolean; error?: string }>;
}

const CURSOR_KEY = "radar.sam.cursors";
const REPORT_KEY = "radar.sam.lastRun";

const mdY = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => ymdOf(new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000));

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * PURE apart from the injected fetch. Walk each state's window from its cursor, spending at most
 * `maxCalls` calls in total. Returns the notices, the advanced cursors, and a report.
 */
export async function acquireSamIncremental(opts: {
  key: string;
  today: string; // YYYY-MM-DD
  cursors: SamCursors;
  maxCalls: number;
  lookbackDays: number;
  fetchImpl: FetchLike;
}): Promise<{ notices: SamNotice[]; cursors: SamCursors; report: Omit<SamRunReport, "at" | "kept"> }> {
  const cursors: SamCursors = { ...opts.cursors };
  const notices: SamNotice[] = [];
  const report: Omit<SamRunReport, "at" | "kept"> = { calls: 0, fetched: 0, complete: true, errors: [], states: {} };
  // Earliest the API allows is one year back.
  const floor = addDays(opts.today, -364);

  for (const state of SAM_STATES) {
    const st = { calls: 0, fetched: 0, total: null as number | null, done: false, error: undefined as string | undefined };
    report.states[state] = st;
    let cur: SamCursor = cursors[state] ?? { from: addDays(opts.today, -opts.lookbackDays), offset: 0 };
    if (cur.from < floor) cur = { from: floor, offset: 0 };

    while (!st.done) {
      if (report.calls >= opts.maxCalls) break;
      const params = new URLSearchParams({
        api_key: opts.key,
        postedFrom: mdY(cur.from),
        postedTo: mdY(opts.today),
        state,
        limit: String(PAGE_LIMIT),
        offset: String(cur.offset),
      });
      report.calls++;
      st.calls++;
      let page: { totalRecords?: number; opportunitiesData?: SamNotice[] };
      try {
        const res = await opts.fetchImpl(`${SAM_URL}?${params.toString()}`, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(res.status === 429 ? "SAM.gov daily limit reached (429)" : `SAM.gov HTTP ${res.status}`);
        page = (await res.json()) as typeof page;
      } catch (e) {
        st.error = (e as Error).message.replace(opts.key, "***");
        report.errors.push(`${state}: ${st.error}`);
        break; // keep the cursor where it was; retry next run
      }
      const rows = page.opportunitiesData ?? [];
      st.total = typeof page.totalRecords === "number" ? page.totalRecords : null;
      st.fetched += rows.length;
      report.fetched += rows.length;
      notices.push(...rows);
      const nextOffset = cur.offset + rows.length;
      if (rows.length === 0 || st.total == null || nextOffset >= st.total) {
        st.done = true;
        // Caught up: next window starts yesterday (one day overlap; dedupe collapses repeats).
        cur = { from: addDays(opts.today, -1), offset: 0 };
      } else {
        cur = { from: cur.from, offset: nextOffset };
      }
    }
    cursors[state] = cur;
    if (!st.done) report.complete = false;
  }
  return { notices, cursors, report };
}

export function lastSamRun(): SamRunReport | null {
  return getJson<SamRunReport | null>(REPORT_KEY, null);
}

/** The SAM.gov source. Dormant (acquire → []) until SAM_API_KEY is set. */
export function samGovSource(opts: { lookbackDays?: number; maxCalls?: number; fetchImpl?: FetchLike; now?: Date } = {}): OpportunitySource {
  return {
    id: "samgov-federal",
    name: "SAM.gov — federal solicitations",
    kind: "FEDERAL_API",
    acquisitionMethod: "API",
    adapter: "samgov",
    async acquire(): Promise<RawOpportunity[]> {
      const key = process.env.SAM_API_KEY?.trim();
      if (!key) return []; // dormant
      const now = opts.now ?? new Date();
      const maxCalls = opts.maxCalls ?? Math.max(1, Number(process.env.RADAR_SAM_MAX_CALLS) || 3);
      const lookbackDays = opts.lookbackDays ?? Math.max(1, Number(process.env.RADAR_SAM_LOOKBACK_DAYS) || 14);
      const { notices, cursors, report } = await acquireSamIncremental({
        key,
        today: ymdOf(now),
        cursors: getJson<SamCursors>(CURSOR_KEY, {}),
        maxCalls,
        lookbackDays,
        fetchImpl: opts.fetchImpl ?? (fetch as unknown as FetchLike),
      });
      setJson(CURSOR_KEY, cursors);
      const kept = notices.map(mapNotice).filter((x): x is RawOpportunity => x !== null);
      setJson(REPORT_KEY, { ...report, at: now.toISOString(), kept: kept.length } satisfies SamRunReport);
      // Every call failed and nothing came back: make the failure visible to the pipeline.
      if (report.errors.length > 0 && report.fetched === 0) throw new Error(report.errors.join("; "));
      return kept;
    },
  };
}

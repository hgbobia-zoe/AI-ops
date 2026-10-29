// SEO Growth — opportunity DISCOVERY pipeline. Seeds Zoe's rental categories × DMV geographies, pulls keyword
// facts from the Ubersuggest MCP boundary, parses them into SeoMetrics (absent = UNKNOWN, never 0), gates on
// commercial intent + relevance, upserts (dedupe handles re-runs), then analyzes (match + priority) and parks
// the result in the ANALYZING stage awaiting the human approval gate.
//
// HONESTY: with no MCP credential this makes NO network call and discovers nothing — the correct, honest state
// until the credential is set. The boundary (callTool/configured) is injectable so tests exercise the full
// pipeline against a MOCKED boundary (the ONLY place mocks are allowed).

import { callTool as realCallTool, configured as realConfigured, type McpResult } from "./ubersuggest";
import { upsertOpportunity, findOpportunityByDedupe, getOpportunity, setAnalysis, setOpportunityStage, allDedupeKeys, dedupeKey, recordRetrieval } from "./store";
import { analyzeOpportunity } from "./analyze";
import { parseSerpResult, DEFAULT_ZOE_DOMAIN } from "./serp";
import { ZOE_PAGES } from "./zoe-pages";
import type { SeoIntent, SeoMetrics, SeoSource, SerpData, ZoePage } from "./types";

// ── seed catalog ────────────────────────────────────────────────────────────────────────────────────
// Each seed term maps to a canonical Zoe category (aligned with zoe-pages categories so the matcher lines up).
// Categories with NO existing Zoe page (lighting, bounce house, marquee letters) are intentionally included —
// they are the real content GAPS the engine should surface as CREATE.
export interface SeedCategory {
  category: string;
  /** The primary keyword head, e.g. "wedding tent" → "wedding tent rental <geo>". */
  term: string;
}

export const SEED_CATEGORIES: SeedCategory[] = [
  { category: "tents", term: "tent" },
  { category: "tents", term: "wedding tent" },
  { category: "tables", term: "table" },
  { category: "chairs", term: "chiavari chair" },
  { category: "seating", term: "event chair" },
  { category: "linens", term: "table linen" },
  { category: "dance floors", term: "dance floor" },
  { category: "staging", term: "stage" },
  { category: "lounge", term: "lounge furniture" },
  { category: "decor", term: "event decor" },
  { category: "tableware", term: "charger plate" },
  { category: "bars", term: "portable bar" },
  { category: "flooring", term: "event flooring" },
  { category: "power", term: "generator" },
  { category: "heating & cooling", term: "patio heater" },
  { category: "crowd control", term: "stanchion" },
  { category: "pipe and drape", term: "pipe and drape" },
  { category: "audio", term: "speaker" },
  { category: "av", term: "av equipment" },
  { category: "extras", term: "event rental" },
  // Known content gaps (no Zoe page yet).
  { category: "lighting", term: "event lighting" },
  { category: "bounce house", term: "bounce house" },
  { category: "marquee letters", term: "marquee letter" },
];

export interface DmvGeo {
  label: string; // what we store as the opportunity location, e.g. "Washington, DC"
  priority: number; // lower = pulled first when geos are capped
}

export const DMV_GEOS: DmvGeo[] = [
  { label: "Washington, DC", priority: 1 },
  { label: "Rockville, MD", priority: 2 },
  { label: "Bethesda, MD", priority: 2 },
  { label: "Silver Spring, MD", priority: 3 },
  { label: "Gaithersburg, MD", priority: 3 },
  { label: "Montgomery County, MD", priority: 2 },
  { label: "Prince George's County, MD", priority: 3 },
  { label: "Fairfax, VA", priority: 2 },
  { label: "Arlington, VA", priority: 2 },
  { label: "Alexandria, VA", priority: 3 },
  { label: "Loudoun County, VA", priority: 4 },
  { label: "Howard County, MD", priority: 4 },
  { label: "Anne Arundel County, MD", priority: 4 },
  { label: "Northern Virginia", priority: 3 },
];

export interface SeedKeyword {
  keyword: string;
  category: string;
  location: string | null;
  intent: SeoIntent;
}

/** Build the (category × geo) seed keywords, plus a DMV-general head per term. Bounded by maxGeosPerCategory. */
export function buildSeedKeywords(opts: { maxGeosPerCategory?: number; categories?: string[] } = {}): SeedKeyword[] {
  const maxGeos = opts.maxGeosPerCategory ?? DMV_GEOS.length;
  const geos = [...DMV_GEOS].sort((a, b) => a.priority - b.priority).slice(0, Math.max(0, maxGeos));
  const seeds = opts.categories?.length ? SEED_CATEGORIES.filter((s) => opts.categories!.includes(s.category)) : SEED_CATEGORIES;
  const out: SeedKeyword[] = [];
  for (const s of seeds) {
    out.push({ keyword: `${s.term} rental`, category: s.category, location: "DMV", intent: "commercial" });
    for (const g of geos) {
      out.push({ keyword: `${s.term} rental ${g.label.replace(/,.*$/, "")}`, category: s.category, location: g.label, intent: "commercial" });
    }
  }
  return out;
}

// ── result parsing (defensive — the live MCP tool schema is unverified) ───────────────────────────────
function asNumber(x: unknown): number | undefined {
  const n = typeof x === "string" ? Number(x.replace(/[^0-9.]/g, "")) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined; // absent/invalid ⇒ UNKNOWN, never 0 defaulted
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] != null) return obj[k];
  return undefined;
}

function toStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const item of x) {
    if (typeof item === "string") out.push(item);
    else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const v = o.keyword ?? o.text ?? o.term ?? o.domain ?? o.url ?? o.name;
      if (typeof v === "string") out.push(v);
    }
  }
  return out.map((s) => s.trim()).filter(Boolean).slice(0, 40);
}

/** Unwrap an MCP tool result's payload: a tools/call result is often {content:[{type:"text",text:"<json>"}]}. */
export function unwrapToolData(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const content = d.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === "object") {
        const co = c as Record<string, unknown>;
        if (typeof co.text === "string") {
          try {
            const parsed = JSON.parse(co.text);
            if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
          } catch {
            /* not JSON — ignore this frame */
          }
        }
        if (co.json && typeof co.json === "object") return co.json as Record<string, unknown>;
      }
    }
  }
  if (d.structuredContent && typeof d.structuredContent === "object") return d.structuredContent as Record<string, unknown>;
  return d;
}

export interface ParsedKeyword {
  metrics: SeoMetrics;
  hasMetrics: boolean;
  relatedKeywords: string[];
  competitorRefs: string[];
  intent: SeoIntent | null;
  /** A live SERP read (SERP-source ingests only), or null for the legacy keyword-metrics path. */
  serp?: SerpData | null;
  /** How this fact was obtained — drives the opportunity's `source`. Defaults to "ubersuggest" for back-compat. */
  source?: SeoSource;
}

const INTENTS: SeoIntent[] = ["informational", "commercial", "transactional", "navigational"];

/** Parse a (possibly unknown-shaped) keyword tool result into our facts. Absent fields stay absent (UNKNOWN). */
export function parseKeywordResult(data: unknown, locale = "US"): ParsedKeyword {
  const obj = unwrapToolData(data) ?? {};
  const metrics: SeoMetrics = {};
  const vol = asNumber(pick(obj, ["volume", "search_volume", "searchVolume", "vol", "monthly_volume", "monthlyVolume"]));
  const diff = asNumber(pick(obj, ["difficulty", "seo_difficulty", "seoDifficulty", "sd", "keyword_difficulty", "kd"]));
  const paid = asNumber(pick(obj, ["paid_difficulty", "paidDifficulty", "pd", "competition"]));
  const cpc = asNumber(pick(obj, ["cpc", "cost_per_click", "costPerClick"]));
  if (vol != null) metrics.volume = vol;
  if (diff != null) metrics.difficulty = diff;
  if (paid != null) metrics.paidDifficulty = paid;
  if (cpc != null) metrics.cpc = cpc;
  metrics.locale = String(pick(obj, ["locale", "country", "region"]) ?? locale);
  const hasMetrics = vol != null || diff != null || paid != null || cpc != null;

  const related = toStringArray(pick(obj, ["related", "related_keywords", "relatedKeywords", "suggestions", "keyword_ideas", "ideas", "keywords"]));
  const competitors = toStringArray(pick(obj, ["competitors", "ranking_domains", "domains", "serp", "serp_results", "results"]));

  const rawIntent = pick(obj, ["intent", "search_intent", "searchIntent"]);
  const intent = typeof rawIntent === "string" && (INTENTS as string[]).includes(rawIntent.toLowerCase()) ? (rawIntent.toLowerCase() as SeoIntent) : null;

  return { metrics, hasMetrics, relatedKeywords: related, competitorRefs: competitors, intent };
}

// ── relevance + commercial-intent gate ────────────────────────────────────────────────────────────
const MIN_VOLUME = 20;

/** Keep only commercial/transactional (or unknown) opportunities with plausible demand. Reject obvious junk. */
export function passesGate(seed: SeedKeyword, parsed: ParsedKeyword): boolean {
  const intent = parsed.intent ?? seed.intent;
  if (intent === "navigational" || intent === "informational") return false; // not a rental-demand keyword
  // If a volume is KNOWN, require a floor; a very hard + very thin keyword isn't worth it. Absent volume = UNKNOWN → keep.
  if (parsed.metrics.volume != null && parsed.metrics.volume < MIN_VOLUME) return false;
  return true;
}

// ── the pipeline ──────────────────────────────────────────────────────────────────────────────────
export interface DiscoverOptions {
  maxGeosPerCategory?: number;
  categories?: string[];
  /** Hard cap on boundary calls per run (safety). */
  limit?: number;
  /** The keyword tool to call on the MCP (configurable; the live schema is unverified). */
  tool?: string;
  // Injectable boundary (tests pass a mock; production uses the real Ubersuggest boundary).
  callTool?: (name: string, args: Record<string, unknown>) => Promise<McpResult>;
  configured?: () => boolean;
  pages?: ZoePage[];
}

export interface DiscoverResult {
  configured: boolean;
  attempted: number;
  created: number;
  updated: number;
  analyzed: number;
  skipped: number;
  errors: number;
  ranAt: string;
  note: string;
}

const DEFAULT_TOOL = process.env.UBERSUGGEST_KEYWORD_TOOL || "keyword_ideas";

/** Persist one parsed keyword's facts: upsert the opportunity (dedupe-safe) + analyze (match/priority) +
 *  advance DISCOVERED → ANALYZING. The SHARED core of both the server-side pull (discover) and the
 *  office-runner push (ingestKeywordResults), so they can never diverge. Returns new-vs-refreshed + analyzed. */
export function applyKeywordFacts(seed: SeedKeyword, parsed: ParsedKeyword, retrievedAt: string | null, pages: ZoePage[] = ZOE_PAGES): { id: string; created: boolean; analyzed: boolean } {
  const intent = parsed.intent ?? seed.intent;
  const existed = findOpportunityByDedupe(seed.keyword, intent, seed.location) != null;
  const source: SeoSource = parsed.source ?? (parsed.serp ? "serp" : "ubersuggest");
  const id = upsertOpportunity({
    keyword: seed.keyword,
    intent,
    location: seed.location,
    category: seed.category,
    relatedKeywords: parsed.relatedKeywords,
    competitorRefs: parsed.competitorRefs,
    // A SERP read never carries volume/difficulty — those stay UNKNOWN (metricsSource "none"), which is honest.
    metrics: parsed.hasMetrics ? parsed.metrics : null,
    metricsSource: parsed.hasMetrics ? (source === "serp" ? "serp" : "ubersuggest") : "none",
    serp: parsed.serp ?? null,
    source,
    researchAt: retrievedAt,
  });
  const analyzed = reanalyze(id, pages);
  return { id, created: !existed, analyzed };
}

/** Re-run match + priority for an opportunity and persist (used by discovery and the re-analyze path). */
export function reanalyze(id: string, pages: ZoePage[] = ZOE_PAGES): boolean {
  const opp = getOpportunity(id);
  if (!opp) return false;
  const a = analyzeOpportunity(
    { keyword: opp.keyword, intent: opp.intent, location: opp.location, category: opp.category, relatedKeywords: opp.relatedKeywords, metrics: opp.metrics, competitorRefs: opp.competitorRefs, serp: opp.serp },
    pages,
  );
  setAnalysis(id, { matchedUrl: a.matchedUrl, recommendedAction: a.recommendedAction, priority: a.priority, priorityBreakdown: a.priorityBreakdown, explanation: a.explanation });
  // Advance DISCOVERED → ANALYZING (pre-approval only; never regress a human decision).
  if (opp.stage === "DISCOVERED") setOpportunityStage(id, "ANALYZING", "system (discovery)", "auto-analyzed");
  return true;
}

/**
 * Run the discovery pipeline. With no MCP credential it short-circuits honestly (no network, nothing created).
 */
export async function discover(opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const ranAt = new Date().toISOString();
  const isConfigured = (opts.configured ?? realConfigured)();
  const result: DiscoverResult = { configured: isConfigured, attempted: 0, created: 0, updated: 0, analyzed: 0, skipped: 0, errors: 0, ranAt, note: "" };

  if (!isConfigured) {
    result.note = "Ubersuggest MCP credential not set — no keyword data pulled. Set it in Settings to enable discovery. (This is the correct, honest state, not an error.)";
    return result;
  }

  const callTool = opts.callTool ?? realCallTool;
  const pages = opts.pages ?? ZOE_PAGES;
  const tool = opts.tool ?? DEFAULT_TOOL;
  const seeds = buildSeedKeywords({ maxGeosPerCategory: opts.maxGeosPerCategory, categories: opts.categories });
  const limited = typeof opts.limit === "number" ? seeds.slice(0, Math.max(0, opts.limit)) : seeds;

  for (const seed of limited) {
    result.attempted++;
    let res: McpResult;
    try {
      res = await callTool(tool, { keyword: seed.keyword, country: "US", language: "en" });
    } catch {
      result.errors++;
      continue;
    }
    if (!res.ok) {
      result.errors++;
      continue;
    }
    const parsed = parseKeywordResult(res.data);
    if (!passesGate(seed, parsed)) {
      result.skipped++;
      continue;
    }

    const { created, analyzed } = applyKeywordFacts(seed, parsed, res.retrievedAt, pages);
    if (created) result.created++;
    else result.updated++;
    if (analyzed) result.analyzed++;
  }

  result.note = `Pulled ${result.attempted} keyword(s): ${result.created} new, ${result.updated} refreshed, ${result.analyzed} analyzed, ${result.skipped} gated out, ${result.errors} errors.`;
  return result;
}

// ── office-runner PUSH path (path B) ──────────────────────────────────────────────────────────────
// Ubersuggest's MCP is OAuth-only (no static token), so the OFFICE MACHINE runs the MCP client, does the
// one-time browser sign-in, pulls keyword data, and PUSHES it here via /api/seo/ingest. The app never calls
// Ubersuggest in this path. ingestKeywordResults reuses the EXACT parse → gate → upsert → analyze core
// (applyKeywordFacts), so pushed data lands identically to a server-side pull. HONESTY: a limit-hit records a
// rate-limited diagnostic and creates NO fabricated rows — the watcher surfaces it.

function safeTruncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

/** One pushed keyword result from the runner: the seed identity + the RAW MCP tool result (parsed here, so
 *  the unverified schema is handled in one place). */
export interface SeoIngestKeywordInput {
  keyword: string;
  category?: string | null;
  location?: string | null;
  intent?: SeoIntent | null;
  rawResult: unknown;
}

/** Batch-level signal from the runner: data source, quota/limit/blocked state + the first-run schema capture. */
export interface SeoIngestMeta {
  /** "serp" = the keyword rawResults are live Google SERP reads; absent/"ubersuggest" = legacy keyword metrics. */
  source?: SeoSource;
  /** Zoe's own domain, so the SERP parser can detect Zoe's listing + rank. Defaults to DEFAULT_ZOE_DOMAIN. */
  zoeDomain?: string;
  limitHit?: boolean;
  /** The SERP read looked blocked (consent wall / CAPTCHA / empty) — an honest "no data", NOT fabricated zeros. */
  blocked?: boolean;
  quota?: { remaining?: number | null; resetAt?: string | null };
  error?: string | null;
  toolName?: string | null;
  toolsList?: unknown;
  retrievedAt?: string | null;
}

export interface SeoIngestBatch {
  keywords?: SeoIngestKeywordInput[];
  meta?: SeoIngestMeta;
}

export interface SeoIngestResult {
  received: number;
  created: number;
  updated: number;
  analyzed: number;
  skipped: number;
  errors: number;
  limitHit: boolean;
  /** True when the runner reported the SERP read was blocked (consent/CAPTCHA) — honest, no rows created. */
  blocked: boolean;
  note: string;
  ranAt: string;
}

/** Apply a batch the office runner pushed. Pure persistence (no network). Records retrieval diagnostics so
 *  the health card's freshness + the watcher's limit-hit are driven by REAL ingests, never fabricated. */
export function ingestKeywordResults(batch: SeoIngestBatch, opts: { pages?: ZoePage[] } = {}): SeoIngestResult {
  const ranAt = new Date().toISOString();
  const pages = opts.pages ?? ZOE_PAGES;
  const meta = batch.meta ?? {};
  const toolName = meta.toolName ?? null;
  const isSerp = meta.source === "serp";
  const zoeDomain = meta.zoeDomain || DEFAULT_ZOE_DOMAIN;
  const result: SeoIngestResult = { received: 0, created: 0, updated: 0, analyzed: 0, skipped: 0, errors: 0, limitHit: !!meta.limitHit, blocked: !!meta.blocked, note: "", ranAt };
  const kws = Array.isArray(batch.keywords) ? batch.keywords : [];

  for (const kw of kws) {
    if (!kw || typeof kw.keyword !== "string" || !kw.keyword.trim()) {
      result.errors++;
      continue;
    }
    result.received++;
    const seed: SeedKeyword = {
      keyword: kw.keyword.trim(),
      category: (kw.category ?? "").toString().trim() || "uncategorized",
      location: kw.location ?? null,
      intent: (typeof kw.intent === "string" ? kw.intent : "commercial") as SeoIntent,
    };
    let parsed: ParsedKeyword;
    try {
      if (isSerp) {
        // SERP source: parse observed rankings. No volume/difficulty (stays UNKNOWN). A read with zero organic
        // results is treated as no data for this keyword (skipped), never fabricated.
        const ps = parseSerpResult(kw.rawResult, zoeDomain, { locale: seed.location ?? undefined });
        if (!ps.hasData) {
          result.skipped++;
          recordRetrieval({ operation: "ingest", ok: false, tool: toolName, detail: `empty SERP (no organic results): ${seed.keyword}` });
          continue;
        }
        parsed = { metrics: {}, hasMetrics: false, relatedKeywords: ps.relatedKeywords, competitorRefs: ps.competitorRefs, intent: null, serp: ps.serp, source: "serp" };
      } else {
        parsed = parseKeywordResult(kw.rawResult);
      }
    } catch {
      result.errors++;
      recordRetrieval({ operation: "ingest", ok: false, tool: toolName, detail: `parse error: ${seed.keyword}` });
      continue;
    }
    if (!passesGate(seed, parsed)) {
      result.skipped++;
      continue;
    }
    try {
      const { created, analyzed } = applyKeywordFacts(seed, parsed, meta.retrievedAt ?? ranAt, pages);
      if (created) result.created++;
      else result.updated++;
      if (analyzed) result.analyzed++;
      recordRetrieval({ operation: "ingest", ok: true, tool: toolName, detail: `ingested: ${seed.keyword}` });
    } catch (e) {
      // Failure isolation: one bad keyword never aborts the batch.
      result.errors++;
      recordRetrieval({ operation: "ingest", ok: false, tool: toolName, detail: `ingest error (${seed.keyword}): ${safeTruncate(String(e), 300)}` });
    }
  }

  // First-run schema capture — the live Ubersuggest tool name + a sample result shape, so the parser can be
  // confirmed/tweaked against reality. Stored as a diagnostic (also visible in recentDiagnostics).
  if (meta.toolsList !== undefined) {
    recordRetrieval({ operation: "ingest.schema", ok: true, tool: toolName, detail: safeTruncate(JSON.stringify(meta.toolsList), 4000) });
  }
  // Limit-hit → an honest rate-limited diagnostic (drives the watcher). NO data is fabricated.
  if (meta.limitHit) {
    recordRetrieval({ operation: "ingest", ok: false, tool: toolName, rateLimited: true, detail: `Data limit reached${meta.quota?.resetAt ? ` — resets ${meta.quota.resetAt}` : ""}` });
  } else if (meta.blocked) {
    // A blocked SERP read is an honest FAILURE (not a rate-limit, not fabricated data) — the office runner was
    // served a consent wall / CAPTCHA / empty page. Surfaces on the health card; never creates rows.
    recordRetrieval({ operation: "ingest", ok: false, tool: toolName, detail: "SERP read blocked (consent wall / CAPTCHA / empty) — no data pulled this run" });
  } else if (meta.error) {
    recordRetrieval({ operation: "ingest", ok: false, tool: toolName, detail: safeTruncate(meta.error, 500) });
  }

  result.note = `Ingested ${result.received}: ${result.created} new, ${result.updated} refreshed, ${result.analyzed} analyzed, ${result.skipped} gated out, ${result.errors} errors${meta.limitHit ? " (data limit hit)" : ""}${meta.blocked ? " (SERP blocked)" : ""}.`;
  return result;
}

/** The seed keywords NOT yet discovered — what the office runner should pull next (so a 3/day free-tier drip
 *  resumes without re-pulling). Computed from the committed seed catalog minus the stored dedupe keys. */
export function pendingSeedKeywords(opts: { limit?: number; maxGeosPerCategory?: number; categories?: string[] } = {}): SeedKeyword[] {
  const seeds = buildSeedKeywords({ maxGeosPerCategory: opts.maxGeosPerCategory, categories: opts.categories });
  const have = allDedupeKeys();
  const pending = seeds.filter((s) => !have.has(dedupeKey(s.keyword, s.intent, s.location)));
  return typeof opts.limit === "number" ? pending.slice(0, Math.max(0, opts.limit)) : pending;
}

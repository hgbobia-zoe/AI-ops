// SEO Growth — opportunity DISCOVERY pipeline. Seeds Zoe's rental categories × DMV geographies, pulls keyword
// facts from the Ubersuggest MCP boundary, parses them into SeoMetrics (absent = UNKNOWN, never 0), gates on
// commercial intent + relevance, upserts (dedupe handles re-runs), then analyzes (match + priority) and parks
// the result in the ANALYZING stage awaiting the human approval gate.
//
// HONESTY: with no MCP credential this makes NO network call and discovers nothing — the correct, honest state
// until the credential is set. The boundary (callTool/configured) is injectable so tests exercise the full
// pipeline against a MOCKED boundary (the ONLY place mocks are allowed).

import { callTool as realCallTool, configured as realConfigured, type McpResult } from "./ubersuggest";
import { upsertOpportunity, findOpportunityByDedupe, getOpportunity, setAnalysis, setOpportunityStage } from "./store";
import { analyzeOpportunity } from "./analyze";
import { ZOE_PAGES } from "./zoe-pages";
import type { SeoIntent, SeoMetrics, ZoePage } from "./types";

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

/** Re-run match + priority for an opportunity and persist (used by discovery and the re-analyze path). */
export function reanalyze(id: string, pages: ZoePage[] = ZOE_PAGES): boolean {
  const opp = getOpportunity(id);
  if (!opp) return false;
  const a = analyzeOpportunity(
    { keyword: opp.keyword, intent: opp.intent, location: opp.location, category: opp.category, relatedKeywords: opp.relatedKeywords, metrics: opp.metrics, competitorRefs: opp.competitorRefs },
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

    const intent = parsed.intent ?? seed.intent;
    const existed = findOpportunityByDedupe(seed.keyword, intent, seed.location) != null;
    const id = upsertOpportunity({
      keyword: seed.keyword,
      intent,
      location: seed.location,
      category: seed.category,
      relatedKeywords: parsed.relatedKeywords,
      competitorRefs: parsed.competitorRefs,
      metrics: parsed.hasMetrics ? parsed.metrics : null,
      metricsSource: parsed.hasMetrics ? "ubersuggest" : "none",
      source: "ubersuggest",
      researchAt: res.retrievedAt,
    });
    if (existed) result.updated++;
    else result.created++;
    if (reanalyze(id, pages)) result.analyzed++;
  }

  result.note = `Pulled ${result.attempted} keyword(s): ${result.created} new, ${result.updated} refreshed, ${result.analyzed} analyzed, ${result.skipped} gated out, ${result.errors} errors.`;
  return result;
}

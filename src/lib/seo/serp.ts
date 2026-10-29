// SEO Growth — SERP parsing + competitor-domain aggregation. PURE (no DB, no I/O), so it is fully unit-
// testable and reused by both the ingest path and the UI. "RULES CALCULATE."
//
// The office runner reads a live Google SERP for each tracked keyword and pushes the result here. This module
// turns that (defensively-shaped) payload into FACTS: who ranks, whether Zoe appears and where, the related
// questions/searches. HONESTY LAW: everything is OBSERVED on the page — a SERP read yields NO search volume or
// difficulty, so those stay UNKNOWN (never defaulted). A blocked/empty read yields no rows (handled upstream).

import type { SeoOpportunity, SerpData, SerpResultEntry, SeoCompetitorDomain } from "./types";

/** Zoe's default public domain. Overridable per ingest (meta.zoeDomain) / in /admin (seoZoeDomain). */
export const DEFAULT_ZOE_DOMAIN = "zoeeventsdmv.com";

/**
 * Domains that rank on event-rental SERPs but are NOT competing rental companies — directories, aggregators,
 * marketplaces, review sites and social. Excluded from "competitors" and from the competitor-domain rollup so
 * the gap view shows real rivals, not Yelp. A small, clearly-commented constant; extend as needed. Matched as a
 * suffix (so "m.yelp.com" and "yelp.com" both match).
 */
export const NON_COMPETITOR_DOMAINS: string[] = [
  "google.com",
  "google.co",
  "youtube.com",
  "yelp.com",
  "thumbtack.com",
  "theknot.com",
  "weddingwire.com",
  "gigsalad.com",
  "peerspace.com",
  "eventup.com",
  "partyslate.com",
  "bark.com",
  "facebook.com",
  "instagram.com",
  "pinterest.com",
  "reddit.com",
  "tripadvisor.com",
  "wikipedia.org",
  "amazon.com",
  "ebay.com",
  "nextdoor.com",
  "mapquest.com",
  "bbb.org",
  "angi.com",
  "homeadvisor.com",
];

/** Normalize a URL or bare host to a lower-case registrable-ish host: strip protocol, path, port and a leading
 *  "www.". Not a full public-suffix parse (kept dependency-free) — good enough to group a site's SERP hits. */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/^\/\//, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  s = s.split("@").pop() ?? s; // drop any userinfo
  s = s.split(":")[0]; // drop port
  s = s.replace(/^www\./, "");
  return s || null;
}

/** True when `domain` is (or is a subdomain of) `base`. Both should be normalized. */
export function domainMatches(domain: string, base: string): boolean {
  if (!domain || !base) return false;
  return domain === base || domain.endsWith(`.${base}`);
}

function isDirectory(domain: string): boolean {
  return NON_COMPETITOR_DOMAINS.some((d) => domainMatches(domain, d));
}

function asNum(x: unknown): number | undefined {
  const n = typeof x === "string" ? Number(x.replace(/[^0-9.]/g, "")) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function strList(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const item of x) {
    if (typeof item === "string") out.push(item);
    else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const v = o.question ?? o.query ?? o.text ?? o.title ?? o.keyword ?? o.term;
      if (typeof v === "string") out.push(v);
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = s.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

/** The runner's SERP payload is defensively shaped — organic results may be under several keys, each entry may
 *  carry link/url + title + an explicit position or none (we fall back to array order). */
function readOrganic(obj: Record<string, unknown>): { url: string; title: string | null; rank: number }[] {
  const raw =
    (Array.isArray(obj.organic) && obj.organic) ||
    (Array.isArray(obj.organic_results) && obj.organic_results) ||
    (Array.isArray(obj.results) && obj.results) ||
    (Array.isArray(obj.items) && obj.items) ||
    [];
  const out: { url: string; title: string | null; rank: number }[] = [];
  let i = 0;
  for (const entry of raw as unknown[]) {
    i++;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const url = (typeof e.url === "string" && e.url) || (typeof e.link === "string" && e.link) || (typeof e.href === "string" && e.href) || "";
    if (!url) continue;
    const title = typeof e.title === "string" ? e.title : typeof e.name === "string" ? e.name : null;
    const posN = asNum(e.position ?? e.rank ?? e.pos);
    out.push({ url, title, rank: posN ?? i });
  }
  return out;
}

export interface ParsedSerp {
  serp: SerpData;
  /** Competing rental domains ranking for the keyword (directories/Zoe excluded), best-first. */
  competitorRefs: string[];
  /** PAA + related searches, deduped — fed into the opportunity's relatedKeywords. */
  relatedKeywords: string[];
  /** False when the read produced no organic results (treat as no data, never fabricate). */
  hasData: boolean;
}

/**
 * Parse a SERP payload the runner pushed into FACTS. `zoeDomain` identifies Zoe's own listing; organic domains
 * that are neither Zoe nor a known directory are the competitors. Defensive about the exact shape, like
 * parseKeywordResult. Positions are as observed; nothing is estimated.
 */
export function parseSerpResult(raw: unknown, zoeDomain: string = DEFAULT_ZOE_DOMAIN, opts: { locale?: string; maxDomains?: number } = {}): ParsedSerp {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const zoe = normalizeDomain(zoeDomain) ?? DEFAULT_ZOE_DOMAIN;
  const locale = opts.locale ?? (typeof obj.locale === "string" ? obj.locale : typeof obj.country === "string" ? obj.country : "US");
  const maxDomains = opts.maxDomains ?? 10;

  const organic = readOrganic(obj);
  const topDomains: SerpResultEntry[] = [];
  let zoeRank: number | null = null;
  const seenDomain = new Set<string>();
  for (const o of organic) {
    const domain = normalizeDomain(o.url);
    if (!domain) continue;
    if (domainMatches(domain, zoe) && zoeRank == null) zoeRank = o.rank;
    if (seenDomain.has(domain)) continue; // one row per domain, keep its best (first) rank
    seenDomain.add(domain);
    if (topDomains.length < maxDomains) topDomains.push({ domain, rank: o.rank, url: o.url, title: o.title });
  }

  const competitorRefs = topDomains
    .filter((d) => !domainMatches(d.domain, zoe) && !isDirectory(d.domain))
    .map((d) => d.domain);

  const paa = strList(obj.peopleAlsoAsk ?? obj.people_also_ask ?? obj.relatedQuestions ?? obj.related_questions ?? obj.paa);
  const related = strList(obj.relatedSearches ?? obj.related_searches ?? obj.related ?? obj.relatedKeywords ?? obj.related_keywords);
  const relatedKeywords = dedupe([...paa, ...related]).slice(0, 40);

  const retrievedAt = typeof obj.retrievedAt === "string" ? obj.retrievedAt : new Date().toISOString();
  const serp: SerpData = {
    retrievedAt,
    zoeRank,
    zoePresent: zoeRank != null,
    topDomains,
    peopleAlsoAsk: dedupe(paa).slice(0, 20),
    relatedSearches: dedupe(related).slice(0, 20),
    locale,
  };
  return { serp, competitorRefs, relatedKeywords, hasData: organic.length > 0 };
}

/**
 * Roll up every stored opportunity's SERP read into per-competitor-domain facts: how many tracked keywords each
 * domain ranks for and its mean rank. PURE — pass the opportunities in. Zoe's own domain + known directories are
 * excluded. Sorted by appearances (desc), then mean rank (asc). `maxKeywordsPerDomain` caps the per-row keyword
 * list for display.
 */
export function aggregateCompetitorDomains(
  opportunities: Pick<SeoOpportunity, "keyword" | "serp">[],
  zoeDomain: string = DEFAULT_ZOE_DOMAIN,
  opts: { maxKeywordsPerDomain?: number } = {},
): SeoCompetitorDomain[] {
  const zoe = normalizeDomain(zoeDomain) ?? DEFAULT_ZOE_DOMAIN;
  const maxKw = opts.maxKeywordsPerDomain ?? 12;
  const acc = new Map<string, { appearances: number; rankSum: number; keywords: Set<string>; firstSeen: string; lastSeen: string }>();

  for (const opp of opportunities) {
    const serp = opp.serp;
    if (!serp || !Array.isArray(serp.topDomains)) continue;
    for (const d of serp.topDomains) {
      if (domainMatches(d.domain, zoe) || isDirectory(d.domain)) continue;
      const cur = acc.get(d.domain) ?? { appearances: 0, rankSum: 0, keywords: new Set<string>(), firstSeen: serp.retrievedAt, lastSeen: serp.retrievedAt };
      cur.appearances += 1;
      cur.rankSum += d.rank;
      cur.keywords.add(opp.keyword);
      if (serp.retrievedAt < cur.firstSeen) cur.firstSeen = serp.retrievedAt;
      if (serp.retrievedAt > cur.lastSeen) cur.lastSeen = serp.retrievedAt;
      acc.set(d.domain, cur);
    }
  }

  const out: SeoCompetitorDomain[] = [];
  for (const [domain, v] of acc) {
    out.push({
      domain,
      appearances: v.appearances,
      avgRank: Math.round((v.rankSum / v.appearances) * 10) / 10,
      keywords: Array.from(v.keywords).slice(0, maxKw),
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
    });
  }
  out.sort((a, b) => b.appearances - a.appearances || a.avgRank - b.avgRank || a.domain.localeCompare(b.domain));
  return out;
}

// SEO Growth — the matching + action engine. PURE (no DB, no I/O): given a keyword opportunity and Zoe's
// committed page inventory, it decides CREATE / IMPROVE / CONSOLIDATE / SKIP with a plain-English reason.
//
// DESIGN LAW: "RULES CALCULATE, AI INTERPRETS." The decision is matched by INTENT + LOCATION + SERVICE
// CATEGORY + PAGE CONTENT — never keyword-string similarity alone. It deliberately avoids recommending a
// duplicate location page or a second page competing for the same intent: when a relevant page already
// exists it recommends IMPROVE, and when several already compete it recommends CONSOLIDATE.

import type { SeoIntent, SeoMatchResult, ZoePage } from "./types";

export interface MatchInput {
  keyword: string;
  intent: SeoIntent;
  location: string | null;
  category: string | null;
  relatedKeywords?: string[];
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "near", "me", "my", "your", "with", "best",
  "top", "cheap", "affordable", "rent", "rental", "rentals", "hire", "service", "services", "company", "dmv",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** A general (site-wide / DMV) location — not a specific geo. */
function isGeneralLocation(loc: string | null): boolean {
  if (!loc) return true;
  const l = loc.trim().toLowerCase();
  return l === "" || l === "dmv" || l === "us" || l === "united states";
}

const COMMERCIAL_KINDS = new Set<ZoePage["kind"]>(["home", "service", "category", "other"]);
const COMMERCIAL_INTENTS = new Set<SeoIntent>(["commercial", "transactional"]);

interface Scored {
  page: ZoePage;
  score: number;
  /** The topical signal only (max of category match and content overlap) — drives the relevance gate. */
  topical: number;
  why: string;
}

function scorePage(input: MatchInput, page: ZoePage): Scored {
  const kwTokens = new Set(tokenize([input.keyword, ...(input.relatedKeywords ?? [])].join(" ")));
  const pageBag = new Set(tokenize([page.title ?? "", page.h1 ?? "", page.headings.join(" "), page.topic, page.category ?? ""].join(" ")));

  // Content overlap: share of keyword tokens present in the page.
  let hits = 0;
  for (const t of kwTokens) if (pageBag.has(t)) hits++;
  const overlap = kwTokens.size ? hits / kwTokens.size : 0;

  // Category match: strongest signal.
  const categoryMatch = input.category && page.category ? (input.category === page.category ? 1 : 0) : 0;

  // Intent alignment.
  let intentAlign = 0.2;
  if (page.intent === input.intent) intentAlign = 1;
  else if (COMMERCIAL_INTENTS.has(page.intent) && COMMERCIAL_INTENTS.has(input.intent)) intentAlign = 0.6;

  // Location alignment: all Zoe pages are DMV-general today; a geo-specific keyword is only partially served.
  const locationAlign = isGeneralLocation(input.location) ? 1 : isGeneralLocation(page.location) ? 0.7 : page.location === input.location ? 1 : 0.4;

  // Kind fit for the opportunity's intent.
  const kindFit = COMMERCIAL_INTENTS.has(input.intent) ? (COMMERCIAL_KINDS.has(page.kind) ? 1 : 0.4) : page.kind === "blog" || page.kind === "info" ? 1 : 0.6;

  // Topical relevance = category match or content overlap ONLY. Intent/location/kind refine the blend but can
  // never make an off-topic keyword look relevant (a plumbing keyword must not match a tent page on intent alone).
  const topical = Math.max(categoryMatch, overlap);
  const score = 0.45 * categoryMatch + 0.3 * overlap + 0.12 * intentAlign + 0.07 * locationAlign + 0.06 * kindFit;

  const bits: string[] = [];
  if (categoryMatch) bits.push(`same category (${page.category})`);
  if (overlap > 0) bits.push(`${hits}/${kwTokens.size} keyword terms on page`);
  if (page.intent === input.intent) bits.push("intent matches");
  const why = bits.length ? bits.join(", ") : "weak overlap";
  return { page, score: Math.round(score * 1000) / 1000, topical: Math.round(topical * 1000) / 1000, why };
}

const RELEVANT_MIN = 0.2; // minimum topical signal to be worth pursuing
const STRONG = 0.5;

/**
 * Decide the editorial action for an opportunity against the inventory. Pure — deterministic given the same
 * inputs. The returned candidates are the top pages considered, best first, with why each scored as it did.
 */
export function matchOpportunity(input: MatchInput, pages: ZoePage[]): SeoMatchResult {
  const scored = pages.map((p) => scorePage(input, p)).sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 5).map((s) => ({ path: s.page.path, url: s.page.url, score: s.score, why: s.why }));

  // For commercial/transactional keywords, compare against commercial-capable pages (not a blog/FAQ).
  const commercialOpp = COMMERCIAL_INTENTS.has(input.intent);
  const pool = commercialOpp ? scored.filter((s) => COMMERCIAL_KINDS.has(s.page.kind)) : scored;
  const best = pool[0] ?? scored[0] ?? null;

  const base = (action: SeoMatchResult["action"], matched: Scored | null, confidence: number, reason: string): SeoMatchResult => ({
    action,
    matchedUrl: matched?.page.url ?? null,
    matchedPath: matched?.page.path ?? null,
    confidence: Math.max(0, Math.min(1, Math.round(confidence * 100) / 100)),
    reason,
    candidates,
  });

  if (!best) return base("SKIP", null, 0.2, "No Zoe pages are available to match against.");

  // CONSOLIDATE: two or more existing pages already compete for the same category — adding another would
  // cannibalize; recommend merging instead.
  if (input.category) {
    const sameCatStrong = scored.filter((s) => s.page.category === input.category && s.score >= STRONG);
    if (sameCatStrong.length >= 2) {
      const paths = sameCatStrong.slice(0, 3).map((s) => s.page.path).join(", ");
      return base("CONSOLIDATE", sameCatStrong[0], 0.6, `${sameCatStrong.length} existing pages already target "${input.category}" (${paths}); consolidate them to capture this keyword rather than adding another competing page.`);
    }
  }

  // Relevance is a TOPICAL judgment (category or content), not intent/location. A keyword in a Zoe category is
  // relevant by construction; otherwise it needs real topical overlap with an existing page.
  const topTopical = scored.reduce((mx, s) => Math.max(mx, s.topical), 0);
  const relevant = !!input.category || topTopical >= RELEVANT_MIN;

  // SKIP: nothing relevant and the keyword isn't in a Zoe category — not worth pursuing.
  if (!relevant) {
    return base("SKIP", null, 0.5, "Not aligned with Zoe's rental catalog or service pages, and no existing page is relevant — skip.");
  }

  // IMPROVE: a relevant page already exists. Improve it (and capture any geo term on it) rather than create a
  // duplicate location/intent page.
  if (best.score >= STRONG) {
    const geoNote = !isGeneralLocation(input.location) ? ` Capture the "${input.location}" geo on this existing page instead of creating a thin location-only page.` : "";
    return base("IMPROVE", best, Math.min(0.95, 0.5 + best.score / 2), `An existing page already targets this (${best.page.path}: ${best.why}). Improve it to rank for this keyword rather than create a duplicate.${geoNote}`);
  }

  // CREATE: category-relevant demand with no strong existing page — a genuine content gap.
  if (input.category || relevant) {
    const intentNote = commercialOpp ? "commercial-intent" : input.intent;
    return base("CREATE", null, Math.min(0.85, 0.45 + (1 - best.score)), `No existing page targets this ${intentNote} keyword${input.category ? ` for "${input.category}"` : ""} (closest is ${best.page.path} at ${best.score}). Create a dedicated page.`);
  }

  return base("SKIP", best, 0.4, `Only weak matches exist (best ${best.page.path} at ${best.score}) and the keyword isn't clearly in scope — skip for now.`);
}

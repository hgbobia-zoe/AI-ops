// SEO Growth — Ubersuggest PROJECT feed parser. Ubersuggest tracks Zoe's keywords weekly inside a project
// (rank tracking). A scheduled Claude task (signed in to the Ubersuggest connector) reads that report with the
// `project_position_info` tool and pushes each keyword entry to /api/seo/ingest with meta.source =
// "ubersuggest_project". This file turns one entry into our facts. PURE (no DB, no I/O).
//
// HONESTY: volume + SEO difficulty come straight from Ubersuggest. Zoe's position is only recorded when the
// tracker returned a FINAL reading (status "ok"): a position, or null = "not in the top 100". An "unstable" or
// "pending" reading leaves the rank UNKNOWN, never "not ranking".

import type { ParsedKeyword } from "./discovery";
import type { SeoMetrics } from "./types";

/** Google location IDs Ubersuggest uses → our locale label. Unknown IDs fall back to the numeric ID, so a
 *  project moved to a DMV location still ingests (as its own geo) without a code change. */
const LOCATIONS: Record<number, string> = {
  2840: "US",
};

export function locationLabel(locId: unknown): string {
  const n = typeof locId === "number" ? locId : Number(locId);
  if (!Number.isFinite(n)) return "US";
  return LOCATIONS[n] ?? `loc ${n}`;
}

// Keyword → Zoe category, aligned with SEED_CATEGORIES / zoe-pages so the matcher lines up. First hit wins, so
// the more specific phrases come first ("dance floor" before "floor", "chair and table" before "chair").
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/dance\s*floor/, "dance floors"],
  [/(table|tables).*(chair|chairs)|(chair|chairs).*(table|tables)/, "tables"],
  [/tent/, "tents"],
  [/chiavari|chair/, "chairs"],
  [/table/, "tables"],
  [/linen|tablecloth/, "linens"],
  [/stage|staging/, "staging"],
  [/lounge|sofa/, "lounge"],
  [/light/, "lighting"],
  [/bounce/, "bounce house"],
  [/marquee/, "marquee letters"],
  [/generator/, "power"],
  [/heater/, "heating & cooling"],
  [/pipe and drape|drape/, "pipe and drape"],
  [/bar\b/, "bars"],
  [/party rental|event rental|rentals?$/, "extras"],
];

export function inferCategory(keyword: string): string {
  const k = keyword.toLowerCase();
  for (const [re, cat] of CATEGORY_RULES) if (re.test(k)) return cat;
  return "uncategorized";
}

function num(x: unknown): number | undefined {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function position(p: unknown): { position: number | null; url: string | null; date: string | null } | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const pos = num(o.position);
  return { position: pos != null && pos >= 1 ? Math.round(pos) : null, url: typeof o.url === "string" ? o.url : null, date: typeof o.date === "string" ? o.date : null };
}

/** One keyword entry of a `project_position_info` report, as Ubersuggest returns it. */
export interface UbersuggestPositionEntry {
  keyword?: string;
  loc_id?: number;
  volume?: number | null;
  sd?: number | null;
  competition?: number | null;
  status?: string;
  old_position?: unknown;
  new_position?: unknown;
}

/**
 * Parse one rank-tracking entry into our facts. Metrics: volume, difficulty (Ubersuggest SD), paidDifficulty
 * (Ubersuggest's 0-1 ad competition, shown as 0-100). Rank fields only on a final ("ok") reading.
 */
export function parseUbersuggestPosition(raw: unknown): ParsedKeyword & { hasData: boolean } {
  const e = (raw && typeof raw === "object" ? raw : {}) as UbersuggestPositionEntry;
  const metrics: SeoMetrics = { locale: locationLabel(e.loc_id) };
  const vol = num(e.volume);
  const sd = num(e.sd);
  const comp = num(e.competition);
  if (vol != null) metrics.volume = vol;
  if (sd != null) metrics.difficulty = Math.min(100, sd);
  if (comp != null) metrics.paidDifficulty = Math.min(100, Math.round(comp <= 1 ? comp * 100 : comp));

  if (e.status === "ok") {
    const now = position(e.new_position);
    const before = position(e.old_position);
    metrics.trackedRank = now?.position ?? null;
    metrics.rankStatus = now?.position != null ? "ranking" : "not_top_100";
    metrics.rankUrl = now?.url ?? null;
    metrics.rankDate = now?.date ?? null;
    if (before) metrics.previousRank = before.position;
  }

  const hasMetrics = vol != null || sd != null || comp != null;
  return {
    metrics,
    hasMetrics,
    hasData: hasMetrics || metrics.rankStatus != null,
    relatedKeywords: [],
    competitorRefs: [],
    // Rank tracking carries no related keywords or competitor list: keep whatever another source stored.
    providesRefs: false,
    intent: null,
    source: "ubersuggest",
  };
}

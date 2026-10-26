// FI Stage 6 — item-level handling-time intelligence (audit G5). PURE: no DB, no network, no clock. From a
// project's line-item TITLES (the only item data we store — audit §2.5: no price, no quantity, no category),
// infer a PROVISIONAL operational-time estimate: setup + breakdown crew-minutes, via a CONFIGURABLE
// keyword→minutes map (config.ts `itemIntelligenceConfig`). Confidence is always LOW and the method is
// plainly "inferred from item titles".
//
// Governing laws enforced here: RULES CALCULATE, NEVER FABRICATE. This is a DISPLAY-ONLY operational-time
// estimate for context. It produces NO dollar figure, touches NO money math, and NEVER writes cost_entries
// — titles alone cannot honestly price labor. Empty/absent titles → UNAVAILABLE (available=false), never a
// fabricated zero-minute estimate. Every number comes from the passed-in config map; nothing is invented.

import type { ItemIntelligenceConfig } from "./config";

/** One line-item title's inferred handling contribution. `matchedKeywords` are the config keywords whose
 *  substring was found in the title (each adds its setup+breakdown minutes once for this item). */
export interface ItemHandlingLine {
  title: string;
  /** Base per-item minutes + the setup minutes of every matched keyword. */
  setupMin: number;
  /** The breakdown minutes of every matched keyword (base applies at setup only, not doubled at strike). */
  breakdownMin: number;
  matchedKeywords: string[];
}

export interface ItemHandlingEstimate {
  /** False when there are no usable titles → the estimate is UNAVAILABLE (never shown as 0). */
  available: boolean;
  /** Σ setup minutes across all items (delivery/install). */
  setupMinutes: number;
  /** Σ breakdown minutes across all items (pickup/strike). */
  breakdownMinutes: number;
  /** setupMinutes + breakdownMinutes — total crew-minutes of on-site handling implied by the titles. */
  totalMinutes: number;
  /** How many titles fed the estimate. */
  itemCount: number;
  /** Per-title lineage (which keywords drove the time) for the UI / audit. */
  lines: ItemHandlingLine[];
  /** Always LOW — this is inferred from titles, not measured. */
  confidence: "LOW";
  /** Always this exact string so the UI can label the provenance honestly. */
  method: "inferred from item titles";
  /** Distinct keywords that matched anywhere (for the recurring-category grouping in insights.ts). */
  keywords: string[];
}

const round0 = (n: number): number => Math.round(n);

/**
 * Infer a provisional handling-time estimate from a project's line-item titles. PURE + deterministic.
 * `titles` is the captured title list (bookings.lineItems); null/empty → UNAVAILABLE. `config` is the
 * keyword→minutes map (read once by the caller from `itemIntelligenceConfig()`), kept as a parameter so
 * this function stays pure and unit-testable without a DB.
 */
export function estimateHandlingTime(titles: readonly string[] | null | undefined, config: ItemIntelligenceConfig): ItemHandlingEstimate {
  const clean = (titles ?? []).map((t) => (typeof t === "string" ? t.trim() : "")).filter((t) => t.length > 0);
  if (clean.length === 0) {
    return {
      available: false,
      setupMinutes: 0,
      breakdownMinutes: 0,
      totalMinutes: 0,
      itemCount: 0,
      lines: [],
      confidence: "LOW",
      method: "inferred from item titles",
      keywords: [],
    };
  }

  const base = Math.max(0, config.baseMinutesPerItem);
  const rules = config.rules.map((r) => ({ ...r, keyword: r.keyword.trim().toLowerCase() })).filter((r) => r.keyword);

  const lines: ItemHandlingLine[] = [];
  const allKeywords = new Set<string>();
  let setupTotal = 0;
  let breakdownTotal = 0;

  for (const title of clean) {
    const lower = title.toLowerCase();
    let setup = base; // every line carries the baseline off/on-truck touch
    let breakdown = 0;
    const matched: string[] = [];
    const seen = new Set<string>();
    for (const r of rules) {
      if (seen.has(r.keyword)) continue; // a keyword counts at most once per item
      if (lower.includes(r.keyword)) {
        seen.add(r.keyword);
        matched.push(r.keyword);
        allKeywords.add(r.keyword);
        setup += r.setupMin;
        breakdown += r.breakdownMin;
      }
    }
    setup = round0(setup);
    breakdown = round0(breakdown);
    setupTotal += setup;
    breakdownTotal += breakdown;
    lines.push({ title, setupMin: setup, breakdownMin: breakdown, matchedKeywords: matched });
  }

  return {
    available: true,
    setupMinutes: round0(setupTotal),
    breakdownMinutes: round0(breakdownTotal),
    totalMinutes: round0(setupTotal + breakdownTotal),
    itemCount: clean.length,
    lines,
    confidence: "LOW",
    method: "inferred from item titles",
    keywords: [...allKeywords].sort(),
  };
}

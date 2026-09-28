// Linen / soft-goods detection over Goodshuffle line-item TITLES. Pure + deterministic (RULES
// CALCULATE — no LLM). Used by the signed→lost cancellation safeguard to decide whether a cancelled
// signed order carried linen (tablecloths, napkins, overlays, …) that might have a live sub-rental.
//
// NOTE: this matches line-item TITLES only. Whether a given linen line is specifically a SUB-RENTAL
// (something Zoe orders from a third party, and therefore has to cancel separately) is NOT encoded in
// the title — capturing the sub-rental flag in the pull is a future enhancement. Until then we flag ANY
// linen line so a human can confirm the sub-rental side was actually cancelled.

/** Base linen signals. Matched case-insensitively and whole-word-ish (with an optional plural suffix)
 *  so "spandex" can't hit inside an unrelated word and "napkin" still catches "napkins"/"sashes".
 *  Multi-word phrases (e.g. "table cloth", "chair cover") are matched as a unit. */
const LINEN_KEYWORDS = [
  "tablecloth",
  "table cloth",
  "linen",
  "napkin",
  "overlay",
  "table runner",
  "runner",
  "sash",
  "spandex",
  "chair cover",
  "chair sash",
  "chair cap",
  "drape",
  "draping",
  "cloth",
] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One combined, case-insensitive matcher. `\b…(?:es|s)?\b` gives whole-word matching with a lenient
// plural. No `g` flag, so `.test()` stays stateless across calls.
const LINEN_RE = new RegExp(
  "\\b(?:" + LINEN_KEYWORDS.map(escapeRegExp).join("|") + ")(?:es|s)?\\b",
  "i",
);

/** Return the subset of line-item titles that look like linen (order preserved, de-duplicated).
 *  Empty array when nothing matches, or when there are no titles to scan. */
export function detectLinenItems(titles: readonly string[] | null | undefined): string[] {
  if (!titles || titles.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of titles) {
    if (typeof t !== "string" || !t) continue;
    if (LINEN_RE.test(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

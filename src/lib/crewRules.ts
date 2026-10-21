// Crew-size rules — how many people a delivery needs, from its Goodshuffle line items.
// Deterministic (no LLM): fast, free, reliable. Zoe's rules:
//   • base = 1 (driver)
//   • any tent → at least 2 (driver + helper)
//   • a big tent (≥ 40×60) → at least 3
//   • an "Event Readiness Service" line → at least 2 (incident: one person was scheduled and it was a struggle)
//   • a HEAVY item (e.g. the Antique Rustic Solid Pine Folding Farm Table — 96"/8ft, big and heavy) → at least 2
// A route runs one truck/crew across its stops, so the ROUTE needs the MAX crew any of
// its stops needs (the same people do every stop).
//
// Every rule only ever RAISES the floor (Math.max): a heavy item floors crew at 2 but never lowers an
// already-higher requirement (a 40×60 tent still needs 3, with or without a heavy item on the order).

export interface LineItem {
  name: string;
  quantity?: number;
}

export interface CrewNeed {
  crew: number;
  reasons: string[];
  hasTent: boolean;
  /** Largest tent footprint seen, in sq ft (0 if none parsed). */
  biggestTentSqFt: number;
  /** An "Event Readiness Service" line item is present → the order needs at least 2 people. */
  hasEventReadiness: boolean;
  /** A configured HEAVY item is present → the order needs at least 2 people. */
  hasHeavyItem: boolean;
}

const TENT_RE = /\b(tent|canopy|marquee|sailcloth)\b/i;
// 40x60, 40 x 60, 40'x60', 40X60, 40×60
const DIM_RE = /(\d{1,3})\s*['’]?\s*[x×X]\s*['’]?\s*(\d{1,3})/;
// The Event Readiness Service add-on (tolerant to wording, e.g. "Event Readiness", "Event Readiness Service").
const EVENT_READINESS_RE = /event\s+readiness/i;

const BIG_TENT_SQFT = 40 * 60; // 2400

/** Out-of-the-box HEAVY-item line-item match (case-insensitive substring). The concrete item that drove this
 *  rule is the "Antique Rustic Solid Pine Folding Farm Table" (96"/8ft, big and heavy — its Goodshuffle note
 *  reads "Delivery only. The table is really big and Heavy, we do have a team and tools"). "folding farm table"
 *  is specific enough to catch that product's name without tripping on a plain "table", a "cocktail table" or a
 *  "banquet table". The team can broaden or add to this list in /admin (settings.heavyItemKeywords); this
 *  in-code list is the floor that applies before any admin edit. */
export const DEFAULT_HEAVY_ITEM_KEYWORDS: string[] = ["folding farm table"];

/** True when an item name contains any of the heavy-item keywords (case-insensitive substring). */
function matchesHeavy(name: string, keywords: string[]): boolean {
  const lower = name.toLowerCase();
  return keywords.some((k) => k && lower.includes(k.toLowerCase()));
}

/** Crew needed for a single stop/event's items. `heavyKeywords` is the heavy-item match list — defaults to the
 *  in-code floor (DEFAULT_HEAVY_ITEM_KEYWORDS) so the rule works before any admin edit; server callers pass the
 *  admin-editable settings.heavyItemKeywords so the team's edits take effect. */
export function crewForItems(items: LineItem[], heavyKeywords: string[] = DEFAULT_HEAVY_ITEM_KEYWORDS): CrewNeed {
  let crew = 1;
  let hasTent = false;
  let biggestTentSqFt = 0;
  let hasEventReadiness = false;
  let hasHeavyItem = false;
  let heavyItemName = "";
  const reasons: string[] = [];

  for (const item of items) {
    const name = item.name || "";
    if (EVENT_READINESS_RE.test(name)) hasEventReadiness = true;
    if (!hasHeavyItem && matchesHeavy(name, heavyKeywords)) {
      hasHeavyItem = true;
      heavyItemName = name;
    }
    if (!TENT_RE.test(name)) continue;
    hasTent = true;
    const m = name.match(DIM_RE);
    if (m) {
      const sqft = Number(m[1]) * Number(m[2]);
      if (sqft > biggestTentSqFt) biggestTentSqFt = sqft;
    }
  }

  if (hasTent) {
    crew = Math.max(crew, 2);
    reasons.push("tent → 2 crew");
  }
  if (biggestTentSqFt >= BIG_TENT_SQFT) {
    crew = Math.max(crew, 3);
    reasons.push(`${sqftLabel(biggestTentSqFt)} tent → 3 crew`);
  }
  if (hasEventReadiness) {
    crew = Math.max(crew, 2);
    reasons.push("Event Readiness Service → 2 crew");
  }
  if (hasHeavyItem) {
    crew = Math.max(crew, 2);
    reasons.push(heavyReason(heavyItemName));
  }

  return { crew, reasons, hasTent, biggestTentSqFt, hasEventReadiness, hasHeavyItem };
}

/** Crew a whole route needs = the max any of its stops needs (one crew does all stops). */
export function crewForRoute(
  stopItemLists: LineItem[][],
  heavyKeywords: string[] = DEFAULT_HEAVY_ITEM_KEYWORDS,
): CrewNeed {
  let best: CrewNeed = {
    crew: 1,
    reasons: [],
    hasTent: false,
    biggestTentSqFt: 0,
    hasEventReadiness: false,
    hasHeavyItem: false,
  };
  let anyEventReadiness = false;
  let anyHeavyItem = false;
  let heavyReasonLine = "";
  for (const items of stopItemLists) {
    const need = crewForItems(items, heavyKeywords);
    if (need.hasEventReadiness) anyEventReadiness = true;
    if (need.hasHeavyItem) {
      anyHeavyItem = true;
      if (!heavyReasonLine) heavyReasonLine = need.reasons.find((r) => r.startsWith("Heavy item")) ?? "";
    }
    if (need.crew > best.crew || (need.crew === best.crew && need.biggestTentSqFt > best.biggestTentSqFt)) {
      best = need;
    }
  }
  // Event Readiness / a heavy item can sit on a non-max stop (e.g. a tent stop needs 3 and dominates); the
  // ROUTE still carries it, so reflect the flag + the 2-crew floor even when the max stop had no such line.
  if (anyEventReadiness && !best.hasEventReadiness) {
    best = {
      ...best,
      hasEventReadiness: true,
      crew: Math.max(best.crew, 2),
      reasons: [...best.reasons, "Event Readiness Service → 2 crew"],
    };
  }
  if (anyHeavyItem && !best.hasHeavyItem) {
    best = {
      ...best,
      hasHeavyItem: true,
      crew: Math.max(best.crew, 2),
      reasons: [...best.reasons, heavyReasonLine || heavyReason("heavy item")],
    };
  }
  return best;
}

function heavyReason(itemName: string): string {
  const label = itemName.trim() || "heavy item";
  return `Heavy item (${label}) requires >= 2 crew`;
}

function sqftLabel(sqft: number): string {
  // Show a friendly dimension when it's a clean rectangle we recognize, else the area.
  if (sqft >= BIG_TENT_SQFT) return "large";
  return `${sqft} sq ft`;
}

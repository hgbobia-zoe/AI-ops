// Crew-size rules — how many people a delivery needs, from its Goodshuffle line items.
// Deterministic (no LLM): fast, free, reliable. Zoe's rules:
//   • base = 1 (driver)
//   • any tent → at least 2 (driver + helper)
//   • a big tent (≥ 40×60) → at least 3
//   • an "Event Readiness Service" line → at least 2 (incident: one person was scheduled and it was a struggle)
// A route runs one truck/crew across its stops, so the ROUTE needs the MAX crew any of
// its stops needs (the same people do every stop).

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
}

const TENT_RE = /\b(tent|canopy|marquee|sailcloth)\b/i;
// 40x60, 40 x 60, 40'x60', 40X60, 40×60
const DIM_RE = /(\d{1,3})\s*['’]?\s*[x×X]\s*['’]?\s*(\d{1,3})/;
// The Event Readiness Service add-on (tolerant to wording, e.g. "Event Readiness", "Event Readiness Service").
const EVENT_READINESS_RE = /event\s+readiness/i;

const BIG_TENT_SQFT = 40 * 60; // 2400

/** Crew needed for a single stop/event's items. */
export function crewForItems(items: LineItem[]): CrewNeed {
  let crew = 1;
  let hasTent = false;
  let biggestTentSqFt = 0;
  let hasEventReadiness = false;
  const reasons: string[] = [];

  for (const item of items) {
    const name = item.name || "";
    if (EVENT_READINESS_RE.test(name)) hasEventReadiness = true;
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

  return { crew, reasons, hasTent, biggestTentSqFt, hasEventReadiness };
}

/** Crew a whole route needs = the max any of its stops needs (one crew does all stops). */
export function crewForRoute(stopItemLists: LineItem[][]): CrewNeed {
  let best: CrewNeed = { crew: 1, reasons: [], hasTent: false, biggestTentSqFt: 0, hasEventReadiness: false };
  let anyEventReadiness = false;
  for (const items of stopItemLists) {
    const need = crewForItems(items);
    if (need.hasEventReadiness) anyEventReadiness = true;
    if (need.crew > best.crew || (need.crew === best.crew && need.biggestTentSqFt > best.biggestTentSqFt)) {
      best = need;
    }
  }
  // Event Readiness can sit on a non-max stop (e.g. a tent stop needs 3 and dominates); the ROUTE still
  // carries it, so reflect the flag + the 2-crew floor even when the max stop had no readiness line.
  if (anyEventReadiness && !best.hasEventReadiness) {
    best = { ...best, hasEventReadiness: true, crew: Math.max(best.crew, 2), reasons: [...best.reasons, "Event Readiness Service → 2 crew"] };
  }
  return best;
}

function sqftLabel(sqft: number): string {
  // Show a friendly dimension when it's a clean rectangle we recognize, else the area.
  if (sqft >= BIG_TENT_SQFT) return "large";
  return `${sqft} sq ft`;
}

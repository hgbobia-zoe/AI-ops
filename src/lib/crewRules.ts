// Crew-size rules — how many people a delivery needs, from its Goodshuffle line items.
// Deterministic (no LLM): fast, free, reliable. Zoe's rules:
//   • base = 1 (driver)
//   • any tent → at least 2 (driver + helper)
//   • a big tent (≥ 40×60) → at least 3
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
}

const TENT_RE = /\b(tent|canopy|marquee|sailcloth)\b/i;
// 40x60, 40 x 60, 40'x60', 40X60, 40×60
const DIM_RE = /(\d{1,3})\s*['’]?\s*[x×X]\s*['’]?\s*(\d{1,3})/;

const BIG_TENT_SQFT = 40 * 60; // 2400

/** Crew needed for a single stop/event's items. */
export function crewForItems(items: LineItem[]): CrewNeed {
  let crew = 1;
  let hasTent = false;
  let biggestTentSqFt = 0;
  const reasons: string[] = [];

  for (const item of items) {
    const name = item.name || "";
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

  return { crew, reasons, hasTent, biggestTentSqFt };
}

/** Crew a whole route needs = the max any of its stops needs (one crew does all stops). */
export function crewForRoute(stopItemLists: LineItem[][]): CrewNeed {
  let best: CrewNeed = { crew: 1, reasons: [], hasTent: false, biggestTentSqFt: 0 };
  for (const items of stopItemLists) {
    const need = crewForItems(items);
    if (need.crew > best.crew || (need.crew === best.crew && need.biggestTentSqFt > best.biggestTentSqFt)) {
      best = need;
    }
  }
  return best;
}

function sqftLabel(sqft: number): string {
  // Show a friendly dimension when it's a clean rectangle we recognize, else the area.
  if (sqft >= BIG_TENT_SQFT) return "large";
  return `${sqft} sq ft`;
}

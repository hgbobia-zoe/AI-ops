// Is a route "specialty / harder"? — the signal the driver seniority router uses to decide which same-time
// route a SENIOR driver should take (and which EASIER one goes to a newer driver). PURE + deterministic
// (RULES CALCULATE): a route is specialty when it carries a tent (crewRules, the built-in rule) OR any item
// matching the team's configurable keyword list (settings.specialtyItemKeywords). `difficulty` is a sortable
// score so, among several specialty routes starting together, the hardest ranks first.

import { crewForRoute, type LineItem } from "@/lib/crewRules";

export interface RouteSpecialty {
  /** True when the route carries any specialty signal (tent or a keyword match). */
  specialty: boolean;
  /** Sortable difficulty: large tent (3) > tent (2); each distinct keyword match adds 1. Higher = harder. */
  difficulty: number;
  /** Human-free signals behind the verdict ("large tent", "tent", "dance floor", …) for audit/narration. */
  reasons: string[];
}

/** PURE core: the specialty verdict for a route's stop item-lists against the keyword list. */
export function specialtyForItemLists(stopItemLists: LineItem[][], keywords: string[]): RouteSpecialty {
  const reasons: string[] = [];
  let difficulty = 0;

  // Tents are the built-in rule (crewRules). A big tent (>=40x60) escalates to 3 crew — treat it as harder.
  const need = crewForRoute(stopItemLists);
  if (need.hasTent) {
    const big = need.crew >= 3;
    difficulty += big ? 3 : 2;
    reasons.push(big ? "large tent" : "tent");
  }

  // Configurable keyword matches across every stop's items (each distinct keyword counts once).
  const kw = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  const matched = new Set<string>();
  for (const items of stopItemLists) {
    for (const it of items) {
      const name = (it.name || "").toLowerCase();
      for (const k of kw) {
        if (!matched.has(k) && name.includes(k)) {
          matched.add(k);
          difficulty += 1;
          reasons.push(k);
        }
      }
    }
  }

  return { specialty: difficulty > 0, difficulty, reasons };
}

/** Convenience wrapper over a Route-shaped object (stops carrying optional items). */
export function routeSpecialty(route: { stops: Array<{ items?: LineItem[] }> }, keywords: string[]): RouteSpecialty {
  return specialtyForItemLists(route.stops.map((s) => s.items ?? []), keywords);
}

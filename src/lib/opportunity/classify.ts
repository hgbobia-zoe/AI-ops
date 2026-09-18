// Opportunity Radar — deterministic classifiers (RULES CALCULATE). Zoe rental categories from
// keywords, entity kind → relationship role, and the "who should Zoe approach?" primary-target picker.
// No AI here; AI only *enriches* these later (never overrides a rule silently).

import { ZOE_CATEGORY_KEYWORDS, EVENT_RELEVANCE_KEYWORDS } from "./config";
import type { EntityKind, RelationshipRole, ZoeCategory } from "./types";

/** Zoe rental categories implied by an opportunity's text. Deterministic, order-independent, deduped. */
export function classifyZoeCategories(text: string): ZoeCategory[] {
  const found = new Set<ZoeCategory>();
  for (const { category, patterns } of ZOE_CATEGORY_KEYWORDS) if (patterns.test(text)) found.add(category);
  return [...found];
}

/** Whether the text is event-adjacent at all (used to keep obviously-irrelevant procurement out). */
export function isEventRelevant(text: string): boolean {
  return EVENT_RELEVANCE_KEYWORDS.test(text) || classifyZoeCategories(text).length > 0;
}

/** Default relationship role for an entity kind on an opportunity (a starting classification a human or
 *  AI can refine). */
export function roleForEntityKind(kind: EntityKind): RelationshipRole {
  switch (kind) {
    case "AGENCY": return "DIRECT_BUYER";
    case "PRIME": return "PRIME_CONTRACTOR";
    case "EVENT_PLANNER": return "EVENT_PLANNER";
    case "FACILITIES": return "FACILITIES_CONTRACTOR";
    case "PRODUCTION": return "PRODUCTION";
    case "CATERING": return "PARTNER";
    case "VENDOR": return "VENDOR";
    case "PARTNER": return "PARTNER";
    case "CONTACT": return "PROCUREMENT_CONTACT";
    default: return "UNKNOWN";
  }
}

// Who is the most useful company/person for Zoe to approach? Rental subs typically sit UNDER an event
// manager / planner / prime, not the government buyer directly — so the deterministic preference favors
// the commercial path. Lower index = better target. (§7 "who is the most useful person for Zoe?")
const TARGET_PREFERENCE: RelationshipRole[] = [
  "EVENT_MGMT",
  "EVENT_PLANNER",
  "PRODUCTION",
  "PRIME_CONTRACTOR",
  "FACILITIES_CONTRACTOR",
  "PARTNER",
  "PROCUREMENT_CONTACT",
  "DIRECT_BUYER",
  "VENDOR",
  "UNKNOWN",
];

export function targetRank(role: RelationshipRole): number {
  const i = TARGET_PREFERENCE.indexOf(role);
  return i === -1 ? TARGET_PREFERENCE.length : i;
}

/** Pick the best primary-target relationship from those present on an opportunity. Returns null when
 *  none are known (→ the UI recommends "identify a contact"). */
export function pickPrimaryTargetRole(roles: RelationshipRole[]): RelationshipRole | null {
  if (roles.length === 0) return null;
  return [...roles].sort((a, b) => targetRank(a) - targetRank(b))[0];
}

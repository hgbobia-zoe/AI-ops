// Opportunity Radar — deterministic jurisdiction classification. Maps an opportunity's agency/location
// text (and its already-normalized DMV geo Region) onto a Jurisdiction. Expandable: add one entry.

import { normalizeRegion, isInServiceArea, type Region } from "@/lib/radar/geo";
import type { Jurisdiction } from "./types";

const AGENCY_PATTERNS: { jurisdiction: Jurisdiction; patterns: RegExp }[] = [
  { jurisdiction: "ROCKVILLE", patterns: /\bcity of rockville\b|\brockville\b/i },
  { jurisdiction: "GAITHERSBURG", patterns: /\bcity of gaithersburg\b|\bgaithersburg\b/i },
  { jurisdiction: "MONTGOMERY_CO", patterns: /\bmontgomery county\b|\bmontgomery co\b|\bmcps\b|\bmoco\b/i },
  { jurisdiction: "PRINCE_GEORGES_CO", patterns: /\bprince george'?s county\b|\bpgcps\b/i },
  { jurisdiction: "HOWARD_CO", patterns: /\bhoward county\b/i },
  { jurisdiction: "BALTIMORE", patterns: /\bbaltimore\b/i },
  { jurisdiction: "DC", patterns: /\bdistrict of columbia\b|\bwashington,?\s*dc\b|\bd\.?c\.? government\b/i },
  { jurisdiction: "STATE_MD", patterns: /\bstate of maryland\b|\bmaryland\b|\bemma\b|\bemaryland\b/i },
  { jurisdiction: "FEDERAL", patterns: /\b(federal|department of|u\.?s\.?\s|national|administration|sam\.gov|gsa|army|navy|air force|nih|nasa|dhs|va\b)\b/i },
];

// Map a DMV geo Region onto its default jurisdiction when the agency text is silent.
const REGION_TO_JURISDICTION: Partial<Record<Region, Jurisdiction>> = {
  DC: "DC",
  MONTGOMERY_MD: "MONTGOMERY_CO",
  PRINCE_GEORGES_MD: "PRINCE_GEORGES_CO",
  HOWARD_MD: "HOWARD_CO",
  BALTIMORE: "BALTIMORE",
  NOVA: "NOVA",
};

/** Classify jurisdiction from (in priority order) the agency/notice text, then the location Region.
 *  Returns UNKNOWN when nothing matches — never guessed. */
export function normalizeJurisdiction(parts: { agency?: string | null; text?: string | null; region?: Region }): Jurisdiction {
  const hay = [parts.agency, parts.text].filter(Boolean).join(" ");
  if (hay.trim()) {
    for (const { jurisdiction, patterns } of AGENCY_PATTERNS) if (patterns.test(hay)) return jurisdiction;
  }
  if (parts.region && REGION_TO_JURISDICTION[parts.region]) return REGION_TO_JURISDICTION[parts.region]!;
  if (parts.region === "OUT_OF_AREA") return "OTHER";
  return "UNKNOWN";
}

/** True when this jurisdiction is within Zoe's service footprint (all DMV jurisdictions are). */
export function jurisdictionInServiceArea(j: Jurisdiction): boolean {
  return j !== "OTHER" && j !== "UNKNOWN";
}

export { normalizeRegion, isInServiceArea };

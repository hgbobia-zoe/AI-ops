// Event Radar — geography. Zoe's initial DMV service area, modelled so it can expand later: a region
// is a named area with the city/keyword patterns that map to it. normalizeRegion() classifies an
// event's city/address into a region (or OUT_OF_AREA / UNKNOWN). Adding a market later = one entry.

export type Region =
  | "DC"
  | "MONTGOMERY_MD"
  | "PRINCE_GEORGES_MD"
  | "NOVA"
  | "BALTIMORE"
  | "HOWARD_MD"
  | "OUT_OF_AREA"
  | "UNKNOWN";

export const REGION_LABEL: Record<Region, string> = {
  DC: "Washington, DC",
  MONTGOMERY_MD: "Montgomery County, MD",
  PRINCE_GEORGES_MD: "Prince George's County, MD",
  NOVA: "Northern Virginia",
  BALTIMORE: "Baltimore",
  HOWARD_MD: "Howard County, MD",
  OUT_OF_AREA: "Outside service area",
  UNKNOWN: "Unknown location",
};

/** In-service-area regions (everything except OUT_OF_AREA / UNKNOWN). */
export const SERVICE_REGIONS: Region[] = ["DC", "MONTGOMERY_MD", "PRINCE_GEORGES_MD", "NOVA", "BALTIMORE", "HOWARD_MD"];

export function isInServiceArea(region: Region): boolean {
  return SERVICE_REGIONS.includes(region);
}

// City / keyword patterns per region. Lowercased substring match against "city, state, address".
const REGION_PATTERNS: { region: Region; patterns: RegExp }[] = [
  { region: "DC", patterns: /\b(washington,?\s*dc|washington d\.?c\.?|\bdc\b|district of columbia)\b/i },
  {
    region: "MONTGOMERY_MD",
    patterns: /\b(bethesda|rockville|silver spring|gaithersburg|germantown|montgomery county|chevy chase|potomac|north bethesda)\b/i,
  },
  {
    region: "PRINCE_GEORGES_MD",
    patterns: /\b(national harbor|college park|hyattsville|bowie|greenbelt|largo|upper marlboro|prince george|oxon hill|laurel)\b/i,
  },
  {
    region: "NOVA",
    patterns: /\b(arlington|alexandria|tysons|mclean|reston|fairfax|vienna|falls church|ashburn|dulles|herndon|springfield|northern virginia)\b/i,
  },
  { region: "BALTIMORE", patterns: /\b(baltimore|inner harbor|towson)\b/i },
  { region: "HOWARD_MD", patterns: /\b(columbia,?\s*md|ellicott city|howard county|fulton,?\s*md)\b/i },
];

// States that are unambiguously outside the DMV service area when no in-area pattern matched.
const OUT_OF_AREA_STATE = /\b(NY|CA|TX|FL|IL|GA|MA|WA|OR|NV|AZ|CO|PA|OH|MI|NC|TN|New York|California|Texas|Florida|Illinois|Georgia|Nevada|Arizona)\b/;

/** Classify a location into a Region. Order matters: an explicit in-area match wins over a state guess.
 *  Returns UNKNOWN when we genuinely can't tell (never guessed as in-area). */
export function normalizeRegion(parts: { city?: string | null; state?: string | null; address?: string | null }): Region {
  const hay = [parts.city, parts.state, parts.address].filter(Boolean).join(", ");
  if (!hay.trim()) return "UNKNOWN";
  for (const { region, patterns } of REGION_PATTERNS) {
    if (patterns.test(hay)) return region;
  }
  // Maryland / Virginia without a recognized sub-area → keep as UNKNOWN sub-area but still in-area-ish?
  // Be conservative: a bare "MD"/"VA" is likely servable, but we don't know the county, so UNKNOWN.
  if (OUT_OF_AREA_STATE.test(hay)) return "OUT_OF_AREA";
  return "UNKNOWN";
}

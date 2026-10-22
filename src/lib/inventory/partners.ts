// Partner + Zoe-category shapes for the Inventory Automation blade.
//
// Zoe is sub-renting a partner's catalog and bulk-copying it into Zoe's own Goodshuffle inventory. Each
// partner carries the partner's PUBLIC storefront token plus one or more group mappings: a set of the
// partner's source groups copied onto ONE Zoe destination category. Partners used to be a hardcoded const;
// they now live in team-editable settings (src/lib/settings.ts), so adding a partner is a runtime config
// change — no deploy. This module stays PURE (types + seeds + pure helpers, no DB / settings import) so both
// the server (settings + service) and the client component can import it.
//
// SPLIT OF CONCERNS vs. the old single-preset model:
//   • A mapping no longer bakes in the resolved Goodshuffle category id. It names a `targetCategory` (a human
//     name, e.g. "Sofas") that references an entry in the ZoeCategory registry below. The importer resolves
//     the numeric id from that registry at plan time and FAILS CLOSED if a name has no id. This keeps the one
//     place a Goodshuffle category id is hand-captured (the registry) separate from the many partner mappings.

/** Zoe's OWN public storefront token — used to pull Zoe's current catalog for the dedupe check. */
export const ZOE_VENDOR_TOKEN = "y2lcwfwX40RpfPiD6jorw7ipHI6gUK";

/**
 * A Zoe destination category: the human name (which is ALSO the Goodshuffle primaryCategoryName) and the
 * resolved Goodshuffle `primaryCategoryID`. Zoe category ids are internal and have no clean public lookup, so
 * this registry is seeded by hand and extended in /admin (name + id) when a new destination category is used.
 */
export interface ZoeCategory {
  name: string; //              human name == Goodshuffle primaryCategoryName, e.g. "Sofas"
  primaryCategoryID: number; // resolved Goodshuffle category id, e.g. 657
}

/** How a partner's source groups map onto ONE Zoe destination category. No numeric id here — `targetCategory`
 *  references a ZoeCategory by name, resolved at plan time. */
export interface PartnerMapping {
  key: string; //           stable id for UI selection (derived from the first source group when added)
  label: string; //         human label (defaults to the source group's display name)
  sourceGroups: string[]; // storefront `groups` slugs to pull, e.g. ["sofa-rentals","settee-rentals"]
  targetCategory: string; // references a ZoeCategory.name, e.g. "Sofas"
  baseTag: string; //        the base tag every copied item of this group carries, e.g. "Sofa"
}

/** A configured partner storefront. */
export interface InventoryPartner {
  id: string; //           stable id, e.g. "staging-design"
  name: string; //         display name
  storefrontUrl: string; //the partner's public storefront link (provenance + re-resolve); may be ""
  vendorToken: string; //  the partner's public storefront vendor token (what the data API needs)
  internalNote: string; // stamped on every copied item for provenance, e.g. "Subrent from Staging Design DC."
  mappings: PartnerMapping[];
}

/** Seed Zoe-category registry. Resolved LIVE against Zoe's own catalog (verified 2026-10-22). Extend in
 *  /admin — the id comes from an existing item already filed under that category in Goodshuffle. */
export const DEFAULT_ZOE_CATEGORIES: ZoeCategory[] = [
  { name: "Sofas", primaryCategoryID: 657 },
  { name: "Stools", primaryCategoryID: 661 },
];

/** Seed partner list — equal to the original hardcoded Staging Design preset (token + mappings VERIFIED
 *  against the live storefront data API). */
export const DEFAULT_INVENTORY_PARTNERS: InventoryPartner[] = [
  {
    id: "staging-design",
    name: "Staging Design DC",
    storefrontUrl: "https://stagingdesigndc.com",
    vendorToken: "fuEHaRKBUIx6FjSFoniRdvWRBi6ESA",
    internalNote: "Subrent from Staging Design DC.",
    mappings: [
      { key: "sofas", label: "Sofas", sourceGroups: ["sofa-rentals", "settee-rentals"], targetCategory: "Sofas", baseTag: "Sofa" },
      { key: "barstools", label: "Barstools", sourceGroups: ["stools-rentals"], targetCategory: "Stools", baseTag: "Barstool" },
    ],
  },
];

// ── Pure helpers (shared by settings default, the settings coercers, and the plan service) ───────────────

const asStr = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const asStrArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => asStr(x).trim()).filter(Boolean) : [];

/** Slugify a label into a stable key fragment (lowercase, non-alnum → "-", trimmed). */
export function slugify(input: string): string {
  return asStr(input).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Coerce arbitrary input into a clean ZoeCategory[]. Drops entries without a name or a finite id; de-dupes
 *  by lowercased name (first wins). Never throws. Returns `fallback` only when `v` is not an array. */
export function coerceZoeCategories(v: unknown, fallback: ZoeCategory[]): ZoeCategory[] {
  if (!Array.isArray(v)) return fallback;
  const seen = new Set<string>();
  const out: ZoeCategory[] = [];
  for (const raw of v) {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = asStr(o.name).trim();
    const id = typeof o.primaryCategoryID === "number" ? o.primaryCategoryID : Number(o.primaryCategoryID);
    if (!name || !Number.isFinite(id)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, primaryCategoryID: id });
  }
  return out;
}

/** Coerce one raw mapping into a clean PartnerMapping, or null if it has no usable source groups. */
function coerceMapping(raw: unknown): PartnerMapping | null {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sourceGroups = asStrArray(o.sourceGroups);
  if (sourceGroups.length === 0) return null;
  const targetCategory = asStr(o.targetCategory).trim();
  const label = asStr(o.label).trim() || sourceGroups[0];
  const key = asStr(o.key).trim() || slugify(label) || slugify(sourceGroups[0]);
  const baseTag = asStr(o.baseTag).trim();
  return { key, label, sourceGroups, targetCategory, baseTag };
}

/** Coerce arbitrary input into a clean InventoryPartner[]. Drops partners with no id/name or no valid
 *  mapping; de-dupes by id (first wins). Never throws. Returns `fallback` only when `v` is not an array. */
export function coerceInventoryPartners(v: unknown, fallback: InventoryPartner[]): InventoryPartner[] {
  if (!Array.isArray(v)) return fallback;
  const seen = new Set<string>();
  const out: InventoryPartner[] = [];
  for (const raw of v) {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = asStr(o.name).trim();
    const id = asStr(o.id).trim() || slugify(name);
    if (!id || !name) continue;
    const mappings = (Array.isArray(o.mappings) ? o.mappings : []).map(coerceMapping).filter((m): m is PartnerMapping => !!m);
    if (mappings.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      storefrontUrl: asStr(o.storefrontUrl).trim(),
      vendorToken: asStr(o.vendorToken).trim(),
      internalNote: asStr(o.internalNote).trim(),
      mappings,
    });
  }
  return out;
}

/** Look up a partner by id, or null. */
export function getInventoryPartner(partners: InventoryPartner[], id: string): InventoryPartner | null {
  return partners.find((p) => p.id === id) ?? null;
}

/** Build a name → primaryCategoryID lookup from the registry (case-insensitive on name). */
export function zoeCategoryIndex(cats: ZoeCategory[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cats) m.set(c.name.trim().toLowerCase(), c.primaryCategoryID);
  return m;
}

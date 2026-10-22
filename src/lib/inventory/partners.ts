// Partner presets for the Inventory Automation blade.
//
// Zoe is sub-renting a partner's catalog and bulk-copying it into Zoe's own Goodshuffle inventory. Each
// partner preset carries the partner's PUBLIC storefront token plus one or more group mappings: how a set
// of the partner's source groups (under a source category) maps onto ONE Zoe group. Adding a new partner
// later is just another entry in PARTNER_PRESETS — no code changes elsewhere.
//
// Tokens + mappings below are VERIFIED against the live storefront data API (data.goodshuffle.com).

/**
 * How a partner's source groups map onto a single Zoe destination group — and the RESOLVED Goodshuffle
 * category this group's items are created under. The category IDs below were resolved LIVE against Zoe's
 * own catalog (verified 2026-10-22), so the WRITE step needs NO manual capture: the importer sends only the
 * category (the server derives the root group — Furniture — from it; a create that also sends rootGroupID
 * is wrong). `baseTag` is the tag every item of this group always gets (e.g. "Sofa").
 */
export interface GroupMapping {
  key: string; //                stable id for UI selection, e.g. "sofas"
  label: string; //              human label, e.g. "Sofas"
  sourceCategory: string; //     storefront `categories` filter, e.g. "furniture-rentals"
  sourceGroups: string[]; //     storefront `groups` slugs to pull, e.g. ["sofa-rentals","settee-rentals"]
  zoeGroup: string; //           the Zoe group slug copied items land in, e.g. "sofa-rentals"
  primaryCategoryID: number; //  resolved Goodshuffle category id (e.g. 657 = Sofas). NO rootGroup is sent.
  primaryCategoryName: string; //resolved Goodshuffle category name (e.g. "Sofas")
  baseTag: string; //            the base tag every copied item of this group carries (e.g. "Sofa")
}

export interface PartnerPreset {
  key: string; //      stable id, e.g. "staging-design"
  label: string; //    display name
  token: string; //    the partner's public storefront vendor token
  mappings: GroupMapping[];
}

/** Zoe's OWN public storefront token — used to pull Zoe's current catalog for the dedupe check. */
export const ZOE_VENDOR_TOKEN = "y2lcwfwX40RpfPiD6jorw7ipHI6gUK";

export const PARTNER_PRESETS: PartnerPreset[] = [
  {
    key: "staging-design",
    label: "Staging Design DC",
    token: "fuEHaRKBUIx6FjSFoniRdvWRBi6ESA",
    mappings: [
      {
        key: "sofas",
        label: "Sofas",
        sourceCategory: "furniture-rentals",
        sourceGroups: ["sofa-rentals", "settee-rentals"],
        zoeGroup: "sofa-rentals",
        primaryCategoryID: 657,
        primaryCategoryName: "Sofas",
        baseTag: "Sofa",
      },
      {
        key: "barstools",
        label: "Barstools",
        sourceCategory: "furniture-rentals",
        sourceGroups: ["stools-rentals"],
        zoeGroup: "stools-rentals",
        primaryCategoryID: 661,
        primaryCategoryName: "Stools",
        baseTag: "Barstool",
      },
    ],
  },
];

/** Look up a partner preset by key, or null. */
export function getPartnerPreset(key: string): PartnerPreset | null {
  return PARTNER_PRESETS.find((p) => p.key === key) ?? null;
}

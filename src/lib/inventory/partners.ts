// Partner presets for the Inventory Automation blade.
//
// Zoe is sub-renting a partner's catalog and bulk-copying it into Zoe's own Goodshuffle inventory. Each
// partner preset carries the partner's PUBLIC storefront token plus one or more group mappings: how a set
// of the partner's source groups (under a source category) maps onto ONE Zoe group. Adding a new partner
// later is just another entry in PARTNER_PRESETS — no code changes elsewhere.
//
// Tokens + mappings below are VERIFIED against the live storefront data API (data.goodshuffle.com).

/** How a partner's source groups map onto a single Zoe destination group. */
export interface GroupMapping {
  key: string; //            stable id for UI selection, e.g. "sofas"
  label: string; //          human label, e.g. "Sofas"
  sourceCategory: string; // storefront `categories` filter, e.g. "furniture-rentals"
  sourceGroups: string[]; // storefront `groups` slugs to pull, e.g. ["sofa-rentals","settee-rentals"]
  zoeGroup: string; //       the Zoe group slug copied items land in, e.g. "sofa-rentals"
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
      },
      {
        key: "barstools",
        label: "Barstools",
        sourceCategory: "furniture-rentals",
        sourceGroups: ["stools-rentals"],
        zoeGroup: "stools-rentals",
      },
    ],
  },
];

/** Look up a partner preset by key, or null. */
export function getPartnerPreset(key: string): PartnerPreset | null {
  return PARTNER_PRESETS.find((p) => p.key === key) ?? null;
}

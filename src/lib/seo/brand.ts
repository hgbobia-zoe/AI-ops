// SEO Growth — Zoe brand FACTS for the page scaffolder. FACTS ONLY: everything here is verified from Zoe's
// own live site (the home page title/excerpt + the on-site rental-process section captured in zoe-pages.ts).
// Nothing here is an estimate, a price, an inventory count, a guarantee, or a testimonial — those are exactly
// the things the scaffolder must NOT invent and instead flags for a human (see quality.ts).

export const ZOE_BRAND = {
  /** Legal/display name — from the home <title>. */
  name: "Zoe Events & Party Rentals",
  shortName: "Zoe Events",
  site: "https://zoeeventsdmv.com",
  /** Verified service geography — from the home-page excerpt. */
  serviceArea: "Washington DC, Maryland, and Virginia (the DMV)",
  serviceAreaShort: "the DMV",
  /** The service categories Zoe serves (DMV-wide). Safe, non-specific framing. */
  tagline: "Luxury event rentals for weddings, corporate events, and social gatherings.",
  /** Jurisdictions for schema `areaServed`. Factual (the three DMV jurisdictions). */
  areaServed: ["Washington, DC", "Maryland", "Virginia"] as readonly string[],
  /**
   * Zoe's real, on-site rental process (home-page headings: "Create Your Wishlist / Review Your Quote /
   * Reserve Your Items"). Safe to reuse as SOURCED copy — it describes how the business actually works and
   * states no price, fee, or guarantee.
   */
  processSteps: [
    { title: "Create your wishlist", body: "Browse the inventory and add the pieces you love to a wishlist for your event." },
    { title: "Review your quote", body: "We put together a quote covering the items and delivery so you can review every detail before committing." },
    { title: "Reserve your items", body: "Approve the quote to reserve your items for your event date." },
  ] as const,
  /** Contact/quote path on the live site (from the inventory + contact pages). */
  contactPath: "/contact",
} as const;

export type ZoeBrand = typeof ZOE_BRAND;

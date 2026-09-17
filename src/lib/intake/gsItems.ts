// Goodshuffle line items the intake automation adds to a new quote shell. IDs + rate config captured
// live on a TEST project (2026-09-16). The add endpoint is POST /app/transactionItemRelation/
// addInventoryItemToContract; each item carries its inventory type + rate type from its Goodshuffle
// config. Services under "General Services / Administrative" add on a bare shell (no location needed);
// LOGISTICS items (mileage-based delivery, Event Readiness) are rejected until a delivery LOCATION is
// set, so those stay behind LOGISTICS_LOCATION_READY until the venue write is wired.

export interface GsAddItem {
  itemID: number;
  inventoryTypeStr: string; // "SERVICE"
  rateType: string; // "PERCENT_OF_ORDER" | "FLAT_FEE" | "FLAT_FEE_WITH_MILEAGE" | ...
  unitPrice: number; // 0 = use the item's configured price
  quantity: number;
  label: string;
}

// On EVERY quote: Unintentional Damage Waiver (10% of order, $20 min) — a service, no location needed.
export const DAMAGE_WAIVER: GsAddItem = { itemID: 392871251, inventoryTypeStr: "SERVICE", rateType: "PERCENT_OF_ORDER", unitPrice: 0, quantity: 1, label: "Unintentional Damage Waiver" };

// Delivery is TWO separate customer-clear line items, deliberately split (per the sales rep):
//
//  1. BASE DELIVERY — the calculated mileage charge. LOCATION-DEPENDENT (Goodshuffle computes it from
//     the delivery location, so the add is rejected until a venue is set). Gated on LOGISTICS_LOCATION_READY.
export const BASE_DELIVERY: GsAddItem = { itemID: 392868144, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE_WITH_MILEAGE", unitPrice: 0, quantity: 1, label: "Delivery (mileage)" };

//  2. TIME-WINDOW UPGRADE — a flat premium the customer pays to narrow the delivery window, ON TOP of
//     base delivery. Created 2026-09-16 as General Services / Administrative items (flat fee, NOT
//     location-dependent), so these add on a bare shell with no venue. `standard` = the default 9am-8pm
//     window = no upgrade line (null). Prices are the item's configured flat fee (unitPrice 0 uses it).
export const DELIVERY_WINDOW_ITEMS: Record<string, GsAddItem | null> = {
  standard: null, // default 9am-8pm window, no upgrade charge
  premium: { itemID: 1206112916, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE", unitPrice: 0, quantity: 1, label: "Premium Window (2 hours) — $100" },
  exact: { itemID: 1206113729, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE", unitPrice: 0, quantity: 1, label: "Exact Time — $150" },
  elite: { itemID: 1206113924, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE", unitPrice: 0, quantity: 1, label: "Elite Hour — $200" },
};

// When SETUP is needed: Event Readiness Service. LOCATION-DEPENDENT (Goodshuffle requires a delivery
// location, same as base delivery) — captured 2026-09-16. Gated on LOGISTICS_LOCATION_READY.
export const EVENT_READINESS: GsAddItem = { itemID: 481935095, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE_WITH_MILEAGE", unitPrice: 0, quantity: 1, label: "Event Readiness Service" };

// Location-dependent items (base delivery mileage, Event Readiness) are REJECTED by Goodshuffle until a
// delivery location is set on the project — which needs the venue write (a geocoded lat/long; setting a
// location with empty coordinates still fails). Flip to true once that write is wired, and base delivery
// + Event Readiness start applying. The time-window upgrade items are NOT gated — they add today.
export const LOGISTICS_LOCATION_READY = false;

/** The line items to auto-add to a new quote shell for an intake.
 *  - Damage waiver: EVERY quote.
 *  - Time-window upgrade (premium/exact/elite): whenever delivery is wanted — adds today (flat-fee
 *    service, no location needed). `standard` adds no upgrade line.
 *  - Base delivery (mileage) + Event Readiness: LOCATION-DEPENDENT, gated on LOGISTICS_LOCATION_READY
 *    so they don't silently fail on a shell that has no delivery location yet. */
export function autoAddItems(intake: { setupRequired: string; deliveryTier: string; deliveryRequired: string }): GsAddItem[] {
  const items: GsAddItem[] = [DAMAGE_WAIVER];

  if (intake.deliveryRequired !== "no") {
    // Time-window upgrade — flat fee, adds without a venue.
    const upgrade = DELIVERY_WINDOW_ITEMS[intake.deliveryTier];
    if (upgrade) items.push(upgrade);
    // Base mileage delivery — needs a delivery location.
    if (LOGISTICS_LOCATION_READY) items.push(BASE_DELIVERY);
  }

  if (LOGISTICS_LOCATION_READY && intake.setupRequired === "yes") items.push(EVENT_READINESS);

  return items;
}

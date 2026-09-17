// Goodshuffle line items the intake automation adds to a new quote shell. IDs + rate config captured
// live on a TEST project (2026-09-16). The add endpoint is POST /app/transactionItemRelation/
// addInventoryItemToContract; each item carries its inventory type + rate type from its Goodshuffle
// config. Auto-adding services (like the waiver) works on a bare shell; auto-adding a DELIVERY item does
// NOT — Goodshuffle rejects it until a delivery LOCATION (venue) is set, so those are deferred to venue.

export interface GsAddItem {
  itemID: number;
  inventoryTypeStr: string; // "SERVICE"
  rateType: string; // "PERCENT_OF_ORDER" | "FLAT_FEE_WITH_MILEAGE" | ...
  unitPrice: number; // 0 = use the item's configured price
  quantity: number;
  label: string;
}

// On EVERY quote: Unintentional Damage Waiver (10% of order, $20 min) — a service, no location needed.
export const DAMAGE_WAIVER: GsAddItem = { itemID: 392871251, inventoryTypeStr: "SERVICE", rateType: "PERCENT_OF_ORDER", unitPrice: 0, quantity: 1, label: "Unintentional Damage Waiver" };

// When SETUP is needed: Event Readiness Service. LOCATION-DEPENDENT (Goodshuffle requires a delivery
// location, same as delivery items) — captured 2026-09-16 (id verified; the add returns "delivery
// location missing" on a bare shell).
export const EVENT_READINESS: GsAddItem = { itemID: 481935095, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE_WITH_MILEAGE", unitPrice: 0, quantity: 1, label: "Event Readiness Service" };

// Delivery time-window items (Logistics services). LOCATION-DEPENDENT. `premium` has no matching item
// in the Zoe inventory yet.
export const DELIVERY_TIER_ITEMS: Record<string, GsAddItem | null> = {
  standard: { itemID: 392868144, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE_WITH_MILEAGE", unitPrice: 0, quantity: 1, label: "Standard Delivery" },
  exact: { itemID: 785075146, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE_WITH_MILEAGE", unitPrice: 0, quantity: 1, label: "Pin Point Exact Time" },
  premium: null, // TBD — no "premium 2-hour window" item found during capture
};

// Location-dependent items (delivery tiers, Event Readiness) are REJECTED by Goodshuffle until a delivery
// location is set on the project — which needs the venue write (still uncaptured). Flip to true once the
// venue/delivery-location write is wired, and the setup + delivery-tier mappings below start applying.
export const LOGISTICS_LOCATION_READY = false;

/** The line items to auto-add to a new quote shell for an intake. The damage waiver goes on EVERY quote.
 *  Setup → Event Readiness Service, and the delivery tier → its item, are added too once a delivery
 *  location can be set (gated by LOGISTICS_LOCATION_READY so nothing silently fails before then). */
export function autoAddItems(intake: { setupRequired: string; deliveryTier: string; deliveryRequired: string }): GsAddItem[] {
  const items: GsAddItem[] = [DAMAGE_WAIVER];
  if (LOGISTICS_LOCATION_READY) {
    if (intake.setupRequired === "yes") items.push(EVENT_READINESS);
    if (intake.deliveryRequired !== "no") {
      const tierItem = DELIVERY_TIER_ITEMS[intake.deliveryTier];
      if (tierItem) items.push(tierItem);
    }
  }
  return items;
}

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

// Delivery time-window items (Logistics services). Captured but NOT auto-added yet: a delivery item needs
// a delivery location on the project first. `premium` has no matching item in the Zoe inventory yet.
export const DELIVERY_TIER_ITEMS: Record<string, GsAddItem | null> = {
  standard: { itemID: 392868144, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE_WITH_MILEAGE", unitPrice: 0, quantity: 1, label: "Standard Delivery" },
  exact: { itemID: 785075146, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE_WITH_MILEAGE", unitPrice: 0, quantity: 1, label: "Pin Point Exact Time" },
  premium: null, // TBD — no "premium 2-hour window" item found during capture
};

/** Items to auto-add to a new quote shell. Today: the damage waiver on every quote. Delivery-tier items
 *  are deferred until a delivery location can be set on the shell (venue capture). */
export function autoAddItems(): GsAddItem[] {
  return [DAMAGE_WAIVER];
}

// Goodshuffle line items the intake automation adds to a new quote shell. IDs + rate config captured live
// on a TEST project (2026-09-16/17). Add endpoint: POST /app/transactionItemRelation/addInventoryItemToContract.
//
// TWO kinds of auto-add, because Goodshuffle treats them differently:
//   1. SIMPLE services (damage waiver, delivery time-window upgrade) — flat/percent services that add to the
//      "Rental Items" group with a minimal payload, no location needed.
//   2. LOGISTICS legs (base mileage delivery, Event Readiness) — go in the "Logistics" group and are REJECTED
//      ("Delivery Location Missing") unless the add payload embeds a geocoded delivery address
//      (venueAddress_* + latitude/longitude) and an eventTimeLineMarker. So they only auto-add when we could
//      geocode the intake's delivery address (see geocode.ts); otherwise they're added by hand in Goodshuffle.
//
// Pricing note: legs are added AS-IS at the item's base flat fee with mileageFee 0 (the mileage the platform
// computes client-side via Google Distance Matrix is not replicated here yet — pricing logic is a follow-up).

export interface GsAddItem {
  itemID: number;
  inventoryTypeStr: string; // "SERVICE"
  rateType: string; // "PERCENT_OF_ORDER" | "FLAT_FEE" | "FLAT_FEE_WITH_MILEAGE"
  unitPrice: number; // 0 = use the item's configured price
  quantity: number;
  label: string;
}

// A logistics leg (delivery drop-off service). Adds to the Logistics group with the geocoded delivery
// address embedded. unitPrice/mileageFee are sent as 0 → the item's base flat fee applies, no mileage (yet).
export interface GsLogisticsLeg {
  itemID: number;
  title: string; // sent as the line item title
  rateType: string; // "FLAT_FEE_WITH_MILEAGE"
  eventTimeLineMarker: string; // "DROP_OFF"
  label: string;
}

// ── SIMPLE services (Rental Items group, no location needed) ─────────────────────────────────────────

// On EVERY quote: Unintentional Damage Waiver (10% of order, $20 min).
export const DAMAGE_WAIVER: GsAddItem = { itemID: 392871251, inventoryTypeStr: "SERVICE", rateType: "PERCENT_OF_ORDER", unitPrice: 0, quantity: 1, label: "Unintentional Damage Waiver" };

// Delivery TIME-WINDOW UPGRADE — a flat premium the customer pays to narrow the delivery window, ON TOP of
// base delivery. General Services / Administrative items (flat fee, NOT location-dependent), so they add on a
// bare shell. `standard` = the default 9am-8pm window = no upgrade line (null). Created 2026-09-16.
export const DELIVERY_WINDOW_ITEMS: Record<string, GsAddItem | null> = {
  standard: null, // default 9am-8pm window, no upgrade charge
  premium: { itemID: 1206112916, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE", unitPrice: 0, quantity: 1, label: "Premium Window (2 hours) — $100" },
  exact: { itemID: 1206113729, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE", unitPrice: 0, quantity: 1, label: "Exact Time — $150" },
};

// ── LOGISTICS legs (Logistics group, need a geocoded delivery location) ──────────────────────────────

// Base delivery = the calculated mileage charge. Added as-is at the $25 base flat fee (mileage = 0 for now).
export const BASE_DELIVERY_LEG: GsLogisticsLeg = { itemID: 392868144, title: "Standard Delivery", rateType: "FLAT_FEE_WITH_MILEAGE", eventTimeLineMarker: "DROP_OFF", label: "Delivery (base fee)" };

// When SETUP or BREAKDOWN help is wanted: Event Readiness Service (setup and/or teardown labor — gathering
// chairs, removing cushions, etc.; tiered by order value $75/$150/$250/$350+, added as-is at the $75 base
// for now, pricing logic to follow).
export const EVENT_READINESS_LEG: GsLogisticsLeg = { itemID: 481935095, title: "Event Readiness Service", rateType: "FLAT_FEE_WITH_MILEAGE", eventTimeLineMarker: "DROP_OFF", label: "Event Readiness Service" };

type IntakeSlice = { setupRequired: string; deliveryTier: string; deliveryRequired: string; pickupRequired?: string; dropoffTime?: string; pickupTime?: string };

// YYYY-MM-DD → M/D/YYYY (no leading zeros) — the format Goodshuffle's saveLineItemGroupEdits expects for
// a line-item group's from/to dates (captured live 2026-09-23). Empty when the date is missing/malformed.
export function mdyFromYmd(ymd: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : "";
}

/** SIMPLE items for the Rental Items group: just the damage waiver (on every quote, no location needed).
 *  The delivery time-window upgrade is NO LONGER here — per the rep it goes in its own group (see
 *  windowUpgradeGroup). */
export function autoAddSimpleItems(): GsAddItem[] {
  return [DAMAGE_WAIVER];
}

// The delivery-timing upgrade broken out into its OWN Goodshuffle line-item group (not lumped with rentals),
// so the customer sees the premium/exact charge as a distinct line. The group is created/reused on the shell.
const WINDOW_UPGRADE_GROUP = "Delivery Timing";

export interface GsWindowUpgrade {
  groupName: string; // the secondary line-item group to create (saveLineItemGroupEdits)
  item: GsAddItem; // the premium/exact upgrade service
  dropoffTime: string; // HH:MM, for the line-item internal note
  pickupTime: string; // HH:MM
}

/** The premium/exact delivery-window upgrade, placed in the SECONDARY line-item group — returned only when
 *  delivery is wanted, the tier carries an upgrade (premium/exact, not the free standard window), AND a
 *  same-day drop-off OR pick-up time was captured ("if either of the two are present"). Null otherwise. */
export function windowUpgradeGroup(intake: IntakeSlice): GsWindowUpgrade | null {
  if (intake.deliveryRequired === "no") return null;
  const item = DELIVERY_WINDOW_ITEMS[intake.deliveryTier];
  if (!item) return null; // standard / flexible → no upgrade, no separate group
  const dropoffTime = intake.dropoffTime || "";
  const pickupTime = intake.pickupTime || "";
  if (!dropoffTime && !pickupTime) return null;
  return { groupName: WINDOW_UPGRADE_GROUP, item, dropoffTime, pickupTime };
}

/** LOGISTICS legs for the Logistics group — added only when we have a geocoded delivery location (the drainer
 *  passes an empty list otherwise). Base delivery when delivery is wanted; Event Readiness when the customer
 *  wants setup OR breakdown help. */
export function autoAddLogisticsLegs(intake: IntakeSlice): GsLogisticsLeg[] {
  const legs: GsLogisticsLeg[] = [];
  if (intake.deliveryRequired !== "no") legs.push(BASE_DELIVERY_LEG);
  if (intake.setupRequired === "yes" || intake.pickupRequired === "yes") legs.push(EVENT_READINESS_LEG);
  return legs;
}

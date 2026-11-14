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

/** Elite Hour (a leg after 10 PM, +$200 per leg, owner 2026-11-14). Its Goodshuffle item id comes from
 *  ELITE_HOUR_ITEM_ID until the item is confirmed in Goodshuffle; with no id the intake notes tell the rep
 *  to add the line by hand instead. */
export function eliteHourItem(env: Record<string, string | undefined> = process.env): GsAddItem | null {
  const id = Number(env.ELITE_HOUR_ITEM_ID);
  return Number.isFinite(id) && id > 0 ? { itemID: id, inventoryTypeStr: "SERVICE", rateType: "FLAT_FEE", unitPrice: 0, quantity: 1, label: "Elite Hour (after 10 PM) — $200" } : null;
}

type LegTierStr = "standard" | "premium" | "exact" | "elite" | "";

/** Each leg's window. A leg tier set on the intake wins; older intakes used one deliveryTier for both legs,
 *  timed only where a time was entered. PURE. */
export function legTiers(intake: IntakeSlice): { drop: LegTierStr; pick: LegTierStr } {
  if (intake.deliveryRequired === "no") return { drop: "", pick: "" };
  const legacy = (time: string | undefined): LegTierStr => {
    const t = intake.deliveryTier;
    if (t === "premium" || t === "exact") return time ? t : "standard";
    return t === "standard" ? "standard" : "";
  };
  return {
    drop: (intake.dropoffTier as LegTierStr) || legacy(intake.dropoffTime),
    pick: (intake.pickupTier as LegTierStr) || legacy(intake.pickupTime),
  };
}

const isTimed = (t: LegTierStr): t is "premium" | "exact" | "elite" => t === "premium" || t === "exact" || t === "elite";

// ── LOGISTICS legs (Logistics group, need a geocoded delivery location) ──────────────────────────────

// Base delivery = the calculated mileage charge. Added as-is at the $25 base flat fee (mileage = 0 for now).
// Titled with the item's current name, "Delivery fee", like the lines reps add by hand (an older title made
// Goodshuffle show "(Renamed)"). The price push finds the line by item id either way.
export const BASE_DELIVERY_LEG: GsLogisticsLeg = { itemID: 392868144, title: "Delivery fee", rateType: "FLAT_FEE_WITH_MILEAGE", eventTimeLineMarker: "DROP_OFF", label: "Delivery drop-off (base fee)" };

// The pickup leg: the same Delivery fee item on the PICK_UP marker, exactly how real projects carry it (a
// drop-off line and a pickup line). Every delivery we drop off, we also pick up. It lands on the event date;
// a rep moves it when the pickup is on another day (e.g. a flexible next-day pickup).
export const BASE_PICKUP_LEG: GsLogisticsLeg = { itemID: 392868144, title: "Delivery fee", rateType: "FLAT_FEE_WITH_MILEAGE", eventTimeLineMarker: "PICK_UP", label: "Delivery pickup (base fee)" };

// When SETUP or BREAKDOWN help is wanted: Event Readiness Service (setup and/or teardown labor — gathering
// chairs, removing cushions, etc.; tiered by order value $75/$150/$250/$350+, added as-is at the $75 base
// for now, pricing logic to follow).
export const EVENT_READINESS_LEG: GsLogisticsLeg = { itemID: 481935095, title: "Event Readiness Service", rateType: "FLAT_FEE_WITH_MILEAGE", eventTimeLineMarker: "DROP_OFF", label: "Event Readiness Service" };

type IntakeSlice = { setupRequired: string; deliveryTier: string; deliveryRequired: string; pickupRequired?: string; dropoffTime?: string; pickupTime?: string; dropoffTier?: string; pickupTier?: string };

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
  item: GsAddItem; // the upgrade line the drainers add to the group (quantity = timed legs that share it)
  /** Every upgrade line, one per distinct window (the drainers today add only `item`; extra lines go in the
   *  create's addItems, see extraUpgradeItems). */
  items: GsAddItem[];
  /** Timed legs we could not add a line for (Elite with no ELITE_HOUR_ITEM_ID): the rep adds them by hand. */
  missing: ("dropoff" | "pickup")[];
  dropoffTime: string; // HH:MM, for the line-item internal note
  pickupTime: string; // HH:MM
}

/** The delivery-window upgrade lines, placed in the SECONDARY line-item group. Charged PER TIMED LEG (owner,
 *  2026-11-14): a leg is timed when its window is premium, exact or elite AND it has a same-day time. One
 *  timed leg = one charge, the other leg can stay Standard. Two legs on the same window share one line with
 *  quantity 2. Null when no leg is timed. */
export function windowUpgradeGroup(intake: IntakeSlice, env: Record<string, string | undefined> = process.env): GsWindowUpgrade | null {
  if (intake.deliveryRequired === "no") return null;
  const tiers = legTiers(intake);
  const dropoffTime = intake.dropoffTime || "";
  const pickupTime = intake.pickupTime || "";
  const legs: { leg: "dropoff" | "pickup"; tier: LegTierStr; time: string }[] = [
    { leg: "dropoff", tier: tiers.drop, time: dropoffTime },
    { leg: "pickup", tier: tiers.pick, time: pickupTime },
  ];
  const items: GsAddItem[] = [];
  const missing: ("dropoff" | "pickup")[] = [];
  for (const l of legs) {
    if (!isTimed(l.tier) || !l.time) continue;
    const base = l.tier === "elite" ? eliteHourItem(env) : DELIVERY_WINDOW_ITEMS[l.tier];
    if (!base) {
      missing.push(l.leg);
      continue;
    }
    const same = items.find((i) => i.itemID === base.itemID);
    if (same) same.quantity = (same.quantity ?? 1) + 1;
    else items.push({ ...base, quantity: 1 });
  }
  if (!items.length) return null; // nothing to add (a hand-added Elite leg shows in missingUpgradeLegs)
  return { groupName: WINDOW_UPGRADE_GROUP, item: items[0], items, missing, dropoffTime, pickupTime };
}

/** Timed legs with no Goodshuffle line to add (Elite with no ELITE_HOUR_ITEM_ID): the rep adds them by
 *  hand, so the intake notes call them out. PURE. */
export function missingUpgradeLegs(intake: IntakeSlice, env: Record<string, string | undefined> = process.env): ("dropoff" | "pickup")[] {
  if (intake.deliveryRequired === "no" || eliteHourItem(env)) return [];
  const t = legTiers(intake);
  const out: ("dropoff" | "pickup")[] = [];
  if (t.drop === "elite" && intake.dropoffTime) out.push("dropoff");
  if (t.pick === "elite" && intake.pickupTime) out.push("pickup");
  return out;
}

/** Upgrade lines beyond the first (two legs on different windows). The drainers add only `item` to the
 *  Delivery Timing group, so these go on the create as plain add items (same charge, rental group). PURE. */
export function extraUpgradeItems(wu: GsWindowUpgrade | null): GsAddItem[] {
  return wu ? wu.items.slice(1) : [];
}

/** LOGISTICS legs for the Logistics group — added only when we have a geocoded delivery location (the drainer
 *  passes an empty list otherwise). A drop-off AND a pickup leg when delivery is wanted; Event Readiness when the customer
 *  wants setup OR breakdown help. */
export function autoAddLogisticsLegs(intake: IntakeSlice): GsLogisticsLeg[] {
  const legs: GsLogisticsLeg[] = [];
  if (intake.deliveryRequired !== "no") legs.push(BASE_DELIVERY_LEG, BASE_PICKUP_LEG);
  if (intake.setupRequired === "yes" || intake.pickupRequired === "yes") legs.push(EVENT_READINESS_LEG);
  return legs;
}

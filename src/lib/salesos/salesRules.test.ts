import { describe, it, expect } from "vitest";
import { SALES_RULES_PROMPT, offlinePaymentAllowed, isEliteHour, isSunday, WINDOW_PRICE_PER_LEG, changeAllowed } from "./salesRules";
import { windowUpgradeGroup, extraUpgradeItems, eliteHourItem, DELIVERY_WINDOW_ITEMS } from "@/lib/intake/gsItems";
import { formatIntakeNotes } from "@/lib/intake/format";
import { createIntake } from "@/lib/intake/store";
import { VIKTOR_SYSTEM } from "@/lib/ai/viktor/agent";

describe("sales rules (owner, 2026-11-14)", () => {
  it("ACH and checks need 10 or more days; the old 5 day rule is gone", () => {
    expect(offlinePaymentAllowed(10)).toBe(true);
    expect(offlinePaymentAllowed(9)).toBe(false);
    expect(offlinePaymentAllowed(5)).toBe(false);
    expect(offlinePaymentAllowed(null)).toBe(false);
    expect(SALES_RULES_PROMPT).toContain("10 or more days before the event");
    expect(SALES_RULES_PROMPT).not.toMatch(/\b5 days\b/);
  });

  it("states the discount rules: 20% for vendors with no approval, rental subtotal only, no stacking, past 20% needs Hermann or Cindy", () => {
    expect(SALES_RULES_PROMPT).toContain("Industry vendors (planners, venues, other event companies) get 20% off automatically. No approval needed.");
    expect(SALES_RULES_PROMPT).toContain("comes off the rental subtotal only");
    expect(SALES_RULES_PROMPT).toContain("Discounts never stack");
    expect(SALES_RULES_PROMPT).toContain("Anything past 20% needs Hermann or Cindy");
    expect(SALES_RULES_PROMPT).not.toMatch(/[–—]| - /); // house style: no dashes
  });

  it("Viktor carries the rules", () => {
    expect(VIKTOR_SYSTEM).toContain(SALES_RULES_PROMPT);
  });

  it("Elite Hour is 10 PM or later; Sunday is detected from the date", () => {
    expect(isEliteHour("22:00")).toBe(true);
    expect(isEliteHour("21:59")).toBe(false);
    expect(isEliteHour("")).toBe(false);
    expect(isSunday("2026-11-15")).toBe(true);
    expect(isSunday("2026-11-14")).toBe(false);
  });

  it("windows are charged per TIMED leg; one leg can stay Standard", () => {
    expect(WINDOW_PRICE_PER_LEG).toEqual({ premium: 100, exact: 150, elite: 200 });
    const base = { setupRequired: "", deliveryRequired: "yes", deliveryTier: "" };
    // Both legs Premium: one line, quantity 2.
    const both = windowUpgradeGroup({ ...base, dropoffTier: "premium", pickupTier: "premium", dropoffTime: "10:00", pickupTime: "18:00" });
    expect(both?.items).toEqual([{ ...DELIVERY_WINDOW_ITEMS.premium, quantity: 2 }]);
    // Exact drop-off, Standard pick-up: one charge only.
    const one = windowUpgradeGroup({ ...base, dropoffTier: "exact", pickupTier: "standard", dropoffTime: "10:00", pickupTime: "" });
    expect(one?.items).toEqual([{ ...DELIVERY_WINDOW_ITEMS.exact, quantity: 1 }]);
    // Exact drop-off, Premium pick-up: two lines, the second rides on the create's add items.
    const mixed = windowUpgradeGroup({ ...base, dropoffTier: "exact", pickupTier: "premium", dropoffTime: "10:00", pickupTime: "18:00" });
    expect(mixed?.item).toEqual({ ...DELIVERY_WINDOW_ITEMS.exact, quantity: 1 });
    expect(extraUpgradeItems(mixed)).toEqual([{ ...DELIVERY_WINDOW_ITEMS.premium, quantity: 1 }]);
    // Standard on both legs: nothing to charge.
    expect(windowUpgradeGroup({ ...base, dropoffTier: "standard", pickupTier: "standard" })).toBeNull();
    // Older intakes (one tier for both legs) still work: timed only where a time was entered.
    const legacy = windowUpgradeGroup({ ...base, deliveryTier: "premium", dropoffTime: "10:00", pickupTime: "18:00" });
    expect(legacy?.items).toEqual([{ ...DELIVERY_WINDOW_ITEMS.premium, quantity: 2 }]);
  });

  it("Elite Hour is +$200 per late leg: a line when the item is configured, a hand-add note when not", () => {
    const base = { setupRequired: "", deliveryRequired: "yes", deliveryTier: "", dropoffTier: "standard", pickupTier: "elite", pickupTime: "22:30" };
    const withItem = windowUpgradeGroup(base, { ELITE_HOUR_ITEM_ID: "1299999999" });
    expect(withItem?.items).toEqual([{ ...eliteHourItem({ ELITE_HOUR_ITEM_ID: "1299999999" })!, quantity: 1 }]);
    expect(windowUpgradeGroup(base, {})).toBeNull();
    const notes = formatIntakeNotes(createIntake({ eventDate: "2026-11-14", deliveryRequired: "yes", deliveryFlexible: "no", dropoffTier: "standard", pickupTier: "elite", pickupTime: "22:30" }));
    expect(notes).toContain("Pick-up: Elite Hour (after 10 PM) 10:30 PM, +$200");
    expect(notes).toContain("ELITE HOUR: add the Elite Hour line by hand for the pick-up, +$200.");
  });

  it("change rules: no fee inside 7 days, no changes within 3 days (one case by case exception)", () => {
    expect(changeAllowed(4)).toBe(true);
    expect(changeAllowed(3)).toBe(false);
    expect(changeAllowed(0)).toBe(false);
    expect(SALES_RULES_PROMPT).toContain("Changes to an order inside 7 days of the event carry no fee.");
    expect(SALES_RULES_PROMPT).toContain("No changes are accepted within 3 days of the event, including during the event");
    expect(SALES_RULES_PROMPT).toContain("we already have to go back to that location for another reason");
  });

  it("the intake notes flag a Sunday event and a Premium time that is really Elite Hour", () => {
    const i = createIntake({ eventDate: "2026-11-15", deliveryRequired: "yes", deliveryFlexible: "no", dropoffTier: "premium", pickupTier: "premium", dropoffTime: "09:00", pickupTime: "22:30" });
    const notes = formatIntakeNotes(i);
    expect(notes).toContain("SUNDAY: an exception only, no surcharge. Hermann or Cindy gives the final yes before we confirm.");
    expect(notes).toContain("ELITE HOUR: the pick-up is after 10 PM, which is Elite Hour (+$200 per leg). Check the window.");
    expect(notes).toContain("Drop-off: Premium 2-hour window 9:00 AM");
    const weekday = formatIntakeNotes(createIntake({ eventDate: "2026-11-14", deliveryRequired: "yes", deliveryFlexible: "no", dropoffTier: "premium", pickupTier: "standard", dropoffTime: "09:00" }));
    expect(weekday).not.toContain("SUNDAY");
    expect(weekday).not.toContain("ELITE HOUR");
    expect(weekday).toContain("Pick-up: Standard 9AM–8PM, no charge");
  });
});

import { describe, it, expect } from "vitest";
import { SALES_RULES_PROMPT, offlinePaymentAllowed, isEliteHour, isSunday, WINDOW_PRICE_PER_LEG } from "./salesRules";
import { windowUpgradeGroup, DELIVERY_WINDOW_ITEMS } from "@/lib/intake/gsItems";
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

  it("Premium and Exact are charged per leg", () => {
    expect(WINDOW_PRICE_PER_LEG).toEqual({ premium: 100, exact: 150 });
    const both = windowUpgradeGroup({ setupRequired: "", deliveryRequired: "yes", deliveryTier: "premium", dropoffTime: "10:00", pickupTime: "18:00" });
    expect(both?.item).toEqual({ ...DELIVERY_WINDOW_ITEMS.premium, quantity: 2 });
    const one = windowUpgradeGroup({ setupRequired: "", deliveryRequired: "yes", deliveryTier: "exact", dropoffTime: "10:00" });
    expect(one?.item.quantity).toBe(1);
  });

  it("the intake notes flag a Sunday event and an Elite Hour time for Hermann or Cindy", () => {
    const i = createIntake({ eventDate: "2026-11-15", deliveryRequired: "yes", deliveryTier: "premium", dropoffTime: "09:00", pickupTime: "22:30" });
    const notes = formatIntakeNotes(i);
    expect(notes).toContain("SUNDAY: an exception only, no surcharge. Hermann or Cindy gives the final yes before we confirm.");
    expect(notes).toContain("ELITE HOUR: a drop-off or pick-up after 10 PM.");
    expect(notes).toContain("+$100 per leg");
    const weekday = formatIntakeNotes(createIntake({ eventDate: "2026-11-14", deliveryRequired: "yes", deliveryTier: "premium", dropoffTime: "09:00", pickupTime: "18:00" }));
    expect(weekday).not.toContain("SUNDAY");
    expect(weekday).not.toContain("ELITE HOUR");
  });
});

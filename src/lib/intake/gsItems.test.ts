import { describe, expect, it } from "vitest";
import { autoAddSimpleItems, autoAddLogisticsLegs, windowUpgradeGroup, DAMAGE_WAIVER, DELIVERY_WINDOW_ITEMS, BASE_DELIVERY_LEG, EVENT_READINESS_LEG } from "./gsItems";
import { gsIntakeLocation } from "./format";
import type { Intake } from "./types";
import type { GeoResult } from "./geocode";

const base = { setupRequired: "", deliveryTier: "", deliveryRequired: "" };

describe("autoAddSimpleItems", () => {
  it("is just the damage waiver — the window upgrade moved to its own group", () => {
    expect(autoAddSimpleItems().map((i) => i.itemID)).toEqual([DAMAGE_WAIVER.itemID]);
  });
});

describe("windowUpgradeGroup", () => {
  it("puts the premium/exact upgrade in its own group when a same-day time is present", () => {
    const wu = windowUpgradeGroup({ ...base, deliveryRequired: "yes", deliveryTier: "exact", dropoffTime: "14:00" });
    expect(wu?.item).toEqual(DELIVERY_WINDOW_ITEMS.exact);
    expect(wu?.groupName).toBeTruthy();
  });

  it("fires when only a pick-up time is present (either of the two)", () => {
    const wu = windowUpgradeGroup({ ...base, deliveryRequired: "yes", deliveryTier: "premium", pickupTime: "22:00" });
    expect(wu?.item).toEqual(DELIVERY_WINDOW_ITEMS.premium);
  });

  it("is null with no drop-off or pick-up time", () => {
    expect(windowUpgradeGroup({ ...base, deliveryRequired: "yes", deliveryTier: "exact" })).toBeNull();
  });

  it("is null for the standard/flexible window (no upgrade)", () => {
    expect(windowUpgradeGroup({ ...base, deliveryRequired: "yes", deliveryTier: "standard", dropoffTime: "14:00" })).toBeNull();
  });

  it("is null when delivery is declined", () => {
    expect(windowUpgradeGroup({ ...base, deliveryRequired: "no", deliveryTier: "premium", dropoffTime: "14:00" })).toBeNull();
  });
});

describe("autoAddLogisticsLegs", () => {
  it("is empty when delivery is declined and no setup", () => {
    expect(autoAddLogisticsLegs({ ...base, deliveryRequired: "no" })).toEqual([]);
  });

  it("adds base delivery when delivery is left unanswered (treated as maybe, like the window upgrade)", () => {
    expect(autoAddLogisticsLegs(base)).toContainEqual(BASE_DELIVERY_LEG);
  });

  it("adds base delivery when delivery is wanted", () => {
    expect(autoAddLogisticsLegs({ ...base, deliveryRequired: "yes" })).toContainEqual(BASE_DELIVERY_LEG);
  });

  it("adds Event Readiness when setup is required", () => {
    expect(autoAddLogisticsLegs({ ...base, setupRequired: "yes" })).toContainEqual(EVENT_READINESS_LEG);
  });

  it("adds Event Readiness when breakdown help is wanted (pickupRequired)", () => {
    expect(autoAddLogisticsLegs({ ...base, deliveryRequired: "no", pickupRequired: "yes" })).toContainEqual(EVENT_READINESS_LEG);
  });

  it("adds Event Readiness only once when both setup and breakdown are on", () => {
    const legs = autoAddLogisticsLegs({ ...base, deliveryRequired: "no", setupRequired: "yes", pickupRequired: "yes" });
    expect(legs.filter((l) => l.itemID === EVENT_READINESS_LEG.itemID)).toHaveLength(1);
  });

  it("adds both when delivery and setup are both on", () => {
    const legs = autoAddLogisticsLegs({ ...base, deliveryRequired: "yes", setupRequired: "yes" });
    expect(legs).toHaveLength(2);
  });
});

describe("gsIntakeLocation", () => {
  const geo: GeoResult = { latitude: "38.99", longitude: "-77.03", county: "Montgomery", matchedAddress: "x" };
  const intake = { streetAddress: "8757 Georgia Ave", city: "Silver Spring", state: "MD", zip: "20910", venueName: "" } as Intake;

  it("is null without a geocode", () => {
    expect(gsIntakeLocation(intake, null)).toBeNull();
  });

  it("is null without a street address", () => {
    expect(gsIntakeLocation({ ...intake, streetAddress: "" } as Intake, geo)).toBeNull();
  });

  it("builds the location payload from intake + geocode, falling back venueName to the street", () => {
    const loc = gsIntakeLocation(intake, geo);
    expect(loc).toMatchObject({ venueName: "8757 Georgia Ave", city: "Silver Spring", county: "Montgomery", latitude: "38.99", longitude: "-77.03", country: "US" });
  });

  it("prefers an explicit venue name", () => {
    const loc = gsIntakeLocation({ ...intake, venueName: "The Grand Hall" } as Intake, geo);
    expect(loc?.venueName).toBe("The Grand Hall");
  });
});

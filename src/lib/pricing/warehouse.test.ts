import { describe, expect, it } from "vitest";
import { pricingDeparture } from "./warehouse";

describe("pricingDeparture", () => {
  it("is the next Tuesday at 10:00 ET, in standard and daylight time", () => {
    expect(pricingDeparture(new Date("2026-11-06T22:00:00Z")).toISOString()).toBe("2026-11-10T15:00:00.000Z"); // Fri → Tue, EST
    expect(pricingDeparture(new Date("2026-07-01T12:00:00Z")).toISOString()).toBe("2026-07-07T14:00:00.000Z"); // Wed → Tue, EDT
  });

  it("never picks today, even on a Tuesday", () => {
    expect(pricingDeparture(new Date("2026-11-10T13:00:00Z")).toISOString()).toBe("2026-11-17T15:00:00.000Z");
  });
});

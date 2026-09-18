import { describe, expect, it } from "vitest";
import { deliveryLegFee, deliveryQuote, metersToMiles, BASE } from "./delivery";

describe("deliveryLegFee = base + miles×2.99 + subtotal×5%", () => {
  it("computes a leg with the exact formula", () => {
    // 25 + 10×2.99 + 2000×0.05 = 25 + 29.90 + 100 = 154.90
    const leg = deliveryLegFee(10, 2000);
    expect(leg.base).toBe(25);
    expect(leg.mileage).toBe(29.9);
    expect(leg.subtotalFee).toBe(100);
    expect(leg.total).toBe(154.9);
  });

  it("is just the base at zero miles and zero subtotal", () => {
    expect(deliveryLegFee(0, 0).total).toBe(BASE);
  });

  it("floors negative inputs at zero", () => {
    expect(deliveryLegFee(-5, -100).total).toBe(BASE);
  });
});

describe("deliveryQuote legs", () => {
  it("round trip charges the formula on BOTH legs (5% applied per leg)", () => {
    const q = deliveryQuote(10, 2000, "round_trip");
    expect(q.dropOff?.total).toBe(154.9);
    expect(q.pickup?.total).toBe(154.9);
    expect(q.total).toBe(309.8);
  });

  it("drop-off only = one leg, no pickup", () => {
    const q = deliveryQuote(10, 2000, "drop_off");
    expect(q.dropOff?.total).toBe(154.9);
    expect(q.pickup).toBeNull();
    expect(q.total).toBe(154.9);
  });

  it("pickup only = one leg, no drop-off", () => {
    const q = deliveryQuote(10, 2000, "pickup");
    expect(q.dropOff).toBeNull();
    expect(q.pickup?.total).toBe(154.9);
    expect(q.total).toBe(154.9);
  });
});

describe("metersToMiles", () => {
  it("converts driving meters to miles", () => {
    expect(metersToMiles(1609.344)).toBeCloseTo(1, 5);
    expect(Math.round(metersToMiles(16093.44))).toBe(10);
  });
});

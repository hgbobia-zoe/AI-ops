import { describe, expect, it } from "vitest";
import {
  deliveryLegFee,
  deliveryQuote,
  distanceCharge,
  metersToMiles,
  DEFAULT_DELIVERY_FORMULA,
  BASE,
  type DeliveryFormulaConfig,
} from "./delivery";

describe("distanceCharge — tiered by mile band (default 2.99 / 1.75 / 1.50)", () => {
  const tiers = DEFAULT_DELIVERY_FORMULA.mileageTiers;

  it("charges the first band only inside 20 mi", () => {
    expect(distanceCharge(10, tiers)).toBe(29.9); // 10 × 2.99
    expect(distanceCharge(20, tiers)).toBe(59.8); // 20 × 2.99
  });

  it("spec worked example: a 30-mile leg = 20×2.99 + 10×1.75 = 77.30", () => {
    expect(distanceCharge(30, tiers)).toBe(77.3);
  });

  it("crosses into the open-ended band: a 50-mile leg = 20×2.99 + 20×1.75 + 10×1.50 = 109.80", () => {
    expect(distanceCharge(50, tiers)).toBe(109.8);
  });

  it("is 0 at or below 0 miles", () => {
    expect(distanceCharge(0, tiers)).toBe(0);
    expect(distanceCharge(-5, tiers)).toBe(0);
  });
});

describe("deliveryLegFee = baseFee + tiered distance + min(pct×subtotal, cap)", () => {
  it("computes a leg with the tiered formula (subtotal under the cap)", () => {
    // 25 + (20×2.99 + 10×1.75) + 2000×0.05 = 25 + 77.30 + 100 = 202.30
    const leg = deliveryLegFee(30, 2000);
    expect(leg.base).toBe(25);
    expect(leg.mileage).toBe(77.3);
    expect(leg.subtotalFee).toBe(100);
    expect(leg.subtotalCapped).toBe(false);
    expect(leg.total).toBe(202.3);
  });

  it("caps the subtotal fee at $300 per leg", () => {
    // subtotal 10,000 → 5% = 500, capped to 300. 25 + 10×2.99 + 300 = 354.90
    const leg = deliveryLegFee(10, 10000);
    expect(leg.subtotalFee).toBe(300);
    expect(leg.subtotalCapped).toBe(true);
    expect(leg.total).toBe(354.9);
  });

  it("is just the base at zero miles and zero subtotal", () => {
    expect(deliveryLegFee(0, 0).total).toBe(BASE);
  });

  it("floors negative inputs at zero", () => {
    expect(deliveryLegFee(-5, -100).total).toBe(BASE);
  });

  it("reads the config passed in (no hard-coded constants)", () => {
    const cfg: DeliveryFormulaConfig = {
      baseFee: 50,
      mileageTiers: [{ uptoMile: null, ratePerMile: 2 }],
      pct: 0.1,
      pctCap: 1000,
    };
    // 50 + 10×2 + 1000×0.10 = 50 + 20 + 100 = 170
    expect(deliveryLegFee(10, 1000, cfg).total).toBe(170);
  });
});

describe("deliveryQuote legs", () => {
  it("round trip charges the formula on BOTH legs (priced independently)", () => {
    const q = deliveryQuote(30, 2000, "round_trip");
    expect(q.dropOff?.total).toBe(202.3);
    expect(q.pickup?.total).toBe(202.3);
    expect(q.total).toBe(404.6);
  });

  it("drop-off only = one leg, no pickup", () => {
    const q = deliveryQuote(30, 2000, "drop_off");
    expect(q.dropOff?.total).toBe(202.3);
    expect(q.pickup).toBeNull();
    expect(q.total).toBe(202.3);
  });

  it("pickup only = one leg, no drop-off", () => {
    const q = deliveryQuote(30, 2000, "pickup");
    expect(q.dropOff).toBeNull();
    expect(q.pickup?.total).toBe(202.3);
    expect(q.total).toBe(202.3);
  });
});

describe("metersToMiles", () => {
  it("converts driving meters to miles", () => {
    expect(metersToMiles(1609.344)).toBeCloseTo(1, 5);
    expect(Math.round(metersToMiles(16093.44))).toBe(10);
  });
});

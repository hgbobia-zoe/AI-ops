import { describe, it, expect } from "vitest";
import { rateForUserOn, type PayRate } from "@/lib/connecteam";

// Rates are stored newest-effective-first (as getPayRates returns them).
const rates = new Map<number, PayRate[]>([
  [
    1,
    [
      { userId: 1, hourlyRate: 25, effectiveDate: "2026-06-01" },
      { userId: 1, hourlyRate: 22, effectiveDate: "2026-01-01" },
    ],
  ],
]);

describe("rateForUserOn — respects effective dates", () => {
  it("uses the rate in effect on the date (before the raise)", () => {
    expect(rateForUserOn(rates, 1, "2026-03-15")).toBe(22);
  });
  it("uses the newer rate on/after its effective date", () => {
    expect(rateForUserOn(rates, 1, "2026-06-01")).toBe(25);
    expect(rateForUserOn(rates, 1, "2026-09-01")).toBe(25);
  });
  it("returns null when no rate is effective yet (don't guess)", () => {
    expect(rateForUserOn(rates, 1, "2025-12-31")).toBeNull();
  });
  it("returns null for an unknown employee", () => {
    expect(rateForUserOn(rates, 99, "2026-06-01")).toBeNull();
  });
});

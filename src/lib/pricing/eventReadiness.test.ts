import { describe, expect, it } from "vitest";
import { eventReadinessFee, readinessTier, readinessFeeLabel } from "./eventReadiness";

describe("eventReadinessFee tiers", () => {
  it("under $500 → $75", () => {
    expect(eventReadinessFee(0)).toBe(75);
    expect(eventReadinessFee(499)).toBe(75);
  });
  it("$500–$1,500 → $150 (lower bound inclusive)", () => {
    expect(eventReadinessFee(500)).toBe(150);
    expect(eventReadinessFee(1499)).toBe(150);
  });
  it("$1,500–$3,000 → $250", () => {
    expect(eventReadinessFee(1500)).toBe(250);
    expect(eventReadinessFee(2999)).toBe(250);
  });
  it("$3,000+ → $350 (floor)", () => {
    expect(eventReadinessFee(3000)).toBe(350);
    expect(eventReadinessFee(25000)).toBe(350);
    expect(readinessTier(3000).floor).toBe(true);
    expect(readinessFeeLabel(3000)).toBe("$350+");
  });
  it("labels a mid tier without a plus", () => {
    expect(readinessFeeLabel(800)).toBe("$150");
  });
});

import { describe, it, expect } from "vitest";
import { bidReview, type DecidedDeal } from "./bidReview";

// A pool of comparable-sized deals whose WINNING bids cluster ~ $900–$1,100 (median ~1000).
function pool(): DecidedDeal[] {
  const d: DecidedDeal[] = [];
  // 20 wins spread 800..1200
  for (let i = 0; i < 20; i++) d.push({ value: 800 + i * 20, won: true });
  // 20 losses spread 900..1400 (losses skew higher)
  for (let i = 0; i < 20; i++) d.push({ value: 900 + i * 25, won: false });
  return d;
}

describe("bidReview", () => {
  it("says 'insufficient' honestly when there's too little comparable history", () => {
    const r = bidReview({ value: 1000 }, [{ value: 1000, won: true }, { value: 1050, won: false }]);
    expect(r.verdict).toBe("insufficient");
    expect(r.confidence).toBe("low");
    expect(r.reasons[0]).toMatch(/not enough/i);
  });

  it("flags a bid above the winning range as aggressive", () => {
    const r = bidReview({ value: 1400 }, pool());
    expect(r.verdict).toBe("aggressive");
    expect(r.wonRange).not.toBeNull();
    expect(r.value).toBeGreaterThan(r.wonRange!.p75);
    expect(r.reasons.some((x) => /tougher close/i.test(x))).toBe(true);
  });

  it("calls a mid-range bid competitive", () => {
    const r = bidReview({ value: 1000 }, pool());
    expect(r.verdict).toBe("competitive");
    expect(r.value).toBeGreaterThanOrEqual(r.wonRange!.p25);
    expect(r.value).toBeLessThanOrEqual(r.wonRange!.p75);
  });

  it("calls a low bid conservative (likely to win, maybe underpriced)", () => {
    const r = bidReview({ value: 780 }, pool());
    expect(r.verdict).toBe("conservative");
    expect(r.reasons.some((x) => /leaving margin/i.test(x))).toBe(true);
  });

  it("only counts deals within ±40% of the bid as comparable", () => {
    const history: DecidedDeal[] = [
      ...pool(),
      // far-larger deals that must NOT be pulled into a $1,000 review
      ...Array.from({ length: 30 }, () => ({ value: 8000, won: false })),
    ];
    const r = bidReview({ value: 1000 }, history);
    expect(r.comparables).toBeLessThan(60); // the $8k deals are excluded (outside 600–1400)
    expect(r.winRate).toBeGreaterThan(0); // still computed from the in-window pool
  });

  it("computes win rate and won-bid distribution over comparables", () => {
    const r = bidReview({ value: 1000 }, pool());
    expect(r.comparables).toBeGreaterThanOrEqual(8);
    expect(r.winRate).not.toBeNull();
    expect(r.wonRange!.p25).toBeLessThanOrEqual(r.wonRange!.median);
    expect(r.wonRange!.median).toBeLessThanOrEqual(r.wonRange!.p75);
    expect(r.percentileAmongWins).toBeGreaterThan(0);
  });

  it("adds a seasonal note when a month is given and it diverges from the overall rate", () => {
    const history: DecidedDeal[] = [
      ...pool().map((d) => ({ ...d, month: 6 })),
      // December: mostly losses → a harder month
      ...Array.from({ length: 10 }, () => ({ value: 1000, won: false, month: 12 })),
    ];
    const r = bidReview({ value: 1000, month: 12 }, history);
    expect(r.seasonWinRate).not.toBeNull();
    expect(r.reasons.some((x) => /December/.test(x))).toBe(true);
  });
});

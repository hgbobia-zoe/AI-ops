import { describe, it, expect } from "vitest";
import { estimateHandlingTime } from "./itemIntelligence";
import type { ItemIntelligenceConfig } from "./config";

// A small, explicit config so every expected number is hand-verifiable (no reliance on the shipped defaults).
const cfg: ItemIntelligenceConfig = {
  baseMinutesPerItem: 5,
  rules: [
    { keyword: "tent", setupMin: 90, breakdownMin: 60 },
    { keyword: "floor", setupMin: 45, breakdownMin: 30 },
    { keyword: "lighting", setupMin: 30, breakdownMin: 20 },
  ],
};

describe("estimateHandlingTime — provisional item-level handling time from titles (Stage 6)", () => {
  it("returns UNAVAILABLE (available:false) for empty or null titles — never a fabricated zero estimate", () => {
    for (const titles of [null, undefined, [], ["", "   "]]) {
      const e = estimateHandlingTime(titles as string[] | null, cfg);
      expect(e.available).toBe(false);
      expect(e.totalMinutes).toBe(0);
      expect(e.setupMinutes).toBe(0);
      expect(e.breakdownMinutes).toBe(0);
      expect(e.itemCount).toBe(0);
      expect(e.keywords).toEqual([]);
      expect(e.confidence).toBe("LOW");
      expect(e.method).toBe("inferred from item titles");
    }
  });

  it("applies the per-item baseline plus keyword escalations (setup + breakdown)", () => {
    const e = estimateHandlingTime(["20x40 Tent", "Chiavari Chair"], cfg);
    expect(e.available).toBe(true);
    expect(e.itemCount).toBe(2);
    // Tent line: base 5 + setup 90 = 95 setup, 60 breakdown. Chair line: base 5 setup, 0 breakdown.
    expect(e.setupMinutes).toBe(100);
    expect(e.breakdownMinutes).toBe(60);
    expect(e.totalMinutes).toBe(160);
    expect(e.keywords).toEqual(["tent"]);
    const tentLine = e.lines.find((l) => l.title === "20x40 Tent")!;
    expect(tentLine.matchedKeywords).toEqual(["tent"]);
    expect(tentLine.setupMin).toBe(95);
    expect(tentLine.breakdownMin).toBe(60);
  });

  it("matches multiple keywords in one title, each counted once, keywords returned sorted + deduped", () => {
    const e = estimateHandlingTime(["Dance Floor with Lighting", "More Lighting"], cfg);
    // Line 1: base 5 + floor 45 + lighting 30 = 80 setup; floor 30 + lighting 20 = 50 breakdown.
    // Line 2: base 5 + lighting 30 = 35 setup; lighting 20 = 20 breakdown.
    expect(e.setupMinutes).toBe(115);
    expect(e.breakdownMinutes).toBe(70);
    expect(e.keywords).toEqual(["floor", "lighting"]); // sorted, deduped across items
    expect(e.confidence).toBe("LOW"); // always LOW — inferred, never measured
  });

  it("counts a repeated keyword within one title only once", () => {
    const e = estimateHandlingTime(["Tent Tent Tent"], cfg);
    expect(e.setupMinutes).toBe(95); // 5 base + 90 once, not 3x
    expect(e.breakdownMinutes).toBe(60);
    expect(e.lines[0].matchedKeywords).toEqual(["tent"]);
  });

  it("honors a custom keyword→minutes map (no hard-coded magic numbers)", () => {
    const custom: ItemIntelligenceConfig = { baseMinutesPerItem: 10, rules: [{ keyword: "glow", setupMin: 7, breakdownMin: 3 }] };
    const e = estimateHandlingTime(["Glow Stick"], custom);
    expect(e.setupMinutes).toBe(17);
    expect(e.breakdownMinutes).toBe(3);
    expect(e.totalMinutes).toBe(20);
  });

  it("never emits a money figure (Stage 6 is operational time only)", () => {
    const e = estimateHandlingTime(["Tent"], cfg);
    // The shape has no dollar/amount/cost field by construction — assert the keys are time-only.
    expect(Object.keys(e).sort()).toEqual(
      ["available", "breakdownMinutes", "confidence", "itemCount", "keywords", "lines", "method", "setupMinutes", "totalMinutes"].sort(),
    );
  });
});

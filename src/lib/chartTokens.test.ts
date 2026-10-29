import { describe, it, expect } from "vitest";
import { CHART_CATEGORY, categoryColor, CHART_STATUS } from "./chartTokens";

describe("categoryColor", () => {
  it("returns the ramp colour at the given index", () => {
    expect(categoryColor(0)).toBe(CHART_CATEGORY[0]);
    expect(categoryColor(4)).toBe(CHART_CATEGORY[4]);
  });

  it("wraps stably past the end of the ramp (same category → same colour)", () => {
    // The contract downstream relies on: index is stable modulo the ramp length.
    expect(categoryColor(5)).toBe(categoryColor(0));
    expect(categoryColor(6)).toBe(categoryColor(1));
    expect(categoryColor(12)).toBe(categoryColor(2));
  });

  it("handles negative indices without returning undefined", () => {
    expect(categoryColor(-1)).toBe(CHART_CATEGORY[CHART_CATEGORY.length - 1]);
    expect(categoryColor(-5)).toBe(CHART_CATEGORY[0]);
    expect(categoryColor(-6)).toBe(CHART_CATEGORY[CHART_CATEGORY.length - 1]);
  });

  it("only ever references theme-driven CSS variables", () => {
    for (let i = -3; i < 13; i++) {
      expect(categoryColor(i)).toMatch(/^var\(--chart-[1-5]\)$/);
    }
  });

  it("keeps semantic status marks separate from the categorical ramp", () => {
    const cats = new Set<string>(CHART_CATEGORY);
    for (const v of Object.values(CHART_STATUS)) {
      expect(cats.has(v)).toBe(false);
    }
  });
});

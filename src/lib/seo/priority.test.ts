import { describe, expect, it } from "vitest";
import { scorePriority } from "./priority";
import type { SeoMatchResult } from "./types";

function match(action: SeoMatchResult["action"], confidence = 0.8, candidates: SeoMatchResult["candidates"] = []): SeoMatchResult {
  return { action, matchedUrl: null, matchedPath: null, confidence, reason: "", candidates };
}

describe("priority engine", () => {
  it("exposes every sub-score with evidence and a 0–100 overall", () => {
    const b = scorePriority({ intent: "commercial", category: "tents", metrics: { volume: 1200, difficulty: 30 }, match: match("IMPROVE") });
    expect(b.score).toBeGreaterThanOrEqual(0);
    expect(b.score).toBeLessThanOrEqual(100);
    expect(b.components.length).toBeGreaterThanOrEqual(6);
    for (const c of b.components) {
      expect(typeof c.evidence).toBe("string");
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
    }
  });

  it("marks unknown metrics as unknown and never fabricates a value (neutral placeholder, not zero)", () => {
    const b = scorePriority({ intent: "commercial", category: "tents", metrics: null, match: match("CREATE") });
    const demand = b.components.find((c) => c.key === "demand")!;
    const ranking = b.components.find((c) => c.key === "ranking")!;
    expect(demand.unknown).toBe(true);
    expect(ranking.unknown).toBe(true);
    expect(demand.score).toBe(50); // neutral placeholder, not 0
    expect(b.summary).toContain("unknown");
  });

  it("clamps a SKIP to a low priority regardless of metrics", () => {
    const b = scorePriority({ intent: "commercial", category: "tents", metrics: { volume: 50000, difficulty: 1 }, match: match("SKIP") });
    expect(b.score).toBeLessThanOrEqual(15);
  });

  it("ranks a high-demand low-difficulty keyword above an unknown one", () => {
    const strong = scorePriority({ intent: "commercial", category: "tents", metrics: { volume: 8000, difficulty: 20 }, match: match("IMPROVE") });
    const unknown = scorePriority({ intent: "commercial", category: "tents", metrics: null, match: match("IMPROVE") });
    expect(strong.score).toBeGreaterThan(unknown.score);
  });

  it("rewards commercial intent over informational", () => {
    const commercial = scorePriority({ intent: "commercial", category: "tents", metrics: null, match: match("CREATE") });
    const info = scorePriority({ intent: "informational", category: "tents", metrics: null, match: match("CREATE") });
    expect(commercial.score).toBeGreaterThan(info.score);
  });
});

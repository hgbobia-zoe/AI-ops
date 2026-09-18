import { describe, it, expect } from "vitest";
import { matchesCriteria } from "./campaigns";
import type { OpportunityView } from "./service";

// Minimal view stub — matchesCriteria only reads opp.kind/jurisdiction/zoeCategories + score.opportunityScore.
function view(o: { kind?: string; jurisdiction?: string; categories?: string[]; score?: number }): OpportunityView {
  return {
    opp: { kind: o.kind ?? "PROCUREMENT", jurisdiction: o.jurisdiction ?? "MONTGOMERY_CO", zoeCategories: o.categories ?? [] },
    score: { opportunityScore: o.score ?? 70 },
  } as unknown as OpportunityView;
}

describe("matchesCriteria", () => {
  it("matches when all criteria are satisfied", () => {
    expect(matchesCriteria(view({ kind: "PROCUREMENT", jurisdiction: "MONTGOMERY_CO", score: 80 }), { kinds: ["PROCUREMENT"], jurisdictions: ["MONTGOMERY_CO"], minScore: 70 })).toBe(true);
  });
  it("rejects on kind mismatch", () => {
    expect(matchesCriteria(view({ kind: "EVENT" }), { kinds: ["PROCUREMENT"] })).toBe(false);
  });
  it("rejects on jurisdiction mismatch", () => {
    expect(matchesCriteria(view({ jurisdiction: "DC" }), { jurisdictions: ["MONTGOMERY_CO"] })).toBe(false);
  });
  it("rejects below min score", () => {
    expect(matchesCriteria(view({ score: 40 }), { minScore: 70 })).toBe(false);
  });
  it("requires at least one matching category when categories are set", () => {
    expect(matchesCriteria(view({ categories: ["tent", "tables"] }), { categories: ["chairs"] })).toBe(false);
    expect(matchesCriteria(view({ categories: ["tent", "chairs"] }), { categories: ["chairs"] })).toBe(true);
  });
  it("empty criteria matches everything", () => {
    expect(matchesCriteria(view({}), {})).toBe(true);
  });
});

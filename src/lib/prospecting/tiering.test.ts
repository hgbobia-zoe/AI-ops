import { describe, it, expect } from "vitest";
import { tierFor } from "./tiering";
import type { OpportunityView } from "@/lib/opportunity/service";

function view(o: { score?: number; tier?: string; relationship?: boolean; target?: boolean }): OpportunityView {
  return {
    score: { opportunityScore: o.score ?? 60, tier: o.tier ?? "MEDIUM" },
    hasExistingRelationship: !!o.relationship,
    primaryTarget: o.target ? { edge: { entity: { name: "X" } } } : null,
  } as unknown as OpportunityView;
}

describe("tierFor", () => {
  it("Tier A (call) for a high score", () => {
    const d = tierFor(view({ score: 85, tier: "HIGH" }), {});
    expect(d.tier).toBe("A");
    expect(d.channel).toBe("call");
  });
  it("Tier A (call) when awarded, even at a medium score", () => {
    expect(tierFor(view({ score: 55, tier: "MEDIUM" }), { awarded: true }).tier).toBe("A");
  });
  it("Tier A (call) for an existing relationship", () => {
    expect(tierFor(view({ score: 50, tier: "MEDIUM", relationship: true }), {}).tier).toBe("A");
  });
  it("Tier B (email) for a qualified but not call-worthy score", () => {
    const d = tierFor(view({ score: 55, tier: "MEDIUM" }), {});
    expect(d.tier).toBe("B");
    expect(d.channel).toBe("email");
  });
  it("Tier C (monitor) below the email bar or unqualified", () => {
    expect(tierFor(view({ score: 20, tier: "LOW" }), {}).tier).toBe("C");
    expect(tierFor(view({ score: 90, tier: "UNQUALIFIED" }), {}).tier).toBe("C");
  });
  it("flags missing contact for a call tier", () => {
    expect(tierFor(view({ score: 85, tier: "HIGH", target: false }), {}).reasons.some((r) => /enrich/i.test(r))).toBe(true);
  });
});

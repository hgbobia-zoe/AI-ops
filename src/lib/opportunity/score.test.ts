import { describe, it, expect } from "vitest";
import { scoreOpportunity, tierFor, type ScoreInput } from "./score";

const base: ScoreInput = {
  region: "MONTGOMERY_MD",
  governmentInvolved: true,
  zoeCategories: ["tent", "tables", "chairs"],
  expectedAttendance: null,
  attendanceConfidence: "UNKNOWN",
  daysToEvent: null,
  daysToDeadline: 40,
  hasKnownContractor: true,
  hasKnownPlanner: false,
  hasExistingRelationship: false,
  verificationStatus: "INFERRED",
  fullyVirtual: false,
};

describe("scoreOpportunity", () => {
  it("is deterministic", () => {
    expect(scoreOpportunity(base).opportunityScore).toBe(scoreOpportunity(base).opportunityScore);
  });
  it("explains every point of the relevance score", () => {
    const q = scoreOpportunity(base);
    const explained = q.positives.reduce((s, p) => s + p.weight, 0) + q.negatives.reduce((s, n) => s + n.weight, 0);
    expect(Math.round(Math.max(0, Math.min(100, explained)))).toBe(q.relevanceScore);
  });
  it("penalizes out-of-area to UNQUALIFIED", () => {
    const q = scoreOpportunity({ ...base, region: "OUT_OF_AREA" });
    expect(q.negatives.some((n) => n.key === "out_of_area")).toBe(true);
    expect(q.tier).toBe("UNQUALIFIED");
  });
  it("penalizes an expired deadline", () => {
    expect(scoreOpportunity({ ...base, daysToDeadline: -5 }).negatives.some((n) => n.key === "deadline_passed")).toBe(true);
  });
  it("opportunity score never exceeds relevance and drops with lower detection confidence", () => {
    const verified = scoreOpportunity({ ...base, verificationStatus: "VERIFIED" });
    const unknown = scoreOpportunity({ ...base, verificationStatus: "UNKNOWN" });
    expect(verified.opportunityScore).toBeLessThanOrEqual(verified.relevanceScore);
    expect(unknown.opportunityScore).toBeLessThanOrEqual(verified.opportunityScore);
  });
  it("counts government + categories + contractor + relationship as positives", () => {
    const q = scoreOpportunity({ ...base, hasExistingRelationship: true });
    const keys = q.positives.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(["government", "categories", "contractor", "relationship", "deadline", "in_area"]));
  });
  it("derives an indicative value from categories when attendance is unknown", () => {
    expect(scoreOpportunity(base).estimatedValue).not.toBeNull();
    expect(scoreOpportunity({ ...base, region: "OUT_OF_AREA" }).estimatedValue).toBeNull();
  });
});

describe("tierFor", () => {
  it("maps to configured tiers", () => {
    expect(tierFor(80)).toBe("HIGH");
    expect(tierFor(50)).toBe("MEDIUM");
    expect(tierFor(25)).toBe("LOW");
    expect(tierFor(5)).toBe("UNQUALIFIED");
  });
});

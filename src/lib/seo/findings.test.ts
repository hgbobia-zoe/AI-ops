import { describe, expect, it } from "vitest";
import { buildFinding } from "./findings";
import type { SeoOpportunity, SerpData } from "./types";

function opp(over: Partial<SeoOpportunity> & { serp?: SerpData | null }): SeoOpportunity {
  return {
    id: "SEOP-1",
    dedupeKey: "k",
    keyword: "tent rental washington dc",
    relatedKeywords: [],
    intent: "commercial",
    location: "Washington, DC",
    category: "tents",
    competitorRefs: over.competitorRefs ?? [],
    metrics: null,
    metricsSource: "none",
    serp: over.serp ?? null,
    source: "serp",
    researchAt: null,
    matchedUrl: null,
    recommendedAction: over.recommendedAction ?? "CREATE",
    priority: over.priority ?? 70,
    priorityBreakdown: null,
    explanation: null,
    owner: null,
    status: "new",
    stage: "ANALYZING",
    isSeed: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  } as SeoOpportunity;
}

function serp(over: Partial<SerpData>): SerpData {
  return {
    retrievedAt: "2026-01-01T00:00:00Z",
    zoeRank: null,
    zoePresent: false,
    topDomains: [],
    peopleAlsoAsk: [],
    relatedSearches: [],
    locale: "US",
    ...over,
  };
}

describe("buildFinding (deterministic)", () => {
  it("none when no SERP has been read", () => {
    const f = buildFinding(opp({ serp: null }));
    expect(f.kind).toBe("none");
    expect(f.recommendationSource).toBe("deterministic");
    expect(f.zoeRank).toBeNull();
  });

  it("gap when Zoe is absent and competitors rank", () => {
    const f = buildFinding(
      opp({
        competitorRefs: ["aabletents.com", "dmvrentals.com"],
        serp: serp({ zoePresent: false, zoeRank: null, topDomains: [
          { domain: "aabletents.com", rank: 1, url: "https://aabletents.com", title: "A" },
          { domain: "dmvrentals.com", rank: 2, url: "https://dmvrentals.com", title: "B" },
        ] }),
      }),
    );
    expect(f.kind).toBe("gap");
    expect(f.competitorsAhead).toContain("aabletents.com");
    expect(f.recommendation).toMatch(/aabletents\.com/);
    expect(f.headline).toMatch(/not on page 1/i);
  });

  it("improve when Zoe ranks on page 1 but not top-3", () => {
    const f = buildFinding(
      opp({
        recommendedAction: "IMPROVE",
        competitorRefs: ["aabletents.com"],
        serp: serp({ zoePresent: true, zoeRank: 6, topDomains: [
          { domain: "aabletents.com", rank: 1, url: "https://aabletents.com", title: "A" },
          { domain: "zoeeventsdmv.com", rank: 6, url: "https://zoeeventsdmv.com", title: "Zoe" },
        ] }),
      }),
    );
    expect(f.kind).toBe("improve");
    expect(f.zoeRank).toBe(6);
    expect(f.competitorsAhead).toEqual(["aabletents.com"]); // only those ABOVE rank 6
  });

  it("defend when Zoe is already top-3", () => {
    const f = buildFinding(opp({ serp: serp({ zoePresent: true, zoeRank: 2, topDomains: [{ domain: "zoeeventsdmv.com", rank: 2, url: "https://zoeeventsdmv.com", title: "Zoe" }] }) }));
    expect(f.kind).toBe("defend");
    expect(f.zoeRank).toBe(2);
  });
});

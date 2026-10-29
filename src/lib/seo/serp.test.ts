import { describe, expect, it } from "vitest";
import { parseSerpResult, aggregateCompetitorDomains, normalizeDomain, domainMatches, NON_COMPETITOR_DOMAINS } from "./serp";
import { scorePriority } from "./priority";
import type { SeoMatchResult, SerpData } from "./types";

const ZOE = "zoeeventsdmv.com";

// A realistic SERP payload shaped like the office runner pushes it.
function serp(opts: { zoeRank?: number | null; competitors?: string[]; directories?: string[] } = {}): unknown {
  const organic: { rank: number; url: string; title: string }[] = [];
  let rank = 0;
  const push = (host: string) => { rank++; organic.push({ rank, url: `https://${host}/page`, title: `${host} result` }); };
  (opts.competitors ?? []).forEach(push);
  if (opts.zoeRank != null) {
    // place Zoe at the requested rank (pad with a filler competitor if needed)
    while (rank < opts.zoeRank - 1) push(`filler${rank}.com`);
    rank++;
    organic.splice(opts.zoeRank - 1, 0, { rank: opts.zoeRank, url: `https://www.${ZOE}/rentals`, title: "Zoe Events" });
    // renumber after splice
    organic.forEach((o, i) => (o.rank = i + 1));
  }
  (opts.directories ?? []).forEach(push);
  return { organic, peopleAlsoAsk: ["how much is tent rental"], relatedSearches: ["party tent rental"] };
}

describe("normalizeDomain + domainMatches", () => {
  it("strips protocol/www/path/port and lowercases", () => {
    expect(normalizeDomain("https://www.Example.com/foo?x=1")).toBe("example.com");
    expect(normalizeDomain("HTTP://a.example.com:8080")).toBe("a.example.com");
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain(42 as unknown)).toBeNull();
  });
  it("matches a domain and its subdomains against a base", () => {
    expect(domainMatches("zoeeventsdmv.com", "zoeeventsdmv.com")).toBe(true);
    expect(domainMatches("www.zoeeventsdmv.com", "zoeeventsdmv.com")).toBe(true); // subdomain match
    expect(domainMatches("m.yelp.com", "yelp.com")).toBe(true);
    expect(domainMatches("notyelp.com", "yelp.com")).toBe(false);
  });
});

describe("parseSerpResult", () => {
  it("extracts competitors, excludes Zoe + directories, and finds Zoe's rank", () => {
    const raw = serp({ zoeRank: 4, competitors: ["aabletents.com", "dmvrentals.com"], directories: ["yelp.com", "theknot.com"] });
    const p = parseSerpResult(raw, ZOE);
    expect(p.hasData).toBe(true);
    expect(p.serp.zoePresent).toBe(true);
    expect(p.serp.zoeRank).toBe(4);
    expect(p.competitorRefs).toContain("aabletents.com");
    expect(p.competitorRefs).toContain("dmvrentals.com");
    expect(p.competitorRefs).not.toContain("yelp.com"); // directory excluded
    expect(p.competitorRefs).not.toContain(ZOE); // Zoe excluded
    expect(p.relatedKeywords.length).toBeGreaterThan(0);
  });

  it("reports Zoe absent when Zoe is not in the results (the gap signal)", () => {
    const p = parseSerpResult(serp({ competitors: ["aabletents.com", "dmvrentals.com", "partypros.com"] }), ZOE);
    expect(p.serp.zoePresent).toBe(false);
    expect(p.serp.zoeRank).toBeNull();
    expect(p.competitorRefs.length).toBe(3);
  });

  it("never fabricates: an empty read yields hasData=false and no competitors", () => {
    const p = parseSerpResult({ organic: [] }, ZOE);
    expect(p.hasData).toBe(false);
    expect(p.competitorRefs).toEqual([]);
    expect(p.serp.zoePresent).toBe(false);
  });

  it("accepts alternate field shapes (results/link/position)", () => {
    const raw = { results: [{ position: 1, link: "https://aabletents.com", title: "A" }, { position: 2, link: `https://${ZOE}` }] };
    const p = parseSerpResult(raw, ZOE);
    expect(p.serp.zoeRank).toBe(2);
    expect(p.competitorRefs).toEqual(["aabletents.com"]);
  });
});

describe("aggregateCompetitorDomains", () => {
  it("rolls up appearances + mean rank across opportunities, excluding Zoe + directories", () => {
    const mk = (keyword: string, raw: unknown) => ({ keyword, serp: parseSerpResult(raw, ZOE).serp });
    const opps = [
      mk("tent rental", serp({ zoeRank: 5, competitors: ["aabletents.com", "dmvrentals.com"], directories: ["yelp.com"] })),
      mk("wedding tent rental", serp({ competitors: ["aabletents.com", "partypros.com"] })),
    ];
    const agg = aggregateCompetitorDomains(opps, ZOE);
    const able = agg.find((d) => d.domain === "aabletents.com");
    expect(able).toBeTruthy();
    expect(able!.appearances).toBe(2);
    expect(able!.keywords).toContain("tent rental");
    expect(agg.some((d) => d.domain === "yelp.com")).toBe(false); // directory excluded
    expect(agg.some((d) => d.domain === ZOE)).toBe(false); // Zoe excluded
    // sorted by appearances desc → aabletents first
    expect(agg[0].domain).toBe("aabletents.com");
  });

  it("returns [] when no opportunity has a SERP read", () => {
    expect(aggregateCompetitorDomains([{ keyword: "x", serp: null }], ZOE)).toEqual([]);
  });
});

describe("priority — competitive_gap component", () => {
  const match: SeoMatchResult = { action: "CREATE", matchedUrl: null, matchedPath: null, confidence: 0.6, reason: "no page", candidates: [] };
  const gapOf = (serpData: SerpData | null) => {
    const b = scorePriority({ intent: "commercial", category: "tents", metrics: null, match, serp: serpData });
    return b.components.find((c) => c.key === "competitive_gap")!;
  };

  it("scores a Zoe-absent gap high and flags it known", () => {
    const s = parseSerpResult(serp({ competitors: ["a.com", "b.com", "c.com"] }), ZOE).serp;
    const gap = gapOf(s);
    expect(gap.unknown).toBe(false);
    expect(gap.score).toBeGreaterThanOrEqual(80);
  });

  it("scores an already-top-3 Zoe low (little upside)", () => {
    const s = parseSerpResult(serp({ zoeRank: 2, competitors: ["a.com"] }), ZOE).serp;
    expect(gapOf(s).score).toBeLessThanOrEqual(30);
  });

  it("marks the gap UNKNOWN (neutral) when no SERP was read", () => {
    const gap = gapOf(null);
    expect(gap.unknown).toBe(true);
    expect(gap.score).toBe(50);
  });
});

describe("NON_COMPETITOR_DOMAINS", () => {
  it("includes the common event-rental directories", () => {
    for (const d of ["yelp.com", "theknot.com", "weddingwire.com", "thumbtack.com"]) {
      expect(NON_COMPETITOR_DOMAINS).toContain(d);
    }
  });
});

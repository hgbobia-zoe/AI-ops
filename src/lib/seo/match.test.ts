import { describe, expect, it } from "vitest";
import { matchOpportunity, type MatchInput } from "./match";
import type { ZoePage } from "./types";

function page(p: Partial<ZoePage> & { path: string }): ZoePage {
  return {
    path: p.path,
    url: `https://zoeeventsdmv.com${p.path}`,
    title: p.title ?? null,
    h1: p.h1 ?? null,
    headings: p.headings ?? [],
    category: p.category ?? null,
    topic: p.topic ?? p.path.replace(/\//g, ""),
    intent: p.intent ?? "transactional",
    location: p.location ?? "DMV",
    excerpt: p.excerpt ?? null,
    kind: p.kind ?? "category",
  };
}

const INV: ZoePage[] = [
  page({ path: "/tents", title: "Tent Rentals", topic: "tents", category: "tents", intent: "transactional", kind: "category" }),
  page({ path: "/weddings", title: "Wedding Rentals", h1: "Wedding", headings: ["wedding seating tables lighting"], topic: "weddings", category: "weddings", intent: "commercial", kind: "service" }),
  page({ path: "/faq", title: "FAQ", topic: "faq", category: null, intent: "informational", kind: "info" }),
];

describe("match engine", () => {
  it("IMPROVE when a strong existing page already targets the category", () => {
    const input: MatchInput = { keyword: "tent rental", intent: "commercial", location: "DMV", category: "tents" };
    const r = matchOpportunity(input, INV);
    expect(r.action).toBe("IMPROVE");
    expect(r.matchedPath).toBe("/tents");
    expect(r.confidence).toBeGreaterThan(0.6);
  });

  it("CREATE when a category has demand but no existing page (content gap)", () => {
    const input: MatchInput = { keyword: "event lighting rental", intent: "commercial", location: "DMV", category: "lighting" };
    const r = matchOpportunity(input, INV);
    expect(r.action).toBe("CREATE");
    expect(r.matchedUrl).toBeNull();
  });

  it("SKIP when the keyword is not aligned with Zoe's catalog", () => {
    const input: MatchInput = { keyword: "emergency plumber near me", intent: "commercial", location: "DMV", category: null };
    const r = matchOpportunity(input, INV);
    expect(r.action).toBe("SKIP");
  });

  it("CONSOLIDATE when two pages already compete for the same category", () => {
    const inv = [
      ...INV,
      page({ path: "/tent-structures", title: "Tent Structures", topic: "tent structures", category: "tents", intent: "transactional", kind: "category" }),
    ];
    const input: MatchInput = { keyword: "tent rental", intent: "commercial", location: "DMV", category: "tents" };
    const r = matchOpportunity(input, inv);
    expect(r.action).toBe("CONSOLIDATE");
    expect(r.reason).toContain("consolidate");
  });

  it("does NOT create a duplicate location page — IMPROVES the general page for a geo keyword", () => {
    const input: MatchInput = { keyword: "tent rental rockville", intent: "commercial", location: "Rockville, MD", category: "tents" };
    const r = matchOpportunity(input, INV);
    expect(r.action).toBe("IMPROVE");
    expect(r.matchedPath).toBe("/tents");
    expect(r.reason.toLowerCase()).toContain("rockville");
  });

  it("returns ranked candidates with a reason each", () => {
    const r = matchOpportunity({ keyword: "tent rental", intent: "commercial", location: "DMV", category: "tents" }, INV);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0].path).toBe("/tents");
    expect(typeof r.candidates[0].why).toBe("string");
  });
});

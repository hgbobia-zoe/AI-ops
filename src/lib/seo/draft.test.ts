import { describe, expect, it } from "vitest";
import { scaffoldPageDraft, toSlug, titleCase, pickTemplate, suggestInternalLinks, REVIEW_MARKER, type ScaffoldInput } from "./draft";
import type { ZoePage } from "./types";

const PAGES: ZoePage[] = [
  { path: "/", url: "https://zoeeventsdmv.com", title: "Zoe", h1: "Luxury Event Rentals", headings: [], category: null, topic: "home", intent: "commercial", location: "DMV", excerpt: "luxury event rentals", kind: "home" },
  { path: "/tents", url: "https://zoeeventsdmv.com/tents", title: "Tent Rentals", h1: "Tent Rentals", headings: ["Tents"], category: "tents", topic: "tents", intent: "commercial", location: "DMV", excerpt: "tent rentals", kind: "category" },
  { path: "/contact", url: "https://zoeeventsdmv.com/contact", title: "Contact", h1: "Contact", headings: [], category: null, topic: "contact", intent: "transactional", location: "DMV", excerpt: "contact us", kind: "info" },
];

function input(over: Partial<ScaffoldInput> = {}): ScaffoldInput {
  return {
    keyword: "wedding tent rental washington",
    intent: "commercial",
    location: "Washington, DC",
    category: "tents",
    relatedKeywords: ["party tent rental"],
    competitorRefs: ["example.com"],
    metrics: { volume: 1300, difficulty: 42 },
    metricsSource: "ubersuggest",
    researchAt: "2026-10-01T00:00:00.000Z",
    action: "CREATE",
    matchedUrl: null,
    ...over,
  };
}

describe("draft — helpers", () => {
  it("slugifies to a safe lowercase hyphen path", () => {
    expect(toSlug("Wedding Tent Rental & Setup, DC")).toBe("/wedding-tent-rental-and-setup-dc");
    expect(toSlug("  Chiavari   Chair  ")).toBe("/chiavari-chair");
  });
  it("title-cases keeping small words lowercase", () => {
    expect(titleCase("wedding tent rental in dc")).toBe("Wedding Tent Rental in Dc");
  });
  it("picks the matched page, else a same-category page, else home", () => {
    expect(pickTemplate(input({ matchedUrl: "https://zoeeventsdmv.com/tents" }), PAGES)?.path).toBe("/tents");
    expect(pickTemplate(input({ matchedUrl: null, category: "tents" }), PAGES)?.path).toBe("/tents");
    expect(pickTemplate(input({ matchedUrl: null, category: "nope" }), PAGES)?.path).toBe("/");
  });
  it("suggests only real internal links and never the page's own slug", () => {
    const links = suggestInternalLinks(input(), PAGES, "/tents");
    expect(links.every((l) => PAGES.some((p) => p.path === l.path))).toBe(true);
    expect(links.some((l) => l.path === "/tents")).toBe(false);
  });
});

describe("draft — scaffolder (facts only, no fabrication)", () => {
  it("builds a structured draft with title, meta, h1, outline, schema", () => {
    const d = scaffoldPageDraft(input(), PAGES);
    expect(d.slug).toBe("/wedding-tent-rental-washington");
    expect(d.canonicalUrl).toBe("https://zoeeventsdmv.com/wedding-tent-rental-washington");
    expect(d.h1).toContain("Washington, DC");
    expect(d.title.length).toBeGreaterThan(0);
    expect(d.outline.length).toBeGreaterThanOrEqual(5);
    expect(d.schema["@type"]).toBe("Service");
  });
  it("inserts explicit [NEEDS REVIEW] markers where business facts are required, never inventing them", () => {
    const d = scaffoldPageDraft(input(), PAGES);
    const allText = d.body.flatMap((b) => b.paragraphs).join("\n");
    expect(allText).toContain(REVIEW_MARKER);
    // The inventory + FAQ sections must be marked NOT sourced (they carry review placeholders).
    const inventory = d.body.find((b) => b.heading.toLowerCase().includes("options"));
    expect(inventory?.sourced).toBe(false);
    // The real rental-process section is sourced (facts from the live site), no markers.
    const process = d.body.find((b) => b.heading.toLowerCase().includes("process"));
    expect(process?.sourced).toBe(true);
    expect(process?.paragraphs.join(" ")).not.toContain(REVIEW_MARKER);
  });
  it("schema carries only verified fields — no price, rating, or review", () => {
    const d = scaffoldPageDraft(input(), PAGES);
    const s = JSON.stringify(d.schema).toLowerCase();
    expect(s).not.toContain("price");
    expect(s).not.toContain("aggregaterating");
    expect(s).not.toContain("offers");
  });
  it("records an honest research note when no Ubersuggest data is attached (partial research)", () => {
    const d = scaffoldPageDraft(input({ metrics: null, metricsSource: "none", researchAt: null }), PAGES);
    expect(d.sources.researchNote.toLowerCase()).toContain("no live ubersuggest research");
    expect(d.sources.metrics).toBeNull();
  });
  it("attaches the research note + metrics when Ubersuggest data is present", () => {
    const d = scaffoldPageDraft(input(), PAGES);
    expect(d.sources.researchNote.toLowerCase()).toContain("ubersuggest research attached");
    expect(d.sources.metrics?.volume).toBe(1300);
  });
});

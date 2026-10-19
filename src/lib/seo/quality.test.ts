import { describe, expect, it } from "vitest";
import { runQualityChecks } from "./quality";
import { scaffoldPageDraft, type ScaffoldInput } from "./draft";
import type { PageDraft, ZoePage } from "./types";

const PAGES: ZoePage[] = [
  { path: "/", url: "https://zoeeventsdmv.com", title: "Zoe", h1: "Luxury Event Rentals", headings: [], category: null, topic: "home", intent: "commercial", location: "DMV", excerpt: "luxury event rentals", kind: "home" },
  { path: "/tents", url: "https://zoeeventsdmv.com/tents", title: "Tent Rentals", h1: "Tent Rentals", headings: ["Tents"], category: "tents", topic: "tents", intent: "commercial", location: "DMV", excerpt: "tent rentals", kind: "category" },
  { path: "/contact", url: "https://zoeeventsdmv.com/contact", title: "Contact", h1: "Contact", headings: [], category: null, topic: "contact", intent: "transactional", location: "DMV", excerpt: "contact", kind: "info" },
];

function baseInput(over: Partial<ScaffoldInput> = {}): ScaffoldInput {
  return {
    keyword: "wedding tent rental washington",
    intent: "commercial",
    location: "Washington, DC",
    category: "tents",
    relatedKeywords: [],
    competitorRefs: [],
    metrics: null,
    metricsSource: "none",
    researchAt: null,
    action: "CREATE",
    matchedUrl: null,
    ...over,
  };
}

/** Promote a scaffold to a full PageDraft (review metadata zeroed). */
function draftFrom(over: Partial<ScaffoldInput> = {}): PageDraft {
  const s = scaffoldPageDraft(baseInput(over), PAGES);
  return {
    id: "d", opportunityId: "o", ...s, flags: [], draftSource: "deterministic", reviewState: "DRAFT",
    reviewNote: null, reviewedBy: null, reviewedAt: null, createdBy: null,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  } as PageDraft;
}

describe("quality — the scaffolder output passes structural checks", () => {
  it("a clean scaffold has no error-level findings", () => {
    const r = runQualityChecks(draftFrom(), PAGES);
    expect(r.passedStructural).toBe(true);
    expect(r.errors).toBe(0);
  });
  it("counts the [NEEDS REVIEW] markers as unsupported claims needing human verification", () => {
    const r = runQualityChecks(draftFrom(), PAGES);
    expect(r.unsupportedClaims).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.id === "claims.markers")).toBe(true);
  });
});

describe("quality — factual-claim detection (honesty backbone)", () => {
  it("flags pricing language that slipped into non-marker copy as an error", () => {
    const d = draftFrom();
    d.body[2].paragraphs.push("Tent rentals start at $499 per day with a free setup guarantee.");
    const r = runQualityChecks(d, PAGES);
    expect(r.findings.some((f) => f.id === "claims.pricing")).toBe(true);
    expect(r.findings.some((f) => f.id === "claims.superlative")).toBe(true);
    expect(r.passedStructural).toBe(false);
  });
  it("flags testimonial / inventory-count language", () => {
    const d = draftFrom();
    d.body[2].paragraphs.push('We stock 250 tents and clients say "best rental ever".');
    const r = runQualityChecks(d, PAGES);
    expect(r.findings.some((f) => f.id === "claims.inventory")).toBe(true);
    expect(r.findings.some((f) => f.id === "claims.testimonial")).toBe(true);
  });
});

describe("quality — title/meta/url/schema/duplication", () => {
  it("flags an over-long title and an empty meta", () => {
    const d = draftFrom();
    d.title = "x".repeat(80);
    d.metaDescription = "";
    const r = runQualityChecks(d, PAGES);
    expect(r.findings.some((f) => f.id === "title.length")).toBe(true);
    expect(r.findings.some((f) => f.id === "meta.empty")).toBe(true);
  });
  it("flags a bad slug (uppercase / illegal chars)", () => {
    const d = draftFrom();
    d.slug = "/Wedding Tent!";
    const r = runQualityChecks(d, PAGES);
    expect(r.findings.some((f) => f.id === "url.case")).toBe(true);
    expect(r.findings.some((f) => f.id === "url.chars")).toBe(true);
  });
  it("flags schema that contains fabricated ratings/price", () => {
    const d = draftFrom();
    d.schema = { "@context": "https://schema.org", "@type": "Service", name: "x", provider: {}, aggregateRating: { ratingValue: 5 } };
    const r = runQualityChecks(d, PAGES);
    expect(r.findings.some((f) => f.id === "schema.unverified")).toBe(true);
  });
  it("flags a CREATE whose slug duplicates an existing live page", () => {
    const d = draftFrom();
    d.action = "CREATE";
    d.slug = "/tents"; // already exists in PAGES
    const r = runQualityChecks(d, PAGES);
    expect(r.findings.some((f) => f.id === "dupe.slug")).toBe(true);
    expect(r.passedStructural).toBe(false);
  });
});

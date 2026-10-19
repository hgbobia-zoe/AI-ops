import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZoePage, SeoPriorityBreakdown } from "./types";

// Isolate a throwaway DB so the seo_* tables (incl. seo_page_drafts) are created end-to-end.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-seo-produce-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function mods() {
  const store = await import("./store");
  const produce = await import("./produce");
  const draftStore = await import("./draftStore");
  return { ...store, ...produce, ...draftStore };
}

const PAGES: ZoePage[] = [
  { path: "/", url: "https://zoeeventsdmv.com", title: "Zoe", h1: "Luxury Event Rentals", headings: [], category: null, topic: "home", intent: "commercial", location: "DMV", excerpt: "luxury event rentals", kind: "home" },
  { path: "/tents", url: "https://zoeeventsdmv.com/tents", title: "Tent Rentals", h1: "Tent Rentals", headings: ["Tents"], category: "tents", topic: "tents", intent: "commercial", location: "DMV", excerpt: "tent rentals", kind: "category" },
  { path: "/contact", url: "https://zoeeventsdmv.com/contact", title: "Contact", h1: "Contact", headings: [], category: null, topic: "contact", intent: "transactional", location: "DMV", excerpt: "contact", kind: "info" },
];

const BREAKDOWN: SeoPriorityBreakdown = { score: 70, components: [], summary: "test" };

/** Create an opportunity analyzed as CREATE and move it to APPROVED (through the legal stage path). */
async function approvedOpp(keyword: string, location: string | null) {
  const m = await mods();
  const id = m.upsertOpportunity({ keyword, intent: "commercial", location, category: "tents" });
  m.setAnalysis(id, { matchedUrl: null, recommendedAction: "CREATE", priority: 70, priorityBreakdown: BREAKDOWN, explanation: "gap" });
  m.setOpportunityStage(id, "ANALYZING", "Tester");
  m.setOpportunityStage(id, "APPROVED", "Tester");
  return id;
}

describe("produce — approval gate", () => {
  it("refuses to draft an opportunity that is not yet approved", async () => {
    const m = await mods();
    const id = m.upsertOpportunity({ keyword: "chiavari chair rental", intent: "commercial", location: "DMV", category: "chairs" });
    m.setAnalysis(id, { matchedUrl: null, recommendedAction: "CREATE", priority: 50, priorityBreakdown: BREAKDOWN, explanation: "x" });
    const r = m.produceDraft(id, { pages: PAGES });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_approved");
  });

  it("refuses to draft a SKIP / unanalyzed opportunity", async () => {
    const m = await mods();
    const id = m.upsertOpportunity({ keyword: "plumbing services", intent: "commercial", location: "DMV" });
    const r = m.produceDraft(id, { pages: PAGES });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_producible");
  });

  it("returns not_found for a missing opportunity", async () => {
    const m = await mods();
    expect(m.produceDraft("SEOP-missing", { pages: PAGES }).error).toBe("not_found");
  });
});

describe("produce — successful preview + idempotency", () => {
  it("produces a draft with a quality report for an approved opportunity", async () => {
    const m = await mods();
    const id = await approvedOpp("wedding tent rental alexandria", "Alexandria, VA");
    const r = m.produceDraft(id, { pages: PAGES, actor: "Tester" });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(r.draft?.reviewState).toBe("DRAFT");
    expect(r.quality).toBeTruthy();
    expect(r.quality!.unsupportedClaims).toBeGreaterThan(0); // review markers present
    // Producing moved the opportunity onto the DRAFTING stage.
    expect(m.getOpportunity(id)!.stage).toBe("DRAFTING");
  });

  it("is idempotent — a duplicate request returns the same draft, never a second row", async () => {
    const m = await mods();
    const id = await approvedOpp("wedding tent rental bethesda", "Bethesda, MD");
    const first = m.produceDraft(id, { pages: PAGES });
    const second = m.produceDraft(id, { pages: PAGES });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.draft!.id).toBe(first.draft!.id);
    expect(m.listDrafts().filter((d) => d.opportunityId === id)).toHaveLength(1);
  });

  it("attaches an honest 'no live research' note when the opportunity has no metrics", async () => {
    const m = await mods();
    const id = await approvedOpp("dance floor rental fairfax", "Fairfax, VA");
    const r = m.produceDraft(id, { pages: PAGES });
    expect(r.draft!.sources.researchNote.toLowerCase()).toContain("no live ubersuggest research");
  });
});

describe("produce — review gate (submit / approve / reject)", () => {
  it("submit → approve advances the opportunity to APPROVED_FOR_PUBLISHING (never auto-publishes)", async () => {
    const m = await mods();
    const id = await approvedOpp("lounge furniture rental arlington", "Arlington, VA");
    const draftId = m.produceDraft(id, { pages: PAGES }).draft!.id;

    expect(m.submitForReview(draftId, "Reviewer").ok).toBe(true);
    expect(m.getDraft(draftId)!.reviewState).toBe("IN_REVIEW");
    expect(m.getOpportunity(id)!.stage).toBe("REVIEW");

    const approved = m.approveDraft(draftId, "Reviewer", "looks good");
    expect(approved.ok).toBe(true);
    expect(m.getDraft(draftId)!.reviewState).toBe("APPROVED");
    // The furthest the engine goes on its own — NOT published.
    expect(m.getOpportunity(id)!.stage).toBe("APPROVED_FOR_PUBLISHING");
    expect(m.getOpportunity(id)!.stage).not.toBe("PUBLISHED");
  });

  it("cannot approve a draft that was never submitted for review", async () => {
    const m = await mods();
    const id = await approvedOpp("stage rental rockville", "Rockville, MD");
    const draftId = m.produceDraft(id, { pages: PAGES }).draft!.id;
    expect(m.approveDraft(draftId, "Reviewer").ok).toBe(false);
  });

  it("reject sends the opportunity back to DRAFTING and marks the draft REJECTED", async () => {
    const m = await mods();
    const id = await approvedOpp("portable bar rental silver spring", "Silver Spring, MD");
    const draftId = m.produceDraft(id, { pages: PAGES }).draft!.id;
    m.submitForReview(draftId, "Reviewer");
    const r = m.rejectDraft(draftId, "Reviewer", "needs real inventory details");
    expect(r.ok).toBe(true);
    expect(m.getDraft(draftId)!.reviewState).toBe("REJECTED");
    expect(m.getOpportunity(id)!.stage).toBe("DRAFTING");
  });
});

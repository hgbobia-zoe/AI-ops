import { describe, it, expect } from "vitest";
import { buildMarketingOverview } from "./overview";
import type { MarketingDashboard } from "./dashboard";
import { emptyChannelLinks, type Prospect, type ContentItem, type Review, type ProspectStatus } from "./types";

const TODAY = "2026-10-29";

function baseDashboard(over: Partial<MarketingDashboard> = {}): MarketingDashboard {
  return {
    today: TODAY,
    campaigns: { total: 0, byStatus: { idea: 0, planned: 0, live: 0, paused: 0, done: 0 }, live: [], activeBudget: 0, activeSpend: 0 },
    content: { upcoming: [], overdue: [], ideas: 0 },
    reviews: { count: 0, avgRating: null, unresponded: 0, recent: [] },
    outreach: {
      open: 0,
      byStage: { to_contact: 0, contacted: 0, responded: 0, quote_agreed: 0, not_interested: 0 },
      winsRecent: 0,
      dueThisWeek: [],
      winsBySource: [],
    },
    links: emptyChannelLinks(),
    ...over,
  };
}

function prospect(nextAction: string | null, status: ProspectStatus = "contacted"): Prospect {
  return {
    id: `MP-${nextAction ?? "x"}`, name: "Lead", contact: "", audience: "both", source: null, status,
    campaignId: null, owner: "", nextAction, notes: "", wonAt: null, createdBy: null, createdAt: TODAY, updatedAt: TODAY,
  };
}

function content(planDate: string | null): ContentItem {
  return {
    id: `MK-${planDate ?? "x"}`, title: "Post", channel: "social", format: "", planDate, status: "scheduled",
    audience: "both", owner: "", link: "", notes: "", createdAt: TODAY, updatedAt: TODAY,
  };
}

function review(responded: boolean): Review {
  return {
    id: `MR-${responded}`, source: "google", reviewer: "A", rating: 5, reviewDate: TODAY, text: "", responded,
    responseNote: "", link: "", createdAt: TODAY, updatedAt: TODAY,
  };
}

describe("buildMarketingOverview", () => {
  it("flags setup mode when nothing is entered and no tools are linked", () => {
    const vm = buildMarketingOverview(baseDashboard());
    expect(vm.isSetup).toBe(true);
    expect(vm.attention).toHaveLength(0);
    expect(vm.hasLinks).toBe(false);
    // Setup still exposes a concrete forward action, never a dead end.
    expect(vm.primary.href).toBe("/marketing/outreach");
  });

  it("is NOT setup mode once any tool link is saved (even with zero records)", () => {
    const vm = buildMarketingOverview(baseDashboard({ links: { ...emptyChannelLinks(), confluence: "https://x" } }));
    expect(vm.isSetup).toBe(false);
    expect(vm.hasLinks).toBe(true);
    expect(vm.linkCount).toBe(1);
  });

  it("never implies the business has no reviews — scope says manually logged", () => {
    const vm = buildMarketingOverview(baseDashboard());
    expect(vm.hasReviewData).toBe(false);
    expect(vm.scope.reviews.toLowerCase()).toContain("manually logged");
    expect(vm.scope.reviews.toLowerCase()).toContain("not a live");
  });

  it("surfaces only non-empty attention buckets, highest priority first", () => {
    const vm = buildMarketingOverview(
      baseDashboard({
        outreach: {
          open: 2, byStage: { to_contact: 0, contacted: 2, responded: 0, quote_agreed: 0, not_interested: 0 },
          winsRecent: 0, dueThisWeek: [prospect("2026-10-31")], winsBySource: [],
        },
        reviews: { count: 3, avgRating: 4.6, unresponded: 1, recent: [review(false)] },
      }),
    );
    expect(vm.attention.map((a) => a.key)).toEqual(["outreach", "reviews"]);
    expect(vm.attentionTotal).toBe(2);
  });

  it("marks outreach critical + overdue when a next action is past today", () => {
    const vm = buildMarketingOverview(
      baseDashboard({
        outreach: {
          open: 1, byStage: { to_contact: 0, contacted: 1, responded: 0, quote_agreed: 0, not_interested: 0 },
          winsRecent: 0, dueThisWeek: [prospect("2026-10-20")], winsBySource: [],
        },
      }),
    );
    const o = vm.attention.find((a) => a.key === "outreach")!;
    expect(o.overdue).toBe(1);
    expect(o.tone).toBe("critical");
    expect(o.detail).toContain("overdue");
  });

  it("primary action prefers the overdue bucket even when it is lower in base priority", () => {
    const vm = buildMarketingOverview(
      baseDashboard({
        // outreach due but NOT overdue; content overdue (lower base priority but past date)
        outreach: {
          open: 1, byStage: { to_contact: 0, contacted: 1, responded: 0, quote_agreed: 0, not_interested: 0 },
          winsRecent: 0, dueThisWeek: [prospect("2026-11-02")], winsBySource: [],
        },
        content: { upcoming: [], overdue: [content("2026-10-01")], ideas: 0 },
      }),
    );
    expect(vm.primary.href).toBe("/marketing/content");
    expect(vm.primary.tone).toBe("attention");
  });

  it("falls back to a growth action when caught up with data present", () => {
    const vm = buildMarketingOverview(
      baseDashboard({
        campaigns: { total: 1, byStatus: { idea: 0, planned: 0, live: 1, paused: 0, done: 0 }, live: [], activeBudget: 0, activeSpend: 0 },
      }),
    );
    expect(vm.isSetup).toBe(false);
    expect(vm.attention).toHaveLength(0);
    expect(vm.primary).toEqual({ label: "Add a prospect", href: "/marketing/outreach", tone: "neutral" });
    expect(vm.hasCampaignData).toBe(true);
  });
});

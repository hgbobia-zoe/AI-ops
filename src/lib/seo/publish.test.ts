import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZoePage, SeoPriorityBreakdown, PageDraft } from "./types";

// Real SEO + Website Studio stores on a throwaway DB: approve a draft, send it, drive the job like the runner
// does, and check the SEO card moves to Published only on a real merge (and, for a new page, a live URL).
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-seo-publish-"));
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
  return { ...(await import("./store")), ...(await import("./produce")), ...(await import("./draftStore")), ...(await import("./publish")), jobs: await import("@/lib/website/jobs") };
}

const PAGES: ZoePage[] = [
  { path: "/", url: "https://zoeeventsdmv.com", title: "Zoe", h1: "Luxury Event Rentals", headings: [], category: null, topic: "home", intent: "commercial", location: "DMV", excerpt: "luxury event rentals", kind: "home" },
  { path: "/tents", url: "https://zoeeventsdmv.com/tents", title: "Tent Rentals", h1: "Tent Rentals", headings: ["Tents"], category: "tents", topic: "tents", intent: "commercial", location: "DMV", excerpt: "tent rentals", kind: "category" },
];
const BREAKDOWN: SeoPriorityBreakdown = { score: 70, components: [], summary: "test" };

/** An opportunity analyzed with `action`, approved, drafted, submitted and approved as a draft. */
async function approvedDraft(keyword: string, action: "CREATE" | "IMPROVE"): Promise<PageDraft> {
  const m = await mods();
  const id = m.upsertOpportunity({ keyword, intent: "commercial", location: "Bethesda, MD", category: "tents" });
  m.setAnalysis(id, { matchedUrl: action === "IMPROVE" ? "https://zoeeventsdmv.com/tents" : null, recommendedAction: action, priority: 70, priorityBreakdown: BREAKDOWN, explanation: "gap" });
  m.setOpportunityStage(id, "ANALYZING", "Tester");
  m.setOpportunityStage(id, "APPROVED", "Tester");
  const r = m.produceDraft(id, { pages: PAGES });
  expect(r.ok).toBe(true);
  const draftId = r.draft!.id;
  expect(m.submitForReview(draftId, "Reviewer").ok).toBe(true);
  expect(m.approveDraft(draftId, "Reviewer").ok).toBe(true);
  return m.getDraft(draftId)!;
}

/** Drive a job the way the office runner + a human do: claim → preview → approve → done(summary). */
async function runJob(jobId: string, summary: string) {
  const { jobs } = await mods();
  // Claim until we reach this job (fail any stray earlier ones), like a single-flight runner would.
  for (let c = jobs.claimNextPending(); c && c.id !== jobId; c = jobs.claimNextPending()) jobs.failJob(c.id, "stray");
  expect(jobs.getJob(jobId)?.status).toBe("running");
  jobs.setJobPreview(jobId, { summary: "edited", changedFiles: ["a.php"], pagePaths: ["/"] });
  jobs.decideJob(jobId, "approve", "Marketer");
  return jobs.completeJob(jobId, { summary, prUrl: "https://github.com/x/y/pull/9" })!;
}

const ok200 = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;

describe("sendDraftToWebsiteStudio", () => {
  it("refuses a draft that is not approved", async () => {
    const m = await mods();
    const id = m.upsertOpportunity({ keyword: "lounge furniture rental", intent: "commercial", location: "DMV", category: "lounge" });
    m.setAnalysis(id, { matchedUrl: null, recommendedAction: "CREATE", priority: 60, priorityBreakdown: BREAKDOWN, explanation: "x" });
    m.setOpportunityStage(id, "ANALYZING", "Tester");
    m.setOpportunityStage(id, "APPROVED", "Tester");
    const d = m.produceDraft(id, { pages: PAGES }).draft!;
    const r = m.sendDraftToWebsiteStudio(d.id, "Owner");
    expect(r.ok).toBe(false);
  });

  it("queues one job, attributed to the sender, carrying the approved copy; a repeat returns the same job", async () => {
    const m = await mods();
    const draft = await approvedDraft("tent rental bethesda", "CREATE");
    const r = m.sendDraftToWebsiteStudio(draft.id, "Hermann");
    expect(r.ok).toBe(true);
    expect(r.job!.requester).toBe("Hermann");
    expect(r.job!.prompt).toContain(draft.h1);
    expect(r.job!.prompt).toContain("create-");
    expect(r.job!.prompt).not.toContain("[NEEDS REVIEW:");
    expect(r.job!.contextUrl).toBeNull(); // a new page has no live URL yet
    expect(m.getDraft(draft.id)!.websiteJobId).toBe(r.job!.id);
    const again = m.sendDraftToWebsiteStudio(draft.id, "Hermann");
    expect(again.existing).toBe(true);
    expect(again.job!.id).toBe(r.job!.id);
    expect(m.decisionHistory(draft.opportunityId).some((h) => h.to === "SENT_TO_WEBSITE_STUDIO" && h.actor === "Hermann")).toBe(true);
    // Done with this job so later tests claim their own.
    m.jobs.claimNextPending();
    m.jobs.failJob(r.job!.id, "test cleanup");
  });
});

describe("syncPublishState", () => {
  it("IMPROVE: merged → Published", async () => {
    const m = await mods();
    const draft = await approvedDraft("tent rental", "IMPROVE");
    const { job } = m.sendDraftToWebsiteStudio(draft.id, "Owner");
    expect(job!.contextUrl).toBe("https://zoeeventsdmv.com/tents");
    const done = await runJob(job!.id, "Edited copy.\n\nSite checks passed (Theme checks). Merged into `master` — the live-site (Kinsta) deploy is triggered.");
    expect(await m.syncPublishState(done)).toBe("published");
    expect(m.getOpportunity(draft.opportunityId)!.stage).toBe("PUBLISHED");
  });

  it("done but not merged (merge failed) stays Ready to publish", async () => {
    const m = await mods();
    const draft = await approvedDraft("event tent rental", "IMPROVE");
    const { job } = m.sendDraftToWebsiteStudio(draft.id, "Owner");
    const done = await runJob(job!.id, "Edited.\n\nPR opened into `master` but the automatic merge did not complete (x). Merge it manually to deploy.");
    expect(await m.syncPublishState(done)).toBe("not_merged");
    expect(m.getOpportunity(draft.opportunityId)!.stage).toBe("APPROVED_FOR_PUBLISHING");
  });

  it("CREATE: merged but page not live waits; once live it publishes", async () => {
    const m = await mods();
    const draft = await approvedDraft("tent rental rockville", "CREATE");
    const { job } = m.sendDraftToWebsiteStudio(draft.id, "Owner");
    const done = await runJob(job!.id, "Added page.\n\nMerged into `master` — the live-site (Kinsta) deploy is triggered.");
    expect(await m.syncPublishState(done, { fetcher: notFound })).toBe("awaiting_page");
    expect(m.getOpportunity(draft.opportunityId)!.stage).toBe("APPROVED_FOR_PUBLISHING");
    expect(await m.syncPublishState(done, { fetcher: ok200, quiet: true })).toBe("published");
    expect(m.getOpportunity(draft.opportunityId)!.stage).toBe("PUBLISHED");
  });

  it("a failed job is recorded and the draft can be sent again", async () => {
    const m = await mods();
    const draft = await approvedDraft("wedding tent rental", "CREATE");
    const first = m.sendDraftToWebsiteStudio(draft.id, "Owner").job!;
    for (let c = m.jobs.claimNextPending(); c && c.id !== first.id; c = m.jobs.claimNextPending()) m.jobs.failJob(c.id, "stray");
    const failed = m.jobs.failJob(first.id, "Site checks failed: Theme checks.")!;
    await m.syncPublishState(failed);
    expect(m.decisionHistory(draft.opportunityId).some((h) => h.to === "WEBSITE_JOB_FAILED")).toBe(true);
    const second = m.sendDraftToWebsiteStudio(draft.id, "Owner");
    expect(second.ok).toBe(true);
    expect(second.existing).toBeFalsy();
    expect(second.job!.id).not.toBe(first.id);
  });
});

describe("liveUrlFor / scriptSlug", () => {
  it("derive the live URL and the create-script slug from the canonical URL", async () => {
    const m = await mods();
    const d = { canonicalUrl: "https://zoeeventsdmv.com/tent-rental-bethesda", slug: "tent-rental-bethesda" } as PageDraft;
    expect(m.liveUrlFor(d, "https://zoeeventsdmv.com")).toBe("https://zoeeventsdmv.com/tent-rental-bethesda/");
    expect(m.scriptSlug(d)).toBe("tent-rental-bethesda");
  });
});

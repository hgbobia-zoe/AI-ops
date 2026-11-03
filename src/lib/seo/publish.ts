// SEO Growth → Website Studio: PUBLISH an approved page draft. An approved draft (review gate #3) is sent to
// Website Studio as a website-change job. Website Studio's own gates still apply: the agent edits a working
// branch, a human approves the rendered preview, the site checks must pass, then it merges to master (Kinsta).
//
// The SEO card moves to PUBLISHED only on its REAL condition (gates reflect reality):
//   • IMPROVE / CONSOLIDATE: the change is merged to master (the live theme deploy).
//   • CREATE: merged AND the new page URL answers 200 on the live site. A new WordPress page also needs its
//     create script run once on Kinsta, so a merge alone is not "published".
// Every send is attributed to the person who clicked it; the runner's results are attributed to Website Studio.

import { createJob, getJob, type WebsiteJob } from "@/lib/website/jobs";
import { websiteEnvUrls } from "@/lib/website/config";
import { getDb } from "@/lib/db";
import { getDraft, recordDraftAudit } from "./draftStore";
import { getOpportunity, setOpportunityStage } from "./store";
import type { PageDraft, SeoOpportunity } from "./types";

/** The runner's summary line for an immediate merge starts with this (tools/website-studio-runner/runner.js,
 *  mergeToDeployBranch). Anything else (auto-merge armed, merge failed) is NOT a merge. */
export const MERGED_MARKER = "Merged into `";

const REVIEW_MARKER = /\[NEEDS REVIEW:[^\]]*\]/g;

/** Drop any [NEEDS REVIEW: ...] marker: unreviewed text never reaches the website. */
function clean(s: string): string {
  return s.replace(REVIEW_MARKER, "").replace(/\s{2,}/g, " ").trim();
}

function pathOf(draft: PageDraft): string {
  const fromCanonical = (() => {
    try {
      return draft.canonicalUrl ? new URL(draft.canonicalUrl).pathname : "";
    } catch {
      return "";
    }
  })();
  const raw = fromCanonical || draft.slug || "/";
  const p = raw.startsWith("/") ? raw : `/${raw}`;
  return p.endsWith("/") ? p : `${p}/`;
}

/** The page's live URL on production. */
export function liveUrlFor(draft: PageDraft, origin: string = websiteEnvUrls().production): string {
  return `${origin.replace(/\/+$/, "")}${pathOf(draft)}`;
}

/** The slug used for a new page's create script, e.g. "/tent-rental-bethesda/" → "tent-rental-bethesda". */
export function scriptSlug(draft: PageDraft): string {
  return pathOf(draft).replace(/^\/+|\/+$/g, "").split("/").pop() || "page";
}

/** Plain-English instructions for the Website Studio agent. It carries the approved copy verbatim, strips
 *  anything still marked [NEEDS REVIEW], and points the agent at the website repo's own conventions. */
export function buildPublishPrompt(draft: PageDraft, opp: Pick<SeoOpportunity, "keyword" | "matchedUrl"> | null): string {
  const path = pathOf(draft);
  const lines: string[] = [];
  const keyword = opp?.keyword ?? draft.sources.keyword;

  if (draft.action === "CREATE") {
    lines.push(
      `Create a new SEO landing page at ${path} for the search "${keyword}". The copy below was approved in Zoe's SEO review; use it as written.`,
      "",
      "Follow this repo's conventions (read CLAUDE.md first):",
      `- Put the page copy in the theme, keyed by the slug "${scriptSlug(draft)}", in the template that fits best${draft.templatePath ? ` (suggested: ${draft.templatePath})` : ""}. Reuse an existing template; do not invent a new layout.`,
      `- Add a provisioning script wordpress/create-${scriptSlug(draft)}-page.php modeled on the existing wordpress/create-*.php scripts (idempotent, assigns the template).`,
      "- Make the page reachable: add it to the relevant hub or registry so it is linked, as CLAUDE.md describes.",
    );
  } else {
    lines.push(
      `Improve the existing page at ${path}${opp?.matchedUrl ? ` (${opp.matchedUrl})` : ""} for the search "${keyword}". The copy below was approved in Zoe's SEO review.`,
      "",
      "Read CLAUDE.md first and follow the repo's conventions. Find where this page's copy lives (usually theme copy keyed by the page slug) and update it. Keep the existing layout, images, forms and structured data that already work; add the approved sections and wording.",
    );
  }

  lines.push(
    "",
    "Rules:",
    "- Use only the approved text below. Do not add prices, ratings, review counts, phone numbers or claims that are not in it.",
    "- Leave out anything marked [NEEDS REVIEW] (already removed below where it appeared).",
    "- Keep the house style: no em dashes in new copy.",
    "",
    `SEO title: ${clean(draft.title)}`,
    `Meta description: ${clean(draft.metaDescription)}`,
    `H1: ${clean(draft.h1)}`,
    "",
    "Sections:",
  );
  for (const block of draft.body) {
    const paragraphs = block.paragraphs.map(clean).filter(Boolean);
    const heading = clean(block.heading);
    if (!paragraphs.length || !heading) continue;
    lines.push(`${block.level === 3 ? "###" : "##"} ${heading}`);
    for (const p of paragraphs) lines.push(p);
    lines.push("");
  }
  if (draft.internalLinks.length) {
    lines.push("Internal links to include (anchor text -> path):");
    for (const l of draft.internalLinks) if (clean(l.anchor)) lines.push(`- ${clean(l.anchor)} -> ${l.path}`);
    lines.push("");
  }
  if (draft.schema) {
    const schema = JSON.stringify(draft.schema);
    if (!REVIEW_MARKER.test(schema)) lines.push("JSON-LD structured data to add if the template does not already output equivalent schema:", schema, "");
    REVIEW_MARKER.lastIndex = 0;
  }
  lines.push(`(From SEO draft ${draft.id}.)`);
  return lines.join("\n").trim();
}

export function getDraftByWebsiteJob(jobId: string): PageDraft | null {
  const r = getDb().prepare("SELECT id FROM seo_page_drafts WHERE website_job_id = ? LIMIT 1").get(jobId) as { id: string } | undefined;
  return r ? getDraft(r.id) : null;
}

const RESENDABLE = new Set(["failed", "discarded"]);

export interface SendResult {
  ok: boolean;
  error?: string;
  job?: WebsiteJob;
  /** True when an in-flight job already existed (no new job created). */
  existing?: boolean;
}

/**
 * Send an APPROVED draft to Website Studio. Idempotent: while the linked job is in flight (or done) it returns
 * that job instead of queuing another. A failed/discarded job can be re-sent. Attributed to `actor`.
 */
export function sendDraftToWebsiteStudio(draftId: string, actor: string | null): SendResult {
  const draft = getDraft(draftId);
  if (!draft) return { ok: false, error: "not_found" };
  if (draft.reviewState !== "APPROVED") return { ok: false, error: "only an approved draft can be sent to Website Studio" };
  if (draft.action === "SKIP") return { ok: false, error: "a SKIP opportunity is never published" };

  if (draft.websiteJobId) {
    const prior = getJob(draft.websiteJobId);
    if (prior && !RESENDABLE.has(prior.status)) return { ok: true, job: prior, existing: true };
  }

  const opp = getOpportunity(draft.opportunityId);
  const contextUrl = draft.action === "CREATE" ? null : opp?.matchedUrl || liveUrlFor(draft);
  const job = createJob({ prompt: buildPublishPrompt(draft, opp), requester: actor, contextUrl, environment: "production" });
  if (!job) return { ok: false, error: "could not queue the Website Studio job" };

  getDb().prepare("UPDATE seo_page_drafts SET website_job_id = ?, updated_at = ? WHERE id = ?").run(job.id, new Date().toISOString(), draft.id);
  recordDraftAudit(draft.opportunityId, "APPROVED", "SENT_TO_WEBSITE_STUDIO", actor, `sent to Website Studio as job ${job.id}`);
  return { ok: true, job };
}

/** Did this finished job actually merge to master? (Only the runner's immediate-merge note means yes.) */
export function jobMerged(job: Pick<WebsiteJob, "status" | "summary">): boolean {
  return job.status === "done" && !!job.summary && job.summary.includes(MERGED_MARKER);
}

/** Probe the live page. True only on an HTTP 200 (after redirects). Never throws. */
export async function pageIsLive(url: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetcher(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "user-agent": "ZoeOps-SEO-publish-check" } });
    return res.status === 200;
  } catch {
    return false;
  }
}

export type PublishSync = "published" | "awaiting_page" | "not_merged" | "no_change";

/**
 * Reconcile the SEO side with a Website Studio job's real outcome. Called when the runner reports a job done
 * or failed, and again when someone opens the draft (so a CREATE page that went live later is picked up).
 * Never throws; returns what it concluded.
 */
export async function syncPublishState(job: WebsiteJob, opts: { fetcher?: typeof fetch; quiet?: boolean } = {}): Promise<PublishSync> {
  try {
    const draft = getDraftByWebsiteJob(job.id);
    if (!draft) return "no_change";
    const opp = getOpportunity(draft.opportunityId);
    if (!opp) return "no_change";
    const actor = "Website Studio";

    if (job.status === "failed" || job.status === "discarded") {
      if (opts.quiet) return "no_change";
      recordDraftAudit(draft.opportunityId, "SENT_TO_WEBSITE_STUDIO", `WEBSITE_JOB_${job.status.toUpperCase()}`, job.status === "discarded" ? job.decidedBy : actor, job.error ? `Website Studio job ${job.status}: ${job.error}` : `Website Studio job ${job.status}`);
      return "no_change";
    }
    if (job.status !== "done") return "no_change";
    if (opp.stage === "PUBLISHED" || opp.stage === "MONITORING") return "published";

    if (!jobMerged(job)) {
      if (opts.quiet) return "not_merged";
      recordDraftAudit(draft.opportunityId, "SENT_TO_WEBSITE_STUDIO", "WEBSITE_PR_OPEN", actor, `Website Studio finished but the change is not merged yet${job.prUrl ? `: ${job.prUrl}` : ""}`);
      return "not_merged";
    }

    if (draft.action === "CREATE") {
      const url = liveUrlFor(draft);
      if (!(await pageIsLive(url, opts.fetcher))) {
        if (opts.quiet) return "awaiting_page";
        recordDraftAudit(draft.opportunityId, "SENT_TO_WEBSITE_STUDIO", "AWAITING_PAGE", actor, `Merged${job.prUrl ? ` (${job.prUrl})` : ""}. The page goes live once wordpress/create-${scriptSlug(draft)}-page.php is run on Kinsta (wp eval-file). ${url} is not live yet.`);
        return "awaiting_page";
      }
    }

    setOpportunityStage(draft.opportunityId, "PUBLISHED", actor, `published via Website Studio${job.prUrl ? ` (${job.prUrl})` : ""}`, { force: true });
    return "published";
  } catch {
    return "no_change";
  }
}

/** The Website Studio job linked to a draft, for display. */
export function websiteJobForDraft(draft: PageDraft): Pick<WebsiteJob, "id" | "status" | "prUrl" | "error" | "updatedAt"> | null {
  if (!draft.websiteJobId) return null;
  const j = getJob(draft.websiteJobId);
  return j ? { id: j.id, status: j.status, prUrl: j.prUrl, error: j.error, updatedAt: j.updatedAt } : null;
}

// Creative Engine — PURE view logic for the jobs list/grid + card. No DB, no React, client-safe.
// Everything here is deterministic over the real job + its generations/source image, so it is unit-tested
// without a database and reused by both the server page and the client surfaces.
//
// Platform law: rules calculate, AI interprets. Nothing here fabricates a status, an asset, or an action —
// it only maps the REAL lifecycle position to the shared Nocturne status vocabulary and the single next
// valid step. A missing thumbnail resolves to null (the frame shows an honest fallback), never a fake image.

import type { Tone } from "@/lib/tone";
import { JOB_STATUS_ORDER, type CreativeJob, type Generation, type CreativeImage, type JobStatus } from "./types";

// ── Status → shared tone ────────────────────────────────────────────────────────────────────────────
// Maps the real lifecycle status onto the five-tone Nocturne status model. Approval (positive) and
// publication (positive, but a DISTINCT status/label) are deliberately not collapsed — asset approval is
// not publication. "Needs revision" is the QC-failed state (attention, a human may regenerate).
export const JOB_STATUS_TONE: Record<JobStatus, Tone> = {
  draft: "neutral",
  queued: "info",
  generating: "info",
  qa: "info",
  needs_revision: "attention",
  awaiting_approval: "attention",
  approved: "positive",
  rejected: "critical",
  published: "positive",
};

// ── The single next valid action (hint shown on the card; performed on the detail) ───────────────────
export interface NextAction {
  /** Short verb label for the card ("Review & approve", "Regenerate", …). */
  label: string;
  /** Whether a human can act now (vs. waiting on the pipeline / a terminal state). */
  actionable: boolean;
}

/** The one next step for a job, from its REAL status (and whether it has generated before). The action is
 *  performed on the job detail; the card only labels it and links there. */
export function nextAction(job: Pick<CreativeJob, "status" | "generationCount">): NextAction {
  switch (job.status) {
    case "draft":
      return { label: "Compose brief & generate", actionable: true };
    case "queued":
      return { label: job.generationCount > 0 ? "Regenerate" : "Generate", actionable: true };
    case "generating":
      return { label: "Awaiting result", actionable: false };
    case "qa":
      return { label: "Quality control", actionable: false };
    case "needs_revision":
      return { label: "Regenerate", actionable: true };
    case "awaiting_approval":
      return { label: "Review & approve", actionable: true };
    case "approved":
      return { label: "Save asset", actionable: true };
    case "published":
      return { label: "View saved asset", actionable: true };
    case "rejected":
      return { label: "Rejected", actionable: false };
    default:
      return { label: "Open", actionable: false };
  }
}

// ── Representative thumbnail ───────────────────────────────────────────────────────────────────────
export type ThumbOrigin = "asset" | "generation" | "source";
export interface ThumbPick {
  path: string;
  /** A generated placeholder (NOT a real Zoe photo) — the card must label it as such. */
  placeholder: boolean;
  origin: ThumbOrigin;
}

/** Pick ONE image to represent a job in the grid, cheapest-meaningful first:
 *  1) the saved/approved asset, 2) the latest generation that produced pixels, 3) the source photo
 *  (reference-first jobs that have not generated yet). Returns null when there is nothing real to show —
 *  the frame then renders an honest "no preview" fallback. Never invents an image. */
export function selectThumb(
  job: Pick<CreativeJob, "approvedAssetPath" | "approvedGenerationId">,
  generations: Generation[],
  sourceImage: Pick<CreativeImage, "path" | "placeholder"> | null,
): ThumbPick | null {
  if (job.approvedAssetPath) {
    const g = job.approvedGenerationId ? generations.find((x) => x.id === job.approvedGenerationId) : undefined;
    return { path: job.approvedAssetPath, placeholder: g?.placeholder ?? false, origin: "asset" };
  }
  const withPixels = generations
    .filter((g) => !!g.resultPath)
    .sort((a, b) => b.attempt - a.attempt)[0];
  if (withPixels?.resultPath) {
    return { path: withPixels.resultPath, placeholder: withPixels.placeholder, origin: "generation" };
  }
  if (sourceImage?.path) {
    return { path: sourceImage.path, placeholder: sourceImage.placeholder, origin: "source" };
  }
  return null;
}

// ── Filter / search / sort (supported fields only; URL-persisted in the page) ─────────────────────────
export const JOB_SORTS = ["updated", "title", "status", "gens"] as const;
export type JobSort = (typeof JOB_SORTS)[number];
export const JOB_SORT_LABEL: Record<JobSort, string> = {
  updated: "Last updated",
  title: "Title",
  status: "Lifecycle stage",
  gens: "Generations",
};

export interface JobFilter {
  q: string;
  status: JobStatus | "all";
  type: string; // AssetType | "all"
  campaign: string; // exact campaign | "all"
  sort: JobSort;
  dir: "asc" | "desc";
}

export const DEFAULT_JOB_FILTER: JobFilter = { q: "", status: "all", type: "all", campaign: "all", sort: "updated", dir: "desc" };

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();

/** Normalise raw URL query params into a validated filter (unknown values fall back to the default). */
export function parseJobFilter(sp: Record<string, string | string[] | undefined>): JobFilter {
  const status = one(sp.status);
  const sort = one(sp.sort) as JobSort;
  const dir = one(sp.dir);
  return {
    q: one(sp.q),
    status: (JOB_STATUS_ORDER as string[]).includes(status) || status === "rejected" ? (status as JobStatus) : "all",
    type: one(sp.type) || "all",
    campaign: one(sp.campaign) || "all",
    sort: (JOB_SORTS as readonly string[]).includes(sort) ? sort : "updated",
    dir: dir === "asc" ? "asc" : "desc",
  };
}

const matchesQuery = (job: CreativeJob, q: string): boolean => {
  if (!q) return true;
  const hay = [job.title, job.campaign, job.page, job.section, job.product].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q.toLowerCase());
};

/** Apply the filter + sort to a job set. Pure and total — only supported fields are honoured. */
export function filterJobs(jobs: CreativeJob[], f: JobFilter): CreativeJob[] {
  const filtered = jobs.filter(
    (j) =>
      (f.status === "all" || j.status === f.status) &&
      (f.type === "all" || j.assetType === f.type) &&
      (f.campaign === "all" || (j.campaign ?? "") === f.campaign) &&
      matchesQuery(j, f.q),
  );
  const sign = f.dir === "asc" ? 1 : -1;
  const cmp = (a: CreativeJob, b: CreativeJob): number => {
    switch (f.sort) {
      case "title":
        return sign * a.title.localeCompare(b.title);
      case "status":
        return sign * (JOB_STATUS_ORDER.indexOf(a.status) - JOB_STATUS_ORDER.indexOf(b.status));
      case "gens":
        return sign * (a.generationCount - b.generationCount);
      case "updated":
      default:
        return sign * (Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    }
  };
  return [...filtered].sort(cmp);
}

/** Distinct, non-empty campaign names across the set (for the campaign filter), alphabetical. */
export function campaignOptions(jobs: CreativeJob[]): string[] {
  return [...new Set(jobs.map((j) => j.campaign).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b));
}

// ── Lifecycle phase roll-up (the summary tiles) ──────────────────────────────────────────────────────
export type JobPhase = "in_progress" | "awaiting_review" | "approved" | "published" | "rejected";

export function jobPhase(status: JobStatus): JobPhase {
  switch (status) {
    case "awaiting_approval":
      return "awaiting_review";
    case "approved":
      return "approved";
    case "published":
      return "published";
    case "rejected":
      return "rejected";
    default:
      return "in_progress"; // draft | queued | generating | qa | needs_revision
  }
}

export interface PhaseCounts {
  total: number;
  in_progress: number;
  awaiting_review: number;
  approved: number;
  published: number;
  rejected: number;
}

export function phaseCounts(jobs: CreativeJob[]): PhaseCounts {
  const c: PhaseCounts = { total: jobs.length, in_progress: 0, awaiting_review: 0, approved: 0, published: 0, rejected: 0 };
  for (const j of jobs) c[jobPhase(j.status)] += 1;
  return c;
}

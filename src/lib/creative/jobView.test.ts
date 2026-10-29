// Unit tests for the pure Creative jobs view logic (no DB): status→tone mapping, the single next valid
// action, representative-thumbnail selection, URL-filter parsing, and the filter/sort/roll-up helpers.

import { describe, it, expect } from "vitest";
import type { CreativeJob, Generation, JobStatus } from "./types";
import {
  JOB_STATUS_TONE,
  nextAction,
  selectThumb,
  parseJobFilter,
  filterJobs,
  campaignOptions,
  phaseCounts,
  jobPhase,
  DEFAULT_JOB_FILTER,
} from "./jobView";

function mkJob(p: Partial<CreativeJob>): CreativeJob {
  return {
    id: p.id ?? "CJ-1",
    title: p.title ?? "Asset",
    campaign: p.campaign ?? null,
    page: p.page ?? null,
    section: p.section ?? null,
    assetType: p.assetType ?? "lifestyle",
    product: p.product ?? null,
    productCategory: null,
    sourceMode: p.sourceMode ?? "scratch",
    sourceImageId: p.sourceImageId ?? null,
    referenceImageIds: [],
    aspectRatio: p.aspectRatio ?? "3:2",
    targetAudience: null,
    objective: null,
    season: null,
    locationContext: null,
    visualDirection: null,
    preserve: [],
    transform: [],
    status: p.status ?? "draft",
    selectedModel: null,
    generationCount: p.generationCount ?? 0,
    qaScore: p.qaScore ?? null,
    imageBrief: null,
    approvedGenerationId: p.approvedGenerationId ?? null,
    approvedAssetPath: p.approvedAssetPath ?? null,
    createdBy: null,
    createdAt: p.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: p.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function mkGen(p: Partial<Generation>): Generation {
  return {
    id: p.id ?? "CG-1",
    jobId: p.jobId ?? "CJ-1",
    attempt: p.attempt ?? 1,
    provider: p.provider ?? "mock",
    model: p.model ?? null,
    briefSnapshot: null,
    imageId: p.imageId ?? null,
    resultPath: p.resultPath ?? null,
    placeholder: p.placeholder ?? false,
    resultMeta: null,
    qaScore: null,
    qaReport: null,
    status: p.status ?? "generating",
    externalRef: null,
    createdAt: p.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("JOB_STATUS_TONE", () => {
  it("keeps approval and publication distinct but both positive", () => {
    expect(JOB_STATUS_TONE.approved).toBe("positive");
    expect(JOB_STATUS_TONE.published).toBe("positive");
  });
  it("maps the failure/blocked states to attention/critical", () => {
    expect(JOB_STATUS_TONE.needs_revision).toBe("attention");
    expect(JOB_STATUS_TONE.awaiting_approval).toBe("attention");
    expect(JOB_STATUS_TONE.rejected).toBe("critical");
  });
  it("maps the active pipeline to info", () => {
    for (const s of ["queued", "generating", "qa"] as JobStatus[]) expect(JOB_STATUS_TONE[s]).toBe("info");
  });
});

describe("nextAction", () => {
  it("offers Generate for a fresh queued job and Regenerate once it has generated", () => {
    expect(nextAction({ status: "queued", generationCount: 0 })).toEqual({ label: "Generate", actionable: true });
    expect(nextAction({ status: "queued", generationCount: 2 }).label).toBe("Regenerate");
  });
  it("is non-actionable while the pipeline is running", () => {
    expect(nextAction({ status: "generating", generationCount: 1 }).actionable).toBe(false);
    expect(nextAction({ status: "qa", generationCount: 1 }).actionable).toBe(false);
  });
  it("routes review → approve → save → view", () => {
    expect(nextAction({ status: "awaiting_approval", generationCount: 1 }).label).toBe("Review & approve");
    expect(nextAction({ status: "approved", generationCount: 1 }).label).toBe("Save asset");
    expect(nextAction({ status: "published", generationCount: 1 }).label).toBe("View saved asset");
  });
});

describe("selectThumb", () => {
  it("prefers the saved/approved asset and carries the approved generation's placeholder flag", () => {
    const job = mkJob({ approvedAssetPath: "/api/creative/image/A", approvedGenerationId: "CG-9" });
    const gens = [mkGen({ id: "CG-9", attempt: 2, resultPath: "/api/creative/image/A", placeholder: true })];
    expect(selectThumb(job, gens, null)).toEqual({ path: "/api/creative/image/A", placeholder: true, origin: "asset" });
  });
  it("falls back to the latest generation that produced pixels (regardless of input order)", () => {
    const job = mkJob({});
    const gens = [
      mkGen({ id: "CG-1", attempt: 1, resultPath: "/img/1" }),
      mkGen({ id: "CG-3", attempt: 3, resultPath: "/img/3" }),
      mkGen({ id: "CG-2", attempt: 2, resultPath: null }),
    ];
    expect(selectThumb(job, gens, null)).toEqual({ path: "/img/3", placeholder: false, origin: "generation" });
  });
  it("falls back to the source photo, then to null", () => {
    const job = mkJob({ sourceMode: "upload", sourceImageId: "CI-1" });
    expect(selectThumb(job, [], { path: "/img/src", placeholder: false })).toEqual({ path: "/img/src", placeholder: false, origin: "source" });
    expect(selectThumb(mkJob({}), [], null)).toBeNull();
  });
});

describe("parseJobFilter", () => {
  it("defaults unknown/absent params", () => {
    expect(parseJobFilter({})).toEqual(DEFAULT_JOB_FILTER);
    expect(parseJobFilter({ sort: "nope", status: "bogus", dir: "sideways" })).toEqual(DEFAULT_JOB_FILTER);
  });
  it("accepts the terminal 'rejected' status (not in JOB_STATUS_ORDER) and a valid sort/dir", () => {
    const f = parseJobFilter({ status: "rejected", sort: "title", dir: "asc", q: " hero " });
    expect(f.status).toBe("rejected");
    expect(f.sort).toBe("title");
    expect(f.dir).toBe("asc");
    expect(f.q).toBe("hero");
  });
});

describe("filterJobs", () => {
  const jobs = [
    mkJob({ id: "a", title: "Hero banner", status: "published", assetType: "hero", campaign: "Spring", generationCount: 3, updatedAt: "2026-02-01T00:00:00Z" }),
    mkJob({ id: "b", title: "Chair detail", status: "awaiting_approval", assetType: "detail", campaign: "Spring", generationCount: 1, updatedAt: "2026-03-01T00:00:00Z" }),
    mkJob({ id: "c", title: "Lounge lifestyle", status: "draft", assetType: "lifestyle", campaign: null, generationCount: 0, updatedAt: "2026-01-01T00:00:00Z" }),
  ];
  it("filters by status, type, campaign and free-text query", () => {
    expect(filterJobs(jobs, { ...DEFAULT_JOB_FILTER, status: "published" }).map((j) => j.id)).toEqual(["a"]);
    expect(filterJobs(jobs, { ...DEFAULT_JOB_FILTER, type: "detail" }).map((j) => j.id)).toEqual(["b"]);
    expect(filterJobs(jobs, { ...DEFAULT_JOB_FILTER, campaign: "Spring" }).map((j) => j.id).sort()).toEqual(["a", "b"]);
    expect(filterJobs(jobs, { ...DEFAULT_JOB_FILTER, q: "lounge" }).map((j) => j.id)).toEqual(["c"]);
  });
  it("sorts by updated desc by default and honours dir + other fields", () => {
    expect(filterJobs(jobs, DEFAULT_JOB_FILTER).map((j) => j.id)).toEqual(["b", "a", "c"]);
    expect(filterJobs(jobs, { ...DEFAULT_JOB_FILTER, sort: "title", dir: "asc" }).map((j) => j.id)).toEqual(["b", "a", "c"]);
    expect(filterJobs(jobs, { ...DEFAULT_JOB_FILTER, sort: "gens", dir: "desc" }).map((j) => j.id)).toEqual(["a", "b", "c"]);
  });
});

describe("roll-ups", () => {
  it("lists distinct campaigns alphabetically", () => {
    const jobs = [mkJob({ campaign: "Summer" }), mkJob({ campaign: "Autumn" }), mkJob({ campaign: "Summer" }), mkJob({ campaign: null })];
    expect(campaignOptions(jobs)).toEqual(["Autumn", "Summer"]);
  });
  it("classifies phases with approved separate from published", () => {
    expect(jobPhase("approved")).toBe("approved");
    expect(jobPhase("published")).toBe("published");
    expect(jobPhase("generating")).toBe("in_progress");
    const c = phaseCounts([mkJob({ status: "approved" }), mkJob({ status: "published" }), mkJob({ status: "draft" })]);
    expect(c).toMatchObject({ total: 3, approved: 1, published: 1, in_progress: 1 });
  });
});

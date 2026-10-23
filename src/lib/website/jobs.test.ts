import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import {
  createJob,
  claimNextPending,
  setJobPreview,
  addJobArtifact,
  decideJob,
  completeJob,
  failJob,
  getJob,
  listJobs,
} from "./jobs";

// DATABASE_PATH is ":memory:" (vitest.config.ts); vitest.setup.ts clears tables once per FILE, so clear
// website_jobs before each test too for a clean, isolated state machine per case.
beforeEach(() => {
  getDb().prepare("DELETE FROM website_jobs").run();
});

/** Drive a fresh job to the `preview` state (createJob → claim → setJobPreview). */
function toPreview(prompt = "add a testimonials section"): string {
  const job = createJob({ prompt })!;
  claimNextPending();
  setJobPreview(job.id, { summary: "Added a testimonials section.", changedFiles: ["themes/zoe/home.php"], pagePaths: ["/"] });
  return job.id;
}

describe("website_jobs state machine", () => {
  it("createJob queues a pending job; empty prompt is rejected", () => {
    const job = createJob({ prompt: "Make the hero headline say Fall Sale", requester: "Marcy (Marketing)" });
    expect(job).not.toBeNull();
    expect(job!.id).toMatch(/^WJ-/);
    expect(job!.status).toBe("pending");
    expect(job!.prompt).toBe("Make the hero headline say Fall Sale");
    expect(job!.requester).toBe("Marcy (Marketing)");
    expect(job!.summary).toBeNull();
    expect(job!.changedFiles).toEqual([]);
    expect(job!.pagePaths).toEqual([]);
    expect(job!.artifacts).toEqual([]);
    expect(job!.prUrl).toBeNull();
    expect(job!.startedAt).toBeNull();

    expect(createJob({ prompt: "   " })).toBeNull();
    expect(createJob({ prompt: "" })).toBeNull();
  });

  it("claimNextPending flips exactly one pending job to running (FIFO) and assigns it only once", () => {
    const a = createJob({ prompt: "first" })!;
    const b = createJob({ prompt: "second" })!;

    const claimed1 = claimNextPending();
    expect(claimed1!.id).toBe(a.id); // oldest first
    expect(claimed1!.status).toBe("running");
    expect(claimed1!.startedAt).not.toBeNull();

    const claimed2 = claimNextPending();
    expect(claimed2!.id).toBe(b.id);

    // Nothing pending left → null (single-assignment: the two running jobs are not re-handed out).
    expect(claimNextPending()).toBeNull();
  });

  it("setJobPreview moves running → preview with summary, changed files, and page paths", () => {
    const job = createJob({ prompt: "add a banner" })!;
    expect(setJobPreview(job.id, { summary: "x" })).toBeNull(); // not claimed yet
    claimNextPending();

    const preview = setJobPreview(job.id, {
      summary: "Added a promo banner to the homepage.",
      changedFiles: ["themes/zoe/header.php", "themes/zoe/style.css"],
      pagePaths: ["/", "/about"],
    });
    expect(preview).not.toBeNull();
    expect(preview!.status).toBe("preview");
    expect(preview!.summary).toBe("Added a promo banner to the homepage.");
    expect(preview!.changedFiles).toEqual(["themes/zoe/header.php", "themes/zoe/style.css"]);
    expect(preview!.pagePaths).toEqual(["/", "/about"]);
  });

  it("addJobArtifact appends screenshot refs and replaces by label; only in running/preview", () => {
    const id = toPreview();
    let job = addJobArtifact(id, { label: "home-desktop", path: "home-desktop.png" })!;
    job = addJobArtifact(id, { label: "home-mobile", path: "home-mobile.png" })!;
    expect(job.artifacts.map((a) => a.label)).toEqual(["home-desktop", "home-mobile"]);

    // Same label replaces, not duplicates.
    job = addJobArtifact(id, { label: "home-desktop", path: "home-desktop-v2.png" })!;
    expect(job.artifacts.filter((a) => a.label === "home-desktop")).toHaveLength(1);
    expect(job.artifacts.find((a) => a.label === "home-desktop")!.path).toBe("home-desktop-v2.png");

    // Empty label/path rejected.
    expect(addJobArtifact(id, { label: "", path: "x.png" })).toBeNull();
  });

  it("decideJob approves a preview job (preview → approved), recording the actor", () => {
    const id = toPreview();
    const approved = decideJob(id, "approve", "Dana (Owner)");
    expect(approved!.status).toBe("approved");
    expect(approved!.decidedBy).toBe("Dana (Owner)");
    expect(approved!.decidedAt).not.toBeNull();

    // Re-deciding an already-decided job is a no-op.
    expect(decideJob(id, "discard", "Someone")).toBeNull();
  });

  it("decideJob discards a preview job (preview → discarded)", () => {
    const id = toPreview();
    const discarded = decideJob(id, "discard", "Dana");
    expect(discarded!.status).toBe("discarded");
  });

  it("completeJob moves approved → done with the PR url", () => {
    const id = toPreview();
    decideJob(id, "approve", "Dana");
    const done = completeJob(id, { prUrl: "https://github.com/zoe/website/pull/42" });
    expect(done!.status).toBe("done");
    expect(done!.prUrl).toBe("https://github.com/zoe/website/pull/42");

    // Terminal → no further transitions.
    expect(completeJob(id, { prUrl: "x" })).toBeNull();
    expect(failJob(id, "x")).toBeNull();
  });

  it("cannot complete a job that was only previewed (never approved)", () => {
    const id = toPreview();
    expect(completeJob(id, { prUrl: "x" })).toBeNull();
    expect(getJob(id)!.status).toBe("preview");
  });

  it("failJob works from running and from approved, but not from preview", () => {
    // running → failed (agent/render failure)
    const a = createJob({ prompt: "a" })!;
    claimNextPending();
    expect(failJob(a.id, "agent could not resolve the request")!.status).toBe("failed");

    // preview → failed is NOT allowed (a human decides on a preview; it doesn't fail there)
    const b = toPreview("b");
    expect(failJob(b, "nope")).toBeNull();
    expect(getJob(b)!.status).toBe("preview");

    // approved → failed (push/PR failure)
    decideJob(b, "approve", "Dana");
    expect(failJob(b, "gh pr create failed")!.status).toBe("failed");
  });

  it("listJobs returns newest first and filters by requester", () => {
    createJob({ prompt: "p1", requester: "Alice" });
    createJob({ prompt: "p2", requester: "Bob" });
    createJob({ prompt: "p3", requester: "Alice" });

    const all = listJobs();
    expect(all.length).toBe(3);
    expect(all[0].prompt).toBe("p3"); // newest first

    const alice = listJobs({ requester: "Alice" });
    expect(alice.map((j) => j.prompt)).toEqual(["p3", "p1"]);

    expect(listJobs({ requester: "Nobody" })).toEqual([]);
  });

  it("getJob returns null for a missing id", () => {
    expect(getJob("WJ-nope")).toBeNull();
  });
});

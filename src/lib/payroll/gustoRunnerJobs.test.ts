import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import {
  createJob,
  claimNextQueued,
  reportProgress,
  completeJob,
  failJob,
  cancelJob,
  getJob,
  latestJob,
  hasActiveJob,
  listJobs,
  type GustoPushEntry,
} from "./gustoRunnerJobs";

// The setup clears tables per FILE, not per test — isolate each case so FIFO/latest/active assertions hold.
beforeEach(() => {
  getDb().prepare("DELETE FROM gusto_push_jobs").run();
});

const entry = (id: string, reg = 40, ot = 0): GustoPushEntry => ({
  gustoMemberId: id,
  name: `Worker ${id}`,
  regularHours: reg,
  overtimeHours: ot,
  doubleOvertimeHours: 0,
});

describe("gustoRunnerJobs state machine", () => {
  it("creates a queued job carrying the approved entries + period", () => {
    const job = createJob({
      which: "current",
      entries: [entry("M1"), entry("M2", 45, 5)],
      period: { start: "2026-10-20", end: "2026-10-26", label: "Oct 20–26" },
      requester: "Lisa",
    });
    expect(job).not.toBeNull();
    expect(job!.status).toBe("queued");
    expect(job!.entries).toHaveLength(2);
    expect(job!.entries[1]).toMatchObject({ gustoMemberId: "M2", regularHours: 45, overtimeHours: 5 });
    expect(job!.periodLabel).toBe("Oct 20–26");
    expect(job!.requester).toBe("Lisa");
  });

  it("refuses to create a job with no entries", () => {
    expect(createJob({ which: "current", entries: [] })).toBeNull();
  });

  it("claims exactly once (single-assignment)", () => {
    const made = createJob({ which: "current", entries: [entry("A")] })!;
    const first = claimNextQueued();
    expect(first?.id).toBe(made.id);
    expect(first?.status).toBe("claimed");
    // Nothing else queued → a second claim returns null (never re-claims the same job).
    expect(claimNextQueued()).toBeNull();
  });

  it("claims FIFO across multiple queued jobs", () => {
    const a = createJob({ which: "current", entries: [entry("A")] })!;
    const b = createJob({ which: "current", entries: [entry("B")] })!;
    expect(claimNextQueued()?.id).toBe(a.id);
    expect(claimNextQueued()?.id).toBe(b.id);
  });

  it("reports progress through signin_required → pushing, COALESCE-merging fields", () => {
    const made = createJob({ which: "current", entries: [entry("A")] })!;
    claimNextQueued();
    const signin = reportProgress(made.id, { status: "signin_required", phase: "Waiting for Gusto sign-in" });
    expect(signin?.status).toBe("signin_required");
    expect(signin?.phase).toBe("Waiting for Gusto sign-in");

    // A bare screenshot tick must NOT wipe the phase (COALESCE), and keeps the status.
    const frame = reportProgress(made.id, { screenshot: "live.png" });
    expect(frame?.status).toBe("signin_required");
    expect(frame?.phase).toBe("Waiting for Gusto sign-in");
    expect(frame?.screenshot).toBe("live.png");

    const pushing = reportProgress(made.id, { status: "pushing", phase: "Writing hours", draftPayrollId: "DP-1" });
    expect(pushing?.status).toBe("pushing");
    expect(pushing?.draftPayrollId).toBe("DP-1");
  });

  it("completes an active job to done with final results + session mode", () => {
    const made = createJob({ which: "current", entries: [entry("A"), entry("B")] })!;
    claimNextQueued();
    reportProgress(made.id, { status: "pushing" });
    const done = completeJob(made.id, {
      workers: [
        { gustoMemberId: "A", name: "A", outcome: "pushed", regularHours: 40, overtimeHours: 0, reason: null },
        { gustoMemberId: "B", name: "B", outcome: "skipped", regularHours: 0, overtimeHours: 0, reason: "already set (idempotent)" },
      ],
      sessionMode: "generated",
      draftPayrollId: "DP-9",
    });
    expect(done?.status).toBe("done");
    expect(done?.sessionMode).toBe("generated");
    expect(done?.workers).toHaveLength(2);
    expect(done?.finishedAt).toBeTruthy();
    // Terminal: no further progress/complete is accepted.
    expect(reportProgress(made.id, { status: "pushing" })).toBeNull();
    expect(completeJob(made.id, {})).toBeNull();
  });

  it("records a clean abort reason on done without writing", () => {
    const made = createJob({ which: "current", entries: [entry("A")] })!;
    claimNextQueued();
    const done = completeJob(made.id, { aborted: "not_logged_in" });
    expect(done?.status).toBe("done");
    expect(done?.aborted).toBe("not_logged_in");
  });

  it("fails an active job", () => {
    const made = createJob({ which: "current", entries: [entry("A")] })!;
    claimNextQueued();
    const failed = failJob(made.id, "boom");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("boom");
    expect(failJob(made.id, "again")).toBeNull(); // terminal
  });

  it("cancels from queued and from an active state, but not once terminal", () => {
    const q = createJob({ which: "current", entries: [entry("A")] })!;
    const canceledQueued = cancelJob(q.id, "HG");
    expect(canceledQueued?.status).toBe("canceled");
    expect(canceledQueued?.canceledBy).toBe("HG");

    const a = createJob({ which: "current", entries: [entry("B")] })!;
    claimNextQueued(); // claims q? no — q is canceled, so this claims a
    const canceledActive = cancelJob(a.id, "HG");
    expect(canceledActive?.status).toBe("canceled");

    // A done job can't be canceled.
    const d = createJob({ which: "current", entries: [entry("C")] })!;
    claimNextQueued();
    completeJob(d.id, {});
    expect(cancelJob(d.id)).toBeNull();
  });

  it("tracks latest / active / list", () => {
    expect(hasActiveJob()).toBe(false);
    const a = createJob({ which: "current", entries: [entry("A")] })!;
    expect(hasActiveJob()).toBe(true); // queued counts as active
    expect(latestJob()?.id).toBe(a.id);
    completeJob(claimNextQueued()!.id, {});
    expect(hasActiveJob()).toBe(false);
    const b = createJob({ which: "previous", entries: [entry("B")] })!;
    expect(latestJob()?.id).toBe(b.id);
    expect(listJobs(10).map((j) => j.id)).toContain(a.id);
    expect(getJob(a.id)?.status).toBe("done");
  });
});

import { describe, expect, it } from "vitest";
import { createRun, getRun, transitionRun, updateRunMetrics, setRunArtifacts, setRunDeploy, setRunHealth, listRunEvents, listActiveRuns, countRunsByState } from "./store";
import { DEFAULT_BUDGET } from "./budget";
import type { RunScope } from "./types";

const scope: RunScope = {
  blade: "scheduling",
  summary: "capture route changes after schedules",
  problem: "route changes after schedules aren't caught",
  allowedPaths: ["src/lib/scheduling/"],
  forbiddenPaths: [],
};

describe("improvement run store", () => {
  it("opens a run in 'requested' with an initial event + audit", () => {
    const r = createRun({ scope, budget: DEFAULT_BUDGET, startedBy: "Hermann", requestId: "REQ-1" });
    expect(r.id).toMatch(/^IR-/);
    expect(r.state).toBe("requested");
    expect(r.blade).toBe("scheduling");
    expect(r.requestId).toBe("REQ-1");
    const events = listRunEvents(r.id);
    expect(events.length).toBe(1);
    expect(events[0].to).toBe("requested");
  });

  it("allows a legal transition and REFUSES an illegal one", () => {
    const r = createRun({ scope, budget: DEFAULT_BUDGET });
    const ok = transitionRun(r.id, "investigating", { actor: "controller" });
    expect(ok.ok).toBe(true);
    expect(ok.run?.state).toBe("investigating");

    const bad = transitionRun(r.id, "merged"); // illegal skip
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("illegal transition");
    expect(getRun(r.id)?.state).toBe("investigating"); // unchanged
  });

  it("stamps ended_at on a terminal state and records the trail", () => {
    const r = createRun({ scope, budget: DEFAULT_BUDGET });
    for (const s of ["investigating", "planned", "coding", "validating", "pr_created", "ci_running", "ready_to_merge", "merged", "deploying", "deployed", "verifying", "verified"] as const) {
      const res = transitionRun(r.id, s);
      expect(res.ok).toBe(true);
    }
    const done = getRun(r.id)!;
    expect(done.state).toBe("verified");
    expect(done.endedAt).toBeTruthy();
    // full trail: requested + 12 transitions = 13 events
    expect(listRunEvents(r.id).length).toBe(13);
  });

  it("tracks metrics, artifacts, deploy, and health without changing state", () => {
    const r = createRun({ scope, budget: DEFAULT_BUDGET });
    transitionRun(r.id, "investigating");
    updateRunMetrics(r.id, { files: 3, lines: 120, commands: 12 });
    setRunArtifacts(r.id, { branch: "feat/x", commit: "abc123", prUrl: "https://github.com/o/r/pull/9", prNumber: 9, plan: "do X" });
    setRunDeploy(r.id, { provider: "fly", deployId: "v42", previousId: "v41", status: "complete" });
    setRunHealth(r.id, { healthy: true, checkedAt: new Date().toISOString(), detail: "200 OK", failures: [] });
    const g = getRun(r.id)!;
    expect(g.state).toBe("investigating"); // unchanged by setters
    expect(g.metrics.files).toBe(3);
    expect(g.metrics.lines).toBe(120);
    expect(g.branch).toBe("feat/x");
    expect(g.prNumber).toBe(9);
    expect(g.deploy?.previousId).toBe("v41");
    expect(g.health?.healthy).toBe(true);
  });

  it("escalates a scope breach to human review and lists it as active", () => {
    const r = createRun({ scope, budget: DEFAULT_BUDGET });
    transitionRun(r.id, "investigating");
    const tripped = transitionRun(r.id, "scope_exceeded", { note: "touched src/lib/auth" });
    expect(tripped.ok).toBe(true);
    const esc = transitionRun(r.id, "human_review_required", { note: "needs owner" });
    expect(esc.ok).toBe(true);
    expect(listActiveRuns().some((x) => x.id === r.id)).toBe(true); // not terminal
    expect(countRunsByState().human_review_required).toBeGreaterThanOrEqual(1);
  });
});

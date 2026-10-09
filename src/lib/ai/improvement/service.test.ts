import { describe, expect, it } from "vitest";
import { openImprovementRun, advance, enforceScope, enforceBudget, reportValidation, reportCi, retryRepair, recordMerge, mayAutoMerge } from "./service";
import { getRun, updateRunMetrics } from "./store";
import type { RunScope, RunState } from "./types";

const scope: RunScope = {
  blade: "scheduling",
  summary: "capture route changes",
  problem: "route changes after schedules aren't caught",
  allowedPaths: ["src/lib/scheduling/", "src/components/scheduling/"],
  forbiddenPaths: [],
};

// Drive a fresh run to a target state through legal transitions.
function runAt(state: RunState): string {
  const r = openImprovementRun({ scope });
  const path: RunState[] = ["investigating", "planned", "coding", "validating", "pr_created", "ci_running", "ready_to_merge", "merged"];
  for (const s of path) {
    if (getRun(r.id)!.state === state) break;
    advance(r.id, s, { actor: "ai" });
    if (s === state) break;
  }
  return r.id;
}

describe("controller service — enforcement", () => {
  it("scope gate stops a run that touches out-of-scope or forbidden paths", () => {
    const id = runAt("coding");
    const ok = enforceScope(id, ["src/lib/scheduling/optimize.ts"]);
    expect(ok.ok).toBe(true);

    const bad = enforceScope(id, ["src/lib/scheduling/ok.ts", "src/lib/auth/roles.ts"]); // auth = always forbidden
    expect(bad.ok).toBe(false);
    expect(bad.tripped).toBe("scope_exceeded");
    expect(getRun(id)!.state).toBe("scope_exceeded");
  });

  it("budget gate stops a run that exceeds a limit", () => {
    const id = runAt("coding");
    expect(enforceBudget(id, { files: 2, lines: 50 }).ok).toBe(true);
    const over = enforceBudget(id, { lines: 999999 });
    expect(over.ok).toBe(false);
    expect(over.tripped).toBe("scope_exceeded");
    expect(getRun(id)!.state).toBe("scope_exceeded");
  });

  it("validation pass advances; failure holds, and an exhausted retry budget escalates", () => {
    const pass = runAt("validating");
    expect(reportValidation(pass, true).run?.state).toBe("pr_created");

    const fail = runAt("validating");
    expect(reportValidation(fail, false).ok).toBe(true);
    expect(getRun(fail)!.state).toBe("validation_failed");

    const spent = runAt("validating");
    updateRunMetrics(spent, { retries: 3 }); // == maxRetries default
    reportValidation(spent, false);
    expect(getRun(spent)!.state).toBe("human_review_required");
  });

  it("CI failure routes to ci_failed, bounded self-repair returns to coding, then escalates when spent", () => {
    const id = runAt("ci_running");
    expect(reportCi(id, false).ok).toBe(true);
    expect(getRun(id)!.state).toBe("ci_failed");
    expect(retryRepair(id).run?.state).toBe("coding"); // retries -> 1

    const driveToCiFailed = () => {
      advance(id, "validating"); advance(id, "pr_created"); advance(id, "ci_running"); reportCi(id, false);
    };
    driveToCiFailed(); // ci_failed (retries still 1)
    retryRepair(id); // retries -> 2, coding
    driveToCiFailed(); // ci_failed
    retryRepair(id); // retries -> 3, coding
    driveToCiFailed(); // reportCi sees retries==3 (exhausted) and escalates
    expect(getRun(id)!.state).toBe("human_review_required");
  });

  it("merge is only legal from ready_to_merge; auto-merge is off by default", () => {
    const notReady = runAt("coding");
    expect(recordMerge(notReady).ok).toBe(false); // illegal from coding

    const ready = runAt("ready_to_merge");
    expect(mayAutoMerge(getRun(ready)!)).toBe(false); // autoMerge default off
    expect(recordMerge(ready, { actor: "Hermann", commit: "abc123" }).run?.state).toBe("merged");
  });
});

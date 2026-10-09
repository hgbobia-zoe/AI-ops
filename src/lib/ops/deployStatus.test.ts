import { describe, expect, it } from "vitest";
import { derivePhase, looseCommitMatch, type LastDeployRun } from "./deployStatus";

const run = (over: Partial<LastDeployRun>): LastDeployRun => ({
  status: "completed",
  conclusion: "success",
  headSha: "abc123",
  createdAt: "2026-10-09T00:00:00Z",
  htmlUrl: "https://github.com/x/y/actions/runs/1",
  ...over,
});

describe("derivePhase", () => {
  it("in-progress run → deploying (even when main is ahead)", () => {
    expect(derivePhase({ lastDeploy: run({ status: "in_progress", conclusion: null }), upToDate: false })).toBe("deploying");
  });

  it("queued run → deploying", () => {
    expect(derivePhase({ lastDeploy: run({ status: "queued", conclusion: null }), upToDate: true })).toBe("deploying");
  });

  it("up to date + last run success → deployed", () => {
    expect(derivePhase({ lastDeploy: run({ status: "completed", conclusion: "success" }), upToDate: true })).toBe("deployed");
  });

  it("main ahead of live, no run in flight → behind", () => {
    expect(derivePhase({ lastDeploy: run({ status: "completed", conclusion: "success" }), upToDate: false })).toBe("behind");
  });

  it("last run failed → failed", () => {
    expect(derivePhase({ lastDeploy: run({ status: "completed", conclusion: "failure" }), upToDate: true })).toBe("failed");
  });

  it("a failed run takes precedence over a behind state", () => {
    expect(derivePhase({ lastDeploy: run({ status: "completed", conclusion: "failure" }), upToDate: false })).toBe("failed");
  });

  it("missing run data + unknown match → unknown", () => {
    expect(derivePhase({ lastDeploy: null, upToDate: null })).toBe("unknown");
  });

  it("up to date but no run data → still deployed (we know we're current)", () => {
    expect(derivePhase({ lastDeploy: null, upToDate: true })).toBe("deployed");
  });

  it("behind with no run data → behind", () => {
    expect(derivePhase({ lastDeploy: null, upToDate: false })).toBe("behind");
  });

  it("completed non-success/non-failure conclusion (e.g. cancelled), up to date → deployed", () => {
    expect(derivePhase({ lastDeploy: run({ status: "completed", conclusion: "cancelled" }), upToDate: true })).toBe("deployed");
  });
});

describe("looseCommitMatch", () => {
  it("matches short prefix against full sha either direction", () => {
    expect(looseCommitMatch("abc123def456", "abc123")).toBe(true);
    expect(looseCommitMatch("abc123", "abc123def456")).toBe(true);
  });

  it("exact match is true", () => {
    expect(looseCommitMatch("abc123", "abc123")).toBe(true);
  });

  it("different commits are false", () => {
    expect(looseCommitMatch("abc123", "zzz999")).toBe(false);
  });

  it("returns null (unknown) when live is unknown or missing — never a false behind", () => {
    expect(looseCommitMatch("unknown", "abc123")).toBeNull();
    expect(looseCommitMatch("", "abc123")).toBeNull();
    expect(looseCommitMatch(null, "abc123")).toBeNull();
  });

  it("returns null when the latest main commit is missing", () => {
    expect(looseCommitMatch("abc123", null)).toBeNull();
    expect(looseCommitMatch("abc123", "")).toBeNull();
  });
});

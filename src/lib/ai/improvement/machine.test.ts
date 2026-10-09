import { describe, expect, it } from "vitest";
import { canTransition, transition, isTerminal, isFailure, needsHuman, nextOnSuccess, failureTarget } from "./machine";
import { ALL_RUN_STATES, TERMINAL_RUN_STATES } from "./types";

describe("run state machine", () => {
  it("classifies terminal / failure / human states", () => {
    expect(isTerminal("verified")).toBe(true);
    expect(isTerminal("rolled_back")).toBe(true);
    expect(isTerminal("human_review_required")).toBe(true);
    expect(isTerminal("coding")).toBe(false);
    expect(isFailure("ci_failed")).toBe(true);
    expect(isFailure("verified")).toBe(false);
    expect(needsHuman("human_review_required")).toBe(true);
    expect(needsHuman("coding")).toBe(false);
  });

  it("allows the happy path end to end", () => {
    const happy = [
      "requested", "investigating", "planned", "coding", "validating", "pr_created", "ci_running",
      "ready_to_merge", "merged", "deploying", "deployed", "verifying", "verified",
    ] as const;
    for (let i = 0; i < happy.length - 1; i++) {
      expect(canTransition(happy[i], happy[i + 1])).toBe(true);
    }
  });

  it("forbids skipping and backward jumps on the happy path", () => {
    expect(canTransition("requested", "coding")).toBe(false); // skip
    expect(canTransition("merged", "coding")).toBe(false); // backward
    expect(canTransition("verified", "coding")).toBe(false); // from terminal
    expect(canTransition("coding", "coding")).toBe(false); // self
  });

  const HOLD = ["scope_exceeded", "session_failed", "human_review_required"];

  it("permits safety trips from any live (non-hold, non-terminal) state", () => {
    const active = ALL_RUN_STATES.filter((s) => !TERMINAL_RUN_STATES.includes(s) && !HOLD.includes(s));
    for (const s of active) {
      for (const trip of ["session_failed", "scope_exceeded", "human_review_required"] as const) {
        if (s === trip) continue;
        expect(canTransition(s, trip)).toBe(true);
      }
    }
  });

  it("hold states escalate only to a human; terminal states never move", () => {
    expect(canTransition("scope_exceeded", "human_review_required")).toBe(true);
    expect(canTransition("scope_exceeded", "coding")).toBe(false); // can't silently resume
    expect(canTransition("session_failed", "human_review_required")).toBe(true);
    expect(canTransition("session_failed", "scope_exceeded")).toBe(false);
    expect(canTransition("human_review_required", "session_failed")).toBe(false); // no free trip
    expect(canTransition("verified", "human_review_required")).toBe(false); // fully terminal
    expect(canTransition("rolled_back", "coding")).toBe(false);
  });

  it("models bounded self-repair and failure routing", () => {
    expect(canTransition("validating", "validation_failed")).toBe(true);
    expect(canTransition("validation_failed", "coding")).toBe(true); // repair
    expect(canTransition("ci_running", "ci_failed")).toBe(true);
    expect(canTransition("ci_failed", "coding")).toBe(true); // repair
    expect(canTransition("deploying", "deployment_failed")).toBe(true);
    expect(canTransition("deployment_failed", "rollback_required")).toBe(true);
    expect(canTransition("verifying", "health_check_failed")).toBe(true);
    expect(canTransition("health_check_failed", "rollback_required")).toBe(true);
    expect(canTransition("rollback_required", "rolled_back")).toBe(true);
  });

  it("lets a human resume from human_review_required to a sensible state", () => {
    expect(canTransition("human_review_required", "coding")).toBe(true);
    expect(canTransition("human_review_required", "rolled_back")).toBe(true);
    expect(canTransition("human_review_required", "verified")).toBe(false); // can't jump to success
  });

  it("nextOnSuccess / failureTarget pick the right edges", () => {
    expect(nextOnSuccess("validating")).toBe("pr_created");
    expect(failureTarget("validating")).toBe("validation_failed");
    expect(nextOnSuccess("verifying")).toBe("verified");
    expect(failureTarget("verifying")).toBe("health_check_failed");
    expect(nextOnSuccess("verified")).toBeNull();
  });

  it("transition() guards illegal moves", () => {
    expect(transition("coding", "validating")).toEqual({ ok: true, state: "validating" });
    const bad = transition("requested", "merged");
    expect(bad.ok).toBe(false);
  });
});

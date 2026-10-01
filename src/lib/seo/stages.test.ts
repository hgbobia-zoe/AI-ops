import { describe, expect, it } from "vitest";
import { canTransition, nextStages, isStage, STAGE_TRANSITIONS, BOARD_STAGES } from "./stages";
import { SEO_STAGES } from "./types";

describe("stage transition guard", () => {
  it("allows the main-flow transitions", () => {
    expect(canTransition("DISCOVERED", "ANALYZING")).toBe(true);
    expect(canTransition("ANALYZING", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "DRAFTING")).toBe(true);
    expect(canTransition("REVIEW", "APPROVED_FOR_PUBLISHING")).toBe(true);
    expect(canTransition("APPROVED_FOR_PUBLISHING", "PUBLISHED")).toBe(true);
    expect(canTransition("PUBLISHED", "MONITORING")).toBe(true);
  });

  it("rejects illegal skips", () => {
    expect(canTransition("DISCOVERED", "PUBLISHED")).toBe(false);
    expect(canTransition("PUBLISHED", "DISCOVERED")).toBe(false);
    expect(canTransition("REJECTED", "PUBLISHED")).toBe(false);
    expect(canTransition("DISCOVERED", "MONITORING")).toBe(false);
  });

  it("treats a same-stage move as a legal no-op", () => {
    expect(canTransition("APPROVED", "APPROVED")).toBe(true);
  });

  it("allows the decision gate moves from the review stages", () => {
    expect(canTransition("DISCOVERED", "APPROVED")).toBe(true); // approve
    expect(canTransition("ANALYZING", "DEFERRED")).toBe(true); // defer
    expect(canTransition("ANALYZING", "REJECTED")).toBe(true); // reject
  });

  it("allows deferred/blocked to be reopened", () => {
    expect(canTransition("DEFERRED", "ANALYZING")).toBe(true);
    expect(canTransition("BLOCKED", "DRAFTING")).toBe(true);
  });

  it("nextStages excludes the current stage and only returns legal moves", () => {
    const next = nextStages("ANALYZING");
    expect(next).not.toContain("ANALYZING");
    for (const s of next) expect(canTransition("ANALYZING", s)).toBe(true);
  });

  it("has a transition entry and board column for every stage", () => {
    for (const s of SEO_STAGES) {
      expect(STAGE_TRANSITIONS[s]).toBeDefined();
      expect(BOARD_STAGES).toContain(s);
    }
    expect(BOARD_STAGES.length).toBe(SEO_STAGES.length);
  });

  it("isStage validates", () => {
    expect(isStage("DISCOVERED")).toBe(true);
    expect(isStage("nope")).toBe(false);
    expect(isStage(5)).toBe(false);
  });
});

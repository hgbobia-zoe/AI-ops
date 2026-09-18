import { describe, it, expect } from "vitest";
import { autoStage, effectiveStage, isTerminal, stageProgress, type LifecycleFacts } from "./lifecycle";

const facts = (o: Partial<LifecycleFacts> = {}): LifecycleFacts => ({
  hasCoreFields: false, isRelevant: false, hasEntities: false, hasPrimaryTarget: false, hasOutreachDraft: false, ...o,
});

describe("autoStage", () => {
  it("advances as facts accumulate, capped at OUTREACH_READY", () => {
    expect(autoStage(facts())).toBe("DISCOVERED");
    expect(autoStage(facts({ hasCoreFields: true }))).toBe("VALIDATED");
    expect(autoStage(facts({ hasCoreFields: true, isRelevant: true }))).toBe("RELEVANT");
    expect(autoStage(facts({ isRelevant: true, hasEntities: true }))).toBe("RESEARCHING");
    expect(autoStage(facts({ hasEntities: true, hasPrimaryTarget: true }))).toBe("TARGET_IDENTIFIED");
    expect(autoStage(facts({ hasPrimaryTarget: true, hasOutreachDraft: true }))).toBe("OUTREACH_READY");
  });
});

describe("effectiveStage", () => {
  it("keeps a human's forward progress over a lower auto stage", () => {
    expect(effectiveStage("VALIDATED", "CONTACTED")).toBe("CONTACTED");
  });
  it("lets genuine auto progress show past a stale lower manual stage", () => {
    expect(effectiveStage("TARGET_IDENTIFIED", "VALIDATED")).toBe("TARGET_IDENTIFIED");
  });
  it("respects terminal manual stages", () => {
    expect(effectiveStage("OUTREACH_READY", "LOST")).toBe("LOST");
    expect(effectiveStage("OUTREACH_READY", "WON")).toBe("WON");
  });
  it("uses auto when there is no manual override", () => {
    expect(effectiveStage("RELEVANT", null)).toBe("RELEVANT");
  });
});

describe("isTerminal / stageProgress", () => {
  it("marks terminal stages", () => {
    expect(isTerminal("WON")).toBe(true);
    expect(isTerminal("LOST")).toBe(true);
    expect(isTerminal("OUTREACH_READY")).toBe(false);
  });
  it("progress is 1 at WON, 0 at LOST", () => {
    expect(stageProgress("WON")).toBe(1);
    expect(stageProgress("LOST")).toBe(0);
    expect(stageProgress("DISCOVERED")).toBe(0);
  });
});

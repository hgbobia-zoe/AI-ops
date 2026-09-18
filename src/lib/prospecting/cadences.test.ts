import { describe, it, expect } from "vitest";
import { defaultCadenceForTier, getCadence, CADENCE_A, CADENCE_B } from "./cadences";

describe("cadences", () => {
  it("maps tiers to their default cadence (C has none)", () => {
    expect(defaultCadenceForTier("A")).toBe(CADENCE_A);
    expect(defaultCadenceForTier("B")).toBe(CADENCE_B);
    expect(defaultCadenceForTier("C")).toBeNull();
  });
  it("Tier A is call-first and multi-channel", () => {
    expect(CADENCE_A.steps[0].channel).toBe("call");
    const channels = new Set(CADENCE_A.steps.map((s) => s.channel));
    expect(channels.has("call")).toBe(true);
    expect(channels.has("email")).toBe(true);
    expect(channels.has("linkedin")).toBe(true);
  });
  it("Tier B is email-led with at least one call", () => {
    expect(CADENCE_B.steps[0].channel).toBe("email");
    expect(CADENCE_B.steps.some((s) => s.channel === "call")).toBe(true);
  });
  it("steps are in non-decreasing day order", () => {
    for (const cad of [CADENCE_A, CADENCE_B]) {
      for (let i = 1; i < cad.steps.length; i++) expect(cad.steps[i].day).toBeGreaterThanOrEqual(cad.steps[i - 1].day);
    }
  });
  it("getCadence resolves by key", () => {
    expect(getCadence(CADENCE_A.key)).toBe(CADENCE_A);
    expect(getCadence("nope")).toBeNull();
  });
});

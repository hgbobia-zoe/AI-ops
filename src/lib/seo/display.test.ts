// SEO display mappings — the status vocabulary the board, tables, overview and studios all read through. These
// are interaction contracts (a reviewer must SEE "needs review"/"blocked"/"gap" correctly), not cosmetics.

import { describe, it, expect } from "vitest";
import { stageTone, healthTone, findingDisplay, qualityDisplay } from "./display";

describe("stageTone", () => {
  it("marks REVIEW as attention (a human decision is pending)", () => {
    expect(stageTone("REVIEW")).toBe("attention");
  });
  it("marks publish-track stages positive and BLOCKED critical", () => {
    expect(stageTone("APPROVED_FOR_PUBLISHING")).toBe("positive");
    expect(stageTone("PUBLISHED")).toBe("positive");
    expect(stageTone("MONITORING")).toBe("positive");
    expect(stageTone("BLOCKED")).toBe("critical");
  });
  it("marks in-flight work info and off-flow lanes neutral", () => {
    expect(stageTone("DRAFTING")).toBe("info");
    expect(stageTone("DISCOVERED")).toBe("neutral");
    expect(stageTone("DEFERRED")).toBe("neutral");
  });
});

describe("healthTone", () => {
  it("maps ok→positive, stale→attention, never→neutral", () => {
    expect(healthTone("ok")).toBe("positive");
    expect(healthTone("stale")).toBe("attention");
    expect(healthTone("never")).toBe("neutral");
  });
  it("treats a rate-limited error as attention but a hard error as critical", () => {
    expect(healthTone("error", true)).toBe("attention");
    expect(healthTone("error", false)).toBe("critical");
  });
});

describe("findingDisplay", () => {
  it("colours a gap critical, improve attention, defend positive", () => {
    expect(findingDisplay("gap")).toEqual({ tone: "critical", label: "Gap" });
    expect(findingDisplay("improve").tone).toBe("attention");
    expect(findingDisplay("defend").tone).toBe("positive");
    expect(findingDisplay("none").tone).toBe("neutral");
  });
});

describe("qualityDisplay", () => {
  it("errors win over warnings, and pluralises", () => {
    expect(qualityDisplay(2, 3)).toEqual({ tone: "critical", label: "2 errors" });
    expect(qualityDisplay(1, 0)).toEqual({ tone: "critical", label: "1 error" });
    expect(qualityDisplay(0, 1)).toEqual({ tone: "attention", label: "1 warning" });
    expect(qualityDisplay(0, 0)).toEqual({ tone: "positive", label: "Checks passed" });
  });
});

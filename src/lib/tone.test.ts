import { describe, it, expect } from "vitest";
import { type Tone, STATUS_INDICATOR, STATUS_DOT, STATUS_FILL, STATUS_LABEL } from "./tone";

const TONES: Tone[] = ["positive", "attention", "critical", "info", "neutral"];

describe("status tone maps", () => {
  it("every tone has an entry in every map (no missing status styling downstream)", () => {
    for (const map of [STATUS_INDICATOR, STATUS_DOT, STATUS_FILL]) {
      for (const t of TONES) {
        expect(map[t], `missing tone "${t}"`).toBeTruthy();
      }
      expect(Object.keys(map).sort()).toEqual([...TONES].sort());
    }
  });

  it("indicator colour uses the status-indicator palette, never the muted/chart palette", () => {
    // Colour lives on the indicator; it must reference --status-*, not --positive/--critical/etc.
    for (const t of TONES) {
      expect(STATUS_INDICATOR[t]).toMatch(/^text-status-/);
      expect(STATUS_DOT[t]).toMatch(/^bg-status-/);
    }
    expect(STATUS_INDICATOR.positive).toBe("text-status-ready");
    expect(STATUS_INDICATOR.critical).toBe("text-status-blocked");
    expect(STATUS_INDICATOR.attention).toBe("text-status-warning");
    expect(STATUS_INDICATOR.info).toBe("text-status-syncing");
  });

  it("the label colour is theme-driven and is never tinted to the tone", () => {
    expect(STATUS_LABEL).toBe("text-status-label");
    // No tone-specific colour leaks into the label.
    expect(STATUS_LABEL).not.toMatch(/ready|blocked|warning|syncing|positive|critical/);
  });

  it("the filled (exceptional) badge fills with the status colour and a contrasting internal symbol", () => {
    expect(STATUS_FILL.positive).toContain("bg-status-ready");
    expect(STATUS_FILL.positive).toContain("text-status-symbol");
    // Dark-mode blocked red fails the dark symbol's contrast, so it pins its label to white instead.
    expect(STATUS_FILL.critical).toContain("bg-status-blocked");
    expect(STATUS_FILL.critical).toContain("text-white");
  });
});

import { describe, it, expect } from "vitest";
import { type Tone, TONE_TEXT, TONE_DOT, TONE_SOFT, TONE_SOLID } from "./tone";

const TONES: Tone[] = ["positive", "attention", "critical", "info", "neutral"];

describe("semantic tone maps", () => {
  it("every tone has an entry in every map (no missing status styling downstream)", () => {
    for (const map of [TONE_TEXT, TONE_DOT, TONE_SOFT, TONE_SOLID]) {
      for (const t of TONES) {
        expect(map[t], `missing tone "${t}"`).toBeTruthy();
      }
      expect(Object.keys(map).sort()).toEqual([...TONES].sort());
    }
  });

  it("text + dot map to the matching token utility per tone", () => {
    expect(TONE_TEXT.positive).toBe("text-positive");
    expect(TONE_DOT.critical).toBe("bg-critical");
    expect(TONE_TEXT.neutral).toBe("text-meta");
  });

  it("soft chips include text, border and a translucent fill; solid pills omit the border", () => {
    expect(TONE_SOFT.attention).toContain("text-attention");
    expect(TONE_SOFT.attention).toContain("border-");
    expect(TONE_SOFT.attention).toContain("bg-attention/10");
    expect(TONE_SOLID.attention).not.toContain("border-");
  });
});

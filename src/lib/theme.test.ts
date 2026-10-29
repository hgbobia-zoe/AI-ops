import { describe, it, expect } from "vitest";
import {
  parseTheme, nextTheme, resolveTheme, isTheme, THEME_SEQUENCE, DEFAULT_THEME, THEME_META,
} from "@/lib/theme";

describe("theme toggle logic", () => {
  it("defaults to dark and recognises valid themes", () => {
    expect(DEFAULT_THEME).toBe("dark");
    expect(isTheme("light")).toBe(true);
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("system")).toBe(true);
    expect(isTheme("sepia")).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });

  it("parseTheme falls back to dark for unknown/missing values", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("system")).toBe("system");
    expect(parseTheme(null)).toBe("dark");
    expect(parseTheme("")).toBe("dark");
    expect(parseTheme("garbage")).toBe("dark");
  });

  it("cycles Dark → Light → System → Dark", () => {
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("system");
    expect(nextTheme("system")).toBe("dark");
    // cover the whole declared sequence deterministically
    let t = THEME_SEQUENCE[0];
    const seen = [t];
    for (let i = 0; i < THEME_SEQUENCE.length; i++) {
      t = nextTheme(t);
      seen.push(t);
    }
    expect(seen).toEqual(["dark", "light", "system", "dark"]);
  });

  it("nextTheme restarts at the default for an unknown current value", () => {
    expect(nextTheme(undefined)).toBe("dark");
    expect(nextTheme(null)).toBe("dark");
  });

  it("resolveTheme maps a choice + OS preference to a concrete appearance", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    // unknown choice → default (dark), regardless of OS
    expect(resolveTheme(undefined, false)).toBe("dark");
  });

  it("every theme has presentation metadata with a known icon", () => {
    for (const t of THEME_SEQUENCE) {
      expect(THEME_META[t].label.length).toBeGreaterThan(0);
      expect(["moon", "sun", "monitor"]).toContain(THEME_META[t].icon);
    }
  });
});

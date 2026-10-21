import { describe, it, expect } from "vitest";
import { detectUntitledWorkers, hasNoTitle } from "./untitledWorkers";

describe("hasNoTitle", () => {
  it("true only for a genuinely unset title (missing / empty / whitespace)", () => {
    expect(hasNoTitle(undefined)).toBe(true);
    expect(hasNoTitle(null)).toBe(true);
    expect(hasNoTitle("")).toBe(true);
    expect(hasNoTitle("   ")).toBe(true);
  });
  it("false for any real title (even one that maps to the 'other' bucket)", () => {
    expect(hasNoTitle("Driver")).toBe(false);
    expect(hasNoTitle("Warehouse Associate")).toBe(false);
    expect(hasNoTitle("Co-Founder")).toBe(false);
    expect(hasNoTitle("Executive Assistant")).toBe(false);
  });
});

describe("detectUntitledWorkers", () => {
  it("flags a scheduled worker with no Title", () => {
    const out = detectUntitledWorkers([{ userId: 1, name: "New Hire", title: "" }]);
    expect(out).toEqual([{ userId: 1, name: "New Hire" }]);
  });

  it("does NOT flag a titled 'other' worker (Co-Founder / Executive Assistant are legitimate non-crew)", () => {
    const out = detectUntitledWorkers([
      { userId: 2, name: "The Owner", title: "Co-Founder" },
      { userId: 3, name: "Admin Person", title: "Executive Assistant" },
      { userId: 4, name: "Dee Driver", title: "Driver" },
    ]);
    expect(out).toEqual([]);
  });

  it("de-dupes a worker who appears on several shifts, keeps first name, stable order", () => {
    const out = detectUntitledWorkers([
      { userId: 9, name: "Pat", title: null },
      { userId: 5, name: "Sam", title: "   " },
      { userId: 9, name: "Pat (again)", title: undefined },
    ]);
    expect(out).toEqual([
      { userId: 9, name: "Pat" },
      { userId: 5, name: "Sam" },
    ]);
  });

  it("empty when everyone has a title (the live state: all 17 users titled → no flag)", () => {
    expect(
      detectUntitledWorkers([
        { userId: 1, name: "A", title: "Driver" },
        { userId: 2, name: "B", title: "Warehouse Associate" },
        { userId: 3, name: "C", title: "Co-Founder" },
      ]),
    ).toEqual([]);
  });
});

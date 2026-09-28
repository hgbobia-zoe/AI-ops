import { describe, it, expect } from "vitest";
import { detectLinenItems } from "./linen";

describe("detectLinenItems", () => {
  it("matches common linen titles (case-insensitive, singular + plural)", () => {
    const titles = [
      "90x132 Tablecloth - White",
      "Cloth Napkins (Ivory)",
      "Satin Table Runner",
      "Chair Sashes",
      "Spandex Chair Covers",
      "Table Overlay - Gold Sequin",
      "Pipe & Drape",
    ];
    expect(detectLinenItems(titles)).toEqual(titles); // every one is linen
  });

  it("returns only the matched titles, order-preserved and de-duplicated", () => {
    const titles = ["Chiavari Chair", "120in Round Linen", "60in Round Table", "120in Round Linen"];
    expect(detectLinenItems(titles)).toEqual(["120in Round Linen"]);
  });

  it("does not match non-linen rental items", () => {
    expect(detectLinenItems(["Chiavari Chair", "60in Round Table", "20x20 Frame Tent", "Cambro"])).toEqual([]);
  });

  it("is whole-word-ish — no silly substring hits", () => {
    // "runner" must not fire inside unrelated words; a bare non-linen list stays empty.
    expect(detectLinenItems(["Forerunner Generator", "Sashimi Platter Rental"]).length).toBe(0);
  });

  it("handles empty / null / undefined safely", () => {
    expect(detectLinenItems([])).toEqual([]);
    expect(detectLinenItems(null)).toEqual([]);
    expect(detectLinenItems(undefined)).toEqual([]);
  });
});

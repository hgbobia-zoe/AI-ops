import { describe, expect, it } from "vitest";
import { crewForItems, crewForRoute } from "./crewRules";

describe("crewForItems", () => {
  it("defaults to a single driver with no tent", () => {
    const n = crewForItems([{ name: "8ft Banquet Table" }, { name: "White Folding Chair", quantity: 100 }]);
    expect(n.crew).toBe(1);
    expect(n.hasTent).toBe(false);
  });

  it("any tent needs at least 2", () => {
    const n = crewForItems([{ name: "20x20 Pole Tent" }]);
    expect(n.crew).toBe(2);
    expect(n.hasTent).toBe(true);
  });

  it("a 40x60 tent needs 3", () => {
    const n = crewForItems([{ name: "40x60 Frame Tent" }, { name: "Chairs" }]);
    expect(n.crew).toBe(3);
    expect(n.biggestTentSqFt).toBe(2400);
  });

  it("parses dimension variants (quotes, spaces, ×)", () => {
    expect(crewForItems([{ name: "40' x 60' Sailcloth Tent" }]).crew).toBe(3);
    expect(crewForItems([{ name: "40×60 Marquee" }]).crew).toBe(3);
  });

  it("keeps the biggest tent when several are present", () => {
    const n = crewForItems([{ name: "20x20 Canopy" }, { name: "40x80 Frame Tent" }]);
    expect(n.crew).toBe(3);
    expect(n.biggestTentSqFt).toBe(3200);
  });
});

describe("crewForRoute", () => {
  it("takes the max crew across the route's stops", () => {
    const need = crewForRoute([
      [{ name: "Chairs" }], // 1
      [{ name: "20x20 Tent" }], // 2
      [{ name: "40x60 Frame Tent" }], // 3
    ]);
    expect(need.crew).toBe(3);
  });
});

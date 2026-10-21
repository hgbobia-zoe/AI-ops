import { describe, expect, it } from "vitest";
import { crewForItems, crewForRoute, DEFAULT_HEAVY_ITEM_KEYWORDS } from "./crewRules";

const FARM_TABLE = "Antique Rustic Solid Pine Folding Farm Table";

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

  it("an Event Readiness Service line needs at least 2 crew", () => {
    const n = crewForItems([{ name: "Chiavari Chair", quantity: 50 }, { name: "Event Readiness Service" }]);
    expect(n.crew).toBe(2);
    expect(n.hasEventReadiness).toBe(true);
    expect(n.reasons).toContain("Event Readiness Service → 2 crew");
  });

  it("Event Readiness never lowers a bigger tent crew", () => {
    const n = crewForItems([{ name: "40x60 Frame Tent" }, { name: "Event Readiness" }]);
    expect(n.crew).toBe(3); // big tent still wins
    expect(n.hasEventReadiness).toBe(true);
  });

  it("no Event Readiness line → flag is false", () => {
    expect(crewForItems([{ name: "8ft Banquet Table" }]).hasEventReadiness).toBe(false);
  });

  it("the heavy folding farm table needs at least 2 crew (in-code default floor)", () => {
    const n = crewForItems([{ name: FARM_TABLE }, { name: "White Folding Chair", quantity: 100 }]);
    expect(n.crew).toBe(2);
    expect(n.hasHeavyItem).toBe(true);
    expect(n.reasons).toContain(`Heavy item (${FARM_TABLE}) requires >= 2 crew`);
  });

  it("an order with no heavy item is unaffected (still 1 driver)", () => {
    const n = crewForItems([{ name: "8ft Banquet Table" }, { name: "Cocktail Table" }, { name: "White Folding Chair" }]);
    expect(n.crew).toBe(1);
    expect(n.hasHeavyItem).toBe(false);
  });

  it("does not over-match plain or small tables (only the farm table trips it)", () => {
    expect(crewForItems([{ name: "Round Table" }]).hasHeavyItem).toBe(false);
    expect(crewForItems([{ name: "Cocktail Table" }]).hasHeavyItem).toBe(false);
    expect(crewForItems([{ name: "Farm Bench" }]).hasHeavyItem).toBe(false);
    // The default keyword "folding farm table" requires the full phrase; a lone "farm table" stays untripped.
    expect(crewForItems([{ name: "6ft Farm Table" }]).hasHeavyItem).toBe(false);
  });

  it("matching is case-insensitive", () => {
    expect(crewForItems([{ name: "ANTIQUE RUSTIC SOLID PINE FOLDING FARM TABLE" }]).hasHeavyItem).toBe(true);
    expect(crewForItems([{ name: "folding farm table" }]).hasHeavyItem).toBe(true);
  });

  it("the heavy-item rule never lowers a higher requirement (big tent + farm table still needs 3)", () => {
    const n = crewForItems([{ name: "40x60 Frame Tent" }, { name: FARM_TABLE }]);
    expect(n.crew).toBe(3);
    expect(n.hasHeavyItem).toBe(true);
    expect(n.hasTent).toBe(true);
  });

  it("reads the keyword list from the caller (settings) with the in-code default as floor", () => {
    // A custom, broader list the admin might save — case-insensitive, matches by substring.
    const n = crewForItems([{ name: "Vintage Steamer Trunk" }], ["steamer trunk"]);
    expect(n.crew).toBe(2);
    expect(n.hasHeavyItem).toBe(true);
    // The in-code default is exported so settings can seed it and it is the floor before any admin edit.
    expect(DEFAULT_HEAVY_ITEM_KEYWORDS).toContain("folding farm table");
    // An empty admin list falls back to NO heavy match (caller passes [] deliberately) — farm table then
    // only trips when the default is used.
    expect(crewForItems([{ name: FARM_TABLE }], []).hasHeavyItem).toBe(false);
    expect(crewForItems([{ name: FARM_TABLE }]).hasHeavyItem).toBe(true);
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

  it("Event Readiness on any stop floors the route at 2 crew (even off the max stop)", () => {
    const need = crewForRoute([
      [{ name: "Event Readiness Service" }], // 2, not the max
      [{ name: "Chairs" }], // 1
    ]);
    expect(need.crew).toBe(2);
    expect(need.hasEventReadiness).toBe(true);
  });

  it("a heavy item on any stop floors the route at 2 crew (even off the max stop)", () => {
    const need = crewForRoute([
      [{ name: FARM_TABLE }], // 2, not the max
      [{ name: "Chairs" }], // 1
    ]);
    expect(need.crew).toBe(2);
    expect(need.hasHeavyItem).toBe(true);
    expect(need.reasons.some((r) => r.startsWith("Heavy item"))).toBe(true);
  });

  it("a heavy item never lowers a bigger tent route (tent 3 + farm table stays 3)", () => {
    const need = crewForRoute([
      [{ name: "40x60 Frame Tent" }], // 3, the max
      [{ name: FARM_TABLE }], // 2
    ]);
    expect(need.crew).toBe(3);
    expect(need.hasHeavyItem).toBe(true);
  });
});

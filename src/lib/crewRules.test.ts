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
});

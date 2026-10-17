import { describe, expect, it } from "vitest";
import { specialtyForItemLists, routeSpecialty } from "./routeSpecialty";

const KW = ["dance floor", "staging", "chandelier"];

describe("routeSpecialty", () => {
  it("flags a tent (crewRules) with difficulty 2", () => {
    const r = specialtyForItemLists([[{ name: "20x20 Frame Tent" }]], KW);
    expect(r.specialty).toBe(true);
    expect(r.difficulty).toBe(2);
    expect(r.reasons).toContain("tent");
  });

  it("flags a big tent harder (difficulty 3, 'large tent')", () => {
    const r = specialtyForItemLists([[{ name: "40x60 Sailcloth Tent" }]], KW);
    expect(r.difficulty).toBe(3);
    expect(r.reasons).toContain("large tent");
  });

  it("flags a configurable keyword match and adds 1 per distinct keyword", () => {
    const r = specialtyForItemLists([[{ name: "Oak Dance Floor 18x18" }, { name: "Crystal Chandelier" }]], KW);
    expect(r.specialty).toBe(true);
    expect(r.difficulty).toBe(2); // dance floor + chandelier
    expect(r.reasons).toEqual(expect.arrayContaining(["dance floor", "chandelier"]));
  });

  it("counts a repeated keyword only once", () => {
    const r = specialtyForItemLists([[{ name: "Dance Floor A" }], [{ name: "Dance Floor B" }]], KW);
    expect(r.difficulty).toBe(1);
  });

  it("stacks tent + keyword difficulty", () => {
    const r = specialtyForItemLists([[{ name: "40x60 Tent" }, { name: "Staging riser" }]], KW);
    expect(r.difficulty).toBe(4); // large tent (3) + staging (1)
  });

  it("is not specialty with no tent and no keyword", () => {
    const r = specialtyForItemLists([[{ name: "Chiavari Chair" }, { name: "60in Round Table" }]], KW);
    expect(r.specialty).toBe(false);
    expect(r.difficulty).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("routeSpecialty wrapper reads a route's stop items", () => {
    const r = routeSpecialty({ stops: [{ items: [{ name: "20x40 Pole Tent" }] }, { items: undefined }] }, KW);
    expect(r.specialty).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { connectorWeights, mostRecentIndex, touchDateLabel } from "./touchpointLayout";

describe("connectorWeights — cadence from real time gaps", () => {
  it("returns n-1 weights, with the largest real gap weighted highest", () => {
    // gaps: 1 day, then 10 days — the second connector must be longer.
    const isos = ["2027-03-01T00:00:00Z", "2027-03-02T00:00:00Z", "2027-03-12T00:00:00Z"];
    const w = connectorWeights(isos);
    expect(w).toHaveLength(2);
    expect(w[1]).toBeGreaterThan(w[0]);
    expect(Math.min(...w)).toBeGreaterThanOrEqual(0.35); // floor so nodes never collide
  });

  it("an undated endpoint yields the floor weight (we cannot measure that gap)", () => {
    const w = connectorWeights([null, "2027-03-02T00:00:00Z"]);
    expect(w).toEqual([0.35]);
  });

  it("identical instants still keep the floor (no zero-length connector)", () => {
    const w = connectorWeights(["2027-03-02T00:00:00Z", "2027-03-02T00:00:00Z"]);
    expect(w).toEqual([0.35]);
  });

  it("fewer than two points has no connectors", () => {
    expect(connectorWeights([])).toEqual([]);
    expect(connectorWeights(["2027-03-02T00:00:00Z"])).toEqual([]);
  });
});

describe("mostRecentIndex — emphasis never lands on an undated note", () => {
  it("picks the last DATED point even when undated notes trail it", () => {
    // undated notes sort last in the array; the newest DATED touch keeps the emphasis.
    const isos = ["2027-03-01T00:00:00Z", "2027-03-05T00:00:00Z", null];
    expect(mostRecentIndex(isos)).toBe(1);
  });

  it("falls back to the last point when none are dated", () => {
    expect(mostRecentIndex([null, null])).toBe(1);
  });

  it("empty → -1", () => {
    expect(mostRecentIndex([])).toBe(-1);
  });
});

describe("touchDateLabel — honest date tokens", () => {
  it("formats a dated instant as month + day", () => {
    expect(touchDateLabel("2027-06-03T10:00:00Z", null)).toBe("Jun 3");
  });

  it("keeps an undated note's written token verbatim", () => {
    expect(touchDateLabel(null, "9/7")).toBe("9/7");
  });

  it("empty when there is nothing honest to show", () => {
    expect(touchDateLabel(null, null)).toBe("");
  });
});

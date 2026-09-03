import { describe, it, expect } from "vitest";
import { computeVariance, laborLine, laborPctOfRevenue, contribution, contributionMargin, sumKnown } from "./calc";

describe("finance calc — variance with financial meaning", () => {
  it("revenue above plan is favorable; below is not", () => {
    expect(computeVariance(45000, 47200, "revenue").favorable).toBe(true);
    expect(computeVariance(45000, 42000, "revenue").favorable).toBe(false);
  });
  it("cost above plan is UNfavorable; below is favorable", () => {
    expect(computeVariance(1000, 1240, "cost").favorable).toBe(false);
    expect(computeVariance(1000, 900, "cost").favorable).toBe(true);
  });
  it("variance% is null when plan is 0 (no fake precision)", () => {
    expect(computeVariance(0, 500, "revenue").variancePct).toBeNull();
  });
  it("missing side → all-null variance, not a guess", () => {
    const v = computeVariance(null, 500, "revenue");
    expect(v.variance).toBeNull();
    expect(v.favorable).toBeNull();
  });
  it("exact match is favorable with 0 variance", () => {
    const v = computeVariance(1000, 1000, "cost");
    expect(v.variance).toBe(0);
    expect(v.favorable).toBe(true);
  });
});

describe("finance calc — labor", () => {
  it("planned/actual cost = hours × rate, with variances", () => {
    const l = laborLine(8, 11, 22);
    expect(l.plannedCost).toBe(176);
    expect(l.actualCost).toBe(242);
    expect(l.costVariance.variance).toBe(66);
    expect(l.costVariance.favorable).toBe(false); // over plan = bad
    expect(l.hoursVariance.variance).toBe(3);
    expect(l.status).toBe("ACTUAL");
  });
  it("no rate on file → costs UNAVAILABLE, never guessed", () => {
    const l = laborLine(8, 11, null);
    expect(l.plannedCost).toBeNull();
    expect(l.actualCost).toBeNull();
    expect(l.status).toBe("UNAVAILABLE");
    expect(l.hoursVariance.variance).toBe(3); // hours still comparable
  });
  it("planned-only (no actual yet) → PLANNED status, actual cost null", () => {
    const l = laborLine(8, null, 22);
    expect(l.plannedCost).toBe(176);
    expect(l.actualCost).toBeNull();
    expect(l.status).toBe("PLANNED");
  });
  it("different rates per employee are respected", () => {
    expect(laborLine(4, 4, 18).actualCost).toBe(72);
    expect(laborLine(4, 4, 25).actualCost).toBe(100);
  });
});

describe("finance calc — margins & sums", () => {
  it("labor % of revenue, null when revenue unknown/zero", () => {
    expect(laborPctOfRevenue(1000, 5000)).toBe(0.2);
    expect(laborPctOfRevenue(1000, 0)).toBeNull();
    expect(laborPctOfRevenue(1000, null)).toBeNull();
  });
  it("contribution & margin unavailable when revenue unknown", () => {
    expect(contribution(5000, 1500)).toBe(3500);
    expect(contributionMargin(5000, 1500)).toBe(0.7);
    expect(contribution(null, 1500)).toBeNull();
    expect(contributionMargin(null, 1500)).toBeNull();
  });
  it("sumKnown ignores nulls but returns null when ALL unknown", () => {
    expect(sumKnown([100, null, 50])).toBe(150);
    expect(sumKnown([null, undefined])).toBeNull();
  });
});

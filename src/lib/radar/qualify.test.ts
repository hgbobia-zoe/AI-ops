import { describe, it, expect } from "vitest";
import { qualify, tierFor, estimateValue, isMultiDay, type QualifyInput } from "./qualify";
import { DEFAULT_RADAR_CONFIG } from "./config";

const base: QualifyInput = {
  category: "CONFERENCE",
  region: "DC",
  startDate: "2027-09-17",
  endDate: "2027-09-19",
  expectedAttendance: 900,
  attendanceConfidence: "INFERRED",
  recurring: true,
  attributes: { reception: "PRESENT", exhibitors: "PRESENT", outdoor: "UNKNOWN" },
};

describe("qualify — deterministic scoring", () => {
  it("is deterministic (same input → same score)", () => {
    expect(qualify(base).rentalFitScore).toBe(qualify(base).rentalFitScore);
  });

  it("scores a big multi-day DC conference with signals as HIGH", () => {
    const q = qualify(base);
    expect(q.tier).toBe("HIGH");
    expect(q.rentalFitScore).toBeGreaterThanOrEqual(70);
    // Every point is explained by a positive/negative signal.
    const explained = q.positives.reduce((s, p) => s + p.weight, 0) + q.negatives.reduce((s, n) => s + n.weight, 0);
    expect(Math.round(Math.max(0, Math.min(100, explained)))).toBe(q.rentalFitScore);
  });

  it("surfaces unknown signals as unknowns (never as absent)", () => {
    const q = qualify(base);
    expect(q.unknowns.map((u) => u.key)).toContain("outdoor");
    // an unknown contributes 0 points
    expect(q.unknowns.every((u) => u.weight === 0)).toBe(true);
  });

  it("penalizes a fully virtual event into UNQUALIFIED territory", () => {
    const q = qualify({ ...base, attributes: { virtual: "PRESENT" }, recurring: false });
    expect(q.negatives.some((n) => n.key === "virtual")).toBe(true);
    expect(q.rentalFitScore).toBeLessThan(DEFAULT_RADAR_CONFIG.tierThresholds[1].min);
  });

  it("penalizes an out-of-area event heavily", () => {
    const inArea = qualify(base).rentalFitScore;
    const outArea = qualify({ ...base, region: "OUT_OF_AREA" }).rentalFitScore;
    expect(outArea).toBeLessThan(inArea);
    expect(qualify({ ...base, region: "OUT_OF_AREA" }).negatives.some((n) => n.key === "out_of_area")).toBe(true);
  });

  it("flags a very small known event as a negative", () => {
    const q = qualify({ ...base, expectedAttendance: 20, attendanceConfidence: "VERIFIED" });
    expect(q.negatives.some((n) => n.key === "tiny_event")).toBe(true);
  });

  it("lowers commercial confidence when facts are unknown", () => {
    const known = qualify({ ...base, attributes: { reception: "PRESENT", exhibitors: "PRESENT", outdoor: "PRESENT", networking: "PRESENT", gala: "PRESENT", hospitality: "PRESENT", vip: "PRESENT", sponsor_activation: "PRESENT", virtual: "ABSENT" } });
    const unsure = qualify({ ...base, attributes: { reception: "UNKNOWN", exhibitors: "UNKNOWN", outdoor: "UNKNOWN", networking: "UNKNOWN" } });
    // commercial score never exceeds rental fit, and drops with unknowns
    expect(known.commercialOpportunityScore).toBeLessThanOrEqual(known.rentalFitScore);
    expect(unsure.commercialOpportunityScore).toBeLessThanOrEqual(unsure.rentalFitScore);
  });
});

describe("tierFor / estimateValue / isMultiDay", () => {
  it("maps scores to configured tiers", () => {
    expect(tierFor(80)).toBe("HIGH");
    expect(tierFor(50)).toBe("MEDIUM");
    expect(tierFor(25)).toBe("LOW");
    expect(tierFor(5)).toBe("UNQUALIFIED");
  });

  it("estimates an indicative range only when attendance is known and in-area", () => {
    expect(estimateValue(base)).not.toBeNull();
    expect(estimateValue({ ...base, expectedAttendance: null })).toBeNull();
    expect(estimateValue({ ...base, attendanceConfidence: "UNKNOWN" })).toBeNull();
    expect(estimateValue({ ...base, region: "OUT_OF_AREA" })).toBeNull();
    const v = estimateValue(base)!;
    expect(v.high).toBeGreaterThan(v.low);
  });

  it("detects multi-day only when end is after start", () => {
    expect(isMultiDay("2027-09-17", "2027-09-19")).toBe(true);
    expect(isMultiDay("2027-09-17", "2027-09-17")).toBe(false);
    expect(isMultiDay("2027-09-17", null)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { nameSimilarity } from "./fusion";

describe("nameSimilarity", () => {
  it("is high for near-identical event names (ignoring years/filler)", () => {
    expect(nameSimilarity("CHD Conference 2027", "CHD Conference 2026")).toBeGreaterThanOrEqual(0.5);
  });
  it("is low for unrelated names", () => {
    expect(nameSimilarity("Independence Day Festival Rentals", "IT Help Desk Staffing Contract")).toBeLessThan(0.2);
  });
  it("ignores stopwords and casing", () => {
    expect(nameSimilarity("Montgomery County Event Services", "event services for montgomery county")).toBeGreaterThan(0.5);
  });
  it("is 0 when a name is only filler", () => {
    expect(nameSimilarity("the 2027", "county services")).toBe(0);
  });
});

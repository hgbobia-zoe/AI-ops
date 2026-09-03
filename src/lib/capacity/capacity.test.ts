import { describe, it, expect } from "vitest";
import { classifyCapacity, type CapacityInput } from "./capacity";

const base: CapacityInput = {
  date: "2026-09-12",
  fleetSize: 3,
  trucksRouted: 1,
  peakConcurrentRoutes: 1,
  scheduledDrivers: 2,
  staffingVerified: true,
  worstStaffingSeverity: null,
};

describe("capacity classifier", () => {
  it("clean day = AVAILABLE", () => {
    expect(classifyCapacity(base).verdict).toBe("AVAILABLE");
  });

  it("staffing unverified = UNVERIFIED (never a fabricated verdict)", () => {
    expect(classifyCapacity({ ...base, staffingVerified: false, scheduledDrivers: 0 }).verdict).toBe("UNVERIFIED");
  });

  it("full fleet committed = TIGHT", () => {
    expect(classifyCapacity({ ...base, trucksRouted: 3 }).verdict).toBe("TIGHT");
  });

  it("fewer drivers than peak concurrent routes = CONSTRAINED", () => {
    expect(classifyCapacity({ ...base, peakConcurrentRoutes: 3, scheduledDrivers: 1 }).verdict).toBe("CONSTRAINED");
  });

  it("a HIGH staffing gap = CONSTRAINED; a MEDIUM one = TIGHT", () => {
    expect(classifyCapacity({ ...base, worstStaffingSeverity: "HIGH" }).verdict).toBe("CONSTRAINED");
    expect(classifyCapacity({ ...base, worstStaffingSeverity: "MEDIUM" }).verdict).toBe("TIGHT");
  });
});

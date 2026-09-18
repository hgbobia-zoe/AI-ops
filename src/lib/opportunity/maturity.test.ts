import { describe, it, expect } from "vitest";
import { deriveMaturity } from "./maturity";

const TODAY = "2026-09-18";

describe("deriveMaturity", () => {
  it("classifies by the nearer of event date / deadline", () => {
    expect(deriveMaturity({ estimatedDate: "2026-09-30", deadline: null, today: TODAY }).maturity).toBe("IMMEDIATE"); // 12d
    expect(deriveMaturity({ estimatedDate: "2026-11-15", deadline: null, today: TODAY }).maturity).toBe("OPERATIONALLY_ACTIVE"); // ~58d
    expect(deriveMaturity({ estimatedDate: "2027-01-15", deadline: null, today: TODAY }).maturity).toBe("PROCUREMENT_WINDOW"); // ~119d
    expect(deriveMaturity({ estimatedDate: "2027-04-15", deadline: null, today: TODAY }).maturity).toBe("PLANNING"); // ~209d
    expect(deriveMaturity({ estimatedDate: "2027-11-01", deadline: null, today: TODAY }).maturity).toBe("EARLY_SIGNAL"); // >365d
    expect(deriveMaturity({ estimatedDate: "2026-01-01", deadline: null, today: TODAY }).maturity).toBe("PAST");
  });
  it("uses the deadline when it is nearer than the event", () => {
    // event far out, but a close procurement deadline drives urgency
    expect(deriveMaturity({ estimatedDate: "2027-08-01", deadline: "2026-10-05", today: TODAY }).maturity).toBe("IMMEDIATE");
  });
  it("handles an unknown date honestly", () => {
    expect(deriveMaturity({ estimatedDate: null, deadline: null, today: TODAY }).maturity).toBe("DATE_UNKNOWN");
  });
  it("flags inferred-from-date-only without a procurement signal", () => {
    expect(deriveMaturity({ estimatedDate: "2027-03-01", deadline: null, today: TODAY }).inferredFromDateOnly).toBe(true);
    expect(deriveMaturity({ estimatedDate: "2027-03-01", deadline: "2026-12-01", today: TODAY, hasProcurementSignal: true }).inferredFromDateOnly).toBe(false);
  });
});

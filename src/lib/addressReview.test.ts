import { describe, it, expect } from "vitest";
import { reviewStopAddress } from "./addressReview";

// Fixed instants in America/New_York (ETA_TIMEZONE default):
const SAT_2PM = "2026-09-05T14:00:00-04:00"; // Saturday afternoon
const WED_10AM = "2026-09-02T10:00:00-04:00"; // Wednesday, business hours
const WED_7PM = "2026-09-02T19:00:00-04:00"; // Wednesday evening, after close

describe("reviewStopAddress", () => {
  it("flags an office suite scheduled on a weekend", () => {
    const r = reviewStopAddress({ name: "Acme Corp", address: "100 Market St, Suite 200, Rockville, MD", whenIso: SAT_2PM });
    expect(r.class).toBe("business");
    expect(r.hoursRisk).toBe(true);
    expect(r.note).toMatch(/weekend/i);
  });

  it("flags an office scheduled after close on a weekday", () => {
    const r = reviewStopAddress({ address: "1 Corporate Plaza, Floor 3", whenIso: WED_7PM });
    expect(r.class).toBe("business");
    expect(r.hoursRisk).toBe(true);
  });

  it("business within hours: warned but not high-risk", () => {
    const r = reviewStopAddress({ address: "500 Office Park Dr, Bldg C", whenIso: WED_10AM });
    expect(r.class).toBe("business");
    expect(r.hoursRisk).toBe(false);
    expect(r.note).toMatch(/access hours/i);
  });

  it("does NOT flag an event venue even on a weekend evening", () => {
    const r = reviewStopAddress({ name: "The Grand Ballroom", address: "9 Riverside Dr", whenIso: SAT_2PM });
    expect(r.class).toBe("venue");
    expect(r.hoursRisk).toBe(false);
  });

  it("treats a plain apartment as residential", () => {
    const r = reviewStopAddress({ name: "Dave Miller", address: "4218 Brookfield Dr, Apt 4B", whenIso: SAT_2PM });
    expect(r.class).toBe("residential");
    expect(r.hoursRisk).toBe(false);
  });

  it("treats a bare house address as residential", () => {
    const r = reviewStopAddress({ name: "Lebensohn Wedding", address: "12 Maple Lane, Bethesda, MD", whenIso: SAT_2PM });
    expect(r.class).toBe("residential");
  });
});

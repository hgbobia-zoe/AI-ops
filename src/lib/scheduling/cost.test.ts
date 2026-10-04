import { describe, it, expect } from "vitest";
import {
  shiftWindowHours,
  gigWindowHours,
  internalRateFor,
  internalSeat,
  tempSeat,
  computeTempExposure,
  type LaborSeat,
} from "./cost";
import type { PayRate } from "@/lib/connecteam";

describe("window hours", () => {
  it("computes shift hours from a known window", () => {
    expect(shiftWindowHours({ startTime: "2026-10-04T08:00:00Z", endTime: "2026-10-04T16:00:00Z", windowKnown: true })).toBe(8);
  });
  it("returns null when the window is unknown or missing (never fabricated)", () => {
    expect(shiftWindowHours({ startTime: "2026-10-04T08:00:00Z", endTime: "2026-10-04T16:00:00Z", windowKnown: false })).toBeNull();
    expect(shiftWindowHours({ startTime: null, endTime: "2026-10-04T16:00:00Z", windowKnown: true })).toBeNull();
  });
  it("returns null for a non-positive span", () => {
    expect(shiftWindowHours({ startTime: "2026-10-04T16:00:00Z", endTime: "2026-10-04T08:00:00Z", windowKnown: true })).toBeNull();
  });
  it("computes gig hours", () => {
    expect(gigWindowHours({ startsAt: "2026-10-04T09:00:00Z", endsAt: "2026-10-04T11:30:00Z" })).toBe(2.5);
  });
});

describe("internalRateFor", () => {
  const rates = new Map<number, PayRate[]>([
    [1, [{ userId: 1, hourlyRate: 25, effectiveDate: "2026-01-01" }]],
  ]);
  it("returns the rate on the date, null when none", () => {
    expect(internalRateFor(rates, 1, "2026-10-04")).toBe(25);
    expect(internalRateFor(rates, 2, "2026-10-04")).toBeNull();
  });
});

describe("seat builders", () => {
  it("internal seat cost = hours * rate, null if either unknown", () => {
    expect(internalSeat(8, 25).cost).toBe(200);
    expect(internalSeat(null, 25).cost).toBeNull();
    expect(internalSeat(8, null).cost).toBeNull();
  });
  it("temp seat uses basePrice as cost and derives a per-hour rate when the window is known", () => {
    const s = tempSeat(4, 120);
    expect(s.cost).toBe(120);
    expect(s.rate).toBe(30);
    expect(tempSeat(null, 120).rate).toBeNull();
    expect(tempSeat(4, null).cost).toBeNull();
  });
});

describe("computeTempExposure", () => {
  it("rolls up counts, hours, cost and the premium from known seats", () => {
    const seats: LaborSeat[] = [
      internalSeat(8, 25), // internal: 200, 8h
      internalSeat(8, 25), // internal: 200, 8h
      tempSeat(8, 400), // temp: 400, 8h → 50/h
    ];
    const x = computeTempExposure(seats);
    expect(x.internalCount).toBe(2);
    expect(x.tempCount).toBe(1);
    expect(x.internalHours).toBe(16);
    expect(x.internalCost).toBe(400);
    expect(x.tempHours).toBe(8);
    expect(x.tempCost).toBe(400);
    expect(x.totalLaborHours).toBe(24);
    expect(x.tempHourShare).toBeCloseTo(8 / 24, 4);
    expect(x.avgInternalRate).toBe(25);
    expect(x.avgTempRate).toBe(50);
    expect(x.tempPremiumMultiplier).toBe(2);
    expect(x.equivalentInternalCost).toBe(200); // 8h * $25
    expect(x.incrementalTempCost).toBe(200); // 400 - 200 = premium paid
    expect(x.rateUnknownSeats).toBe(0);
  });

  it("excludes rate-unknown seats from cost totals and counts them (never fabricates)", () => {
    const seats: LaborSeat[] = [
      internalSeat(8, 25), // priced
      internalSeat(8, null), // rate unknown → excluded from cost, counted
      tempSeat(8, null), // base price unknown → excluded from cost, counted
    ];
    const x = computeTempExposure(seats);
    expect(x.internalCount).toBe(2);
    expect(x.tempCount).toBe(1);
    expect(x.internalCost).toBe(200); // only the priced internal seat
    expect(x.tempCost).toBeNull(); // no priced temp seat
    expect(x.rateUnknownSeats).toBe(2);
    expect(x.incrementalTempCost).toBeNull(); // cannot compute without temp cost
  });

  it("keeps premium null when only one side is known (no fabricated multiplier)", () => {
    const x = computeTempExposure([tempSeat(8, 400)]);
    expect(x.avgTempRate).toBe(50);
    expect(x.avgInternalRate).toBeNull();
    expect(x.tempPremiumMultiplier).toBeNull();
    expect(x.incrementalTempCost).toBeNull();
  });

  it("all-unknown hours yield null totals, not 0", () => {
    const x = computeTempExposure([internalSeat(null, 25), tempSeat(null, 400)]);
    expect(x.internalHours).toBeNull();
    expect(x.tempHours).toBeNull();
    expect(x.totalLaborHours).toBeNull();
    expect(x.tempHourShare).toBeNull();
  });
});

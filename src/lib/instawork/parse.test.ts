import { describe, it, expect } from "vitest";
import { toShift } from "./parse";

const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 991,
  name: "ZER",
  starts_at: "2026-10-03T09:00:00-04:00",
  ends_at: "2026-10-03T17:00:00-04:00",
  timezone: "America/New_York",
  position_name: "Driver",
  base_price: 40.98,
  filled_shifts_count: 1,
  total_shifts_count: 2,
  location_name: "ZER",
  clock_in_code: "3243",
  clock_out_code: "2450",
  shifts: [
    { worker_name: "Alex P", worker_id: 55 },
    { worker_name: "", worker_id: null },
  ],
  interested_pros_pending_count: 0,
  ...over,
});

describe("toShift — Instawork gig parsing", () => {
  it("captures the per-gig clock-in / clock-out codes and worker ids", () => {
    const s = toShift(raw())!;
    expect(s.clockInCode).toBe("3243");
    expect(s.clockOutCode).toBe("2450");
    expect(s.workers).toEqual(["Alex P"]); // blank worker_name dropped
    expect(s.workerIds).toEqual(["55"]); // worker ids as strings, nulls dropped
  });

  it("leaves codes null when Instawork sends none (FACTS ONLY, never fabricated)", () => {
    const s = toShift(raw({ clock_in_code: undefined, clock_out_code: "" }))!;
    expect(s.clockInCode).toBeNull();
    expect(s.clockOutCode).toBeNull();
  });

  it("returns null for a row missing id/window", () => {
    expect(toShift(raw({ starts_at: undefined }))).toBeNull();
  });
});

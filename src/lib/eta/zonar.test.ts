import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePosition, getTruckPosition, rateLimitedUntil, unitId } from "./zonar";

describe("unitId — GPSTRACKIT_UNITS_JSON mapping", () => {
  afterEach(() => {
    delete process.env.GPSTRACKIT_UNITS_JSON;
  });

  it("maps a truckId to its GPS TrackIt unit id", () => {
    process.env.GPSTRACKIT_UNITS_JSON = JSON.stringify({ "NPR-1": "1", E450: "2" });
    expect(unitId("NPR-1")).toBe("1");
    expect(unitId("E450")).toBe("2");
  });

  it("falls back to the truckId when it is not in the map", () => {
    process.env.GPSTRACKIT_UNITS_JSON = JSON.stringify({ "NPR-1": "1" });
    expect(unitId("E450")).toBe("E450");
  });

  it("falls back to the truckId when the map is unset or malformed", () => {
    delete process.env.GPSTRACKIT_UNITS_JSON;
    expect(unitId("NPR-1")).toBe("NPR-1");
    process.env.GPSTRACKIT_UNITS_JSON = "{not valid json";
    expect(unitId("NPR-1")).toBe("NPR-1");
  });
});

describe("parsePosition", () => {
  it("finds lat/long in a nested Zonar response", () => {
    const data = { currentlocation: { lat: "38.9072", long: "-77.0369", time: "2026-08-30T12:00:00Z" } };
    expect(parsePosition(data)).toEqual({ lat: 38.9072, lng: -77.0369, ts: "2026-08-30T12:00:00Z" });
  });

  it("accepts latitude/longitude spellings", () => {
    expect(parsePosition({ asset: { latitude: 39, longitude: -76.6 } })).toMatchObject({ lat: 39, lng: -76.6 });
  });

  it("captures the heading (direction of travel), normalized to 0-359", () => {
    expect(parsePosition({ lat: 39, long: -77, heading: 90 })).toMatchObject({ heading: 90 });
    expect(parsePosition({ lat: 39, long: -77, direction: "270" })).toMatchObject({ heading: 270 });
    expect(parsePosition({ lat: 39, long: -77, bearing: 450 })).toMatchObject({ heading: 90 }); // wrapped
    expect(parsePosition({ lat: 39, long: -77 }).heading).toBeUndefined();
  });

  it("ignores the (0,0) null-island 'no fix' value", () => {
    expect(parsePosition({ lat: 0, long: 0 })).toBeNull();
  });

  it("returns null when there is no position", () => {
    expect(parsePosition({ error: "no data" })).toBeNull();
    expect(parsePosition(null)).toBeNull();
  });

  it("finds the position deep inside a GPS TrackIt unit object", () => {
    const unit = { id: 1, label: "Isuzu NPR 1", lastEvent: { latitude: 38.9, longitude: -77.03 } };
    expect(parsePosition(unit)).toMatchObject({ lat: 38.9, lng: -77.03 });
  });
});

describe("getTruckPosition rate-limit backoff", () => {
  beforeEach(() => {
    process.env.GPSTRACKIT_API_KEY = "test-key";
    (globalThis as { __gpstrackitRateLimitedUntil?: number }).__gpstrackitRateLimitedUntil = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GPSTRACKIT_API_KEY;
  });

  it("backs off after a 429 and stops calling the API", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 429 }) as unknown as Response);

    // First call hits the API, gets 429, returns null, and arms the backoff.
    expect(await getTruckPosition("NPR-1")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rateLimitedUntil()).toBeGreaterThan(Date.now());

    // Second call is skipped entirely while backing off — no new API hit.
    expect(await getTruckPosition("NPR-1")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

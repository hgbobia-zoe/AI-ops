import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePosition, getTruckPosition, rateLimitedUntil } from "./zonar";

describe("parsePosition", () => {
  it("finds lat/long in a nested Zonar response", () => {
    const data = { currentlocation: { lat: "38.9072", long: "-77.0369", time: "2026-08-30T12:00:00Z" } };
    expect(parsePosition(data)).toEqual({ lat: 38.9072, lng: -77.0369, ts: "2026-08-30T12:00:00Z" });
  });

  it("accepts latitude/longitude spellings", () => {
    expect(parsePosition({ asset: { latitude: 39, longitude: -76.6 } })).toMatchObject({ lat: 39, lng: -76.6 });
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

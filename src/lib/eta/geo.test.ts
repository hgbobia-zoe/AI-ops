import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geocode, driveTime } from "./geo";

// ETA SOURCE SELECTION: no GOOGLE_MAPS_API_KEY → keyless OpenStreetMap (Nominatim + OSRM) is PRIMARY.
// Google is used only when its key is explicitly set, and is never required. We assert which upstream
// host is called for each case, mocking fetch so no real network call happens.

function mockFetch(capture: string[], body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    capture.push(String(input));
    return new Response(JSON.stringify(body), { status: 200 }) as unknown as Response;
  });
}

function clearGeoCache() {
  (globalThis as { __zoeGeocache?: Map<string, unknown> }).__zoeGeocache = new Map();
}

describe("geo provider selection (no Google key required)", () => {
  beforeEach(() => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    clearGeoCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  it("geocodes via keyless Nominatim when no Google key is set", async () => {
    const urls: string[] = [];
    mockFetch(urls, [{ lat: "38.9", lon: "-77.03" }]);
    const r = await geocode("111 Rockville Pike, Rockville, MD");
    expect(r).toEqual({ lat: 38.9, lng: -77.03 });
    expect(urls[0]).toContain("nominatim.openstreetmap.org");
    expect(urls[0]).not.toContain("googleapis.com");
  });

  it("routes via keyless OSRM when no Google key is set", async () => {
    const urls: string[] = [];
    mockFetch(urls, { routes: [{ duration: 600, distance: 8000 }] });
    const r = await driveTime({ lat: 38.9, lng: -77.03 }, { lat: 39.0, lng: -77.1 });
    expect(r).toEqual({ seconds: 600, meters: 8000 });
    expect(urls[0]).toContain("router.project-osrm.org");
    expect(urls[0]).not.toContain("googleapis.com");
  });

  it("uses Google (traffic-aware) ONLY when the key is explicitly set", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    const urls: string[] = [];
    mockFetch(urls, {
      status: "OK",
      routes: [{ legs: [{ duration_in_traffic: { value: 540 }, duration: { value: 600 }, distance: { value: 8000 } }] }],
    });
    const r = await driveTime({ lat: 38.9, lng: -77.03 }, { lat: 39.0, lng: -77.1 });
    expect(r).toEqual({ seconds: 540, meters: 8000 }); // prefers duration_in_traffic
    expect(urls[0]).toContain("maps.googleapis.com");
  });
});

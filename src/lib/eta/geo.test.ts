import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geocode, driveTime } from "./geo";

// GEOCODE order: Google (only when keyed) → US Census (keyless default) → Nominatim (keyless last resort).
// DRIVE TIME: Google when keyed, else OSRM. fetch is mocked per-host so no real network call happens.

const census = (x: number, y: number) => ({ result: { addressMatches: [{ coordinates: { x, y } }] } });
const censusEmpty = { result: { addressMatches: [] } };

function mockByHost(
  capture: string[],
  map: { census?: unknown; nominatim?: unknown; google?: unknown; osrm?: unknown },
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const u = String(input);
    capture.push(u);
    let body: unknown = {};
    if (u.includes("census.gov")) body = map.census ?? censusEmpty;
    else if (u.includes("nominatim")) body = map.nominatim ?? [];
    else if (u.includes("router.project-osrm.org")) body = map.osrm ?? {};
    else if (u.includes("maps.googleapis.com")) body = map.google ?? {};
    return new Response(JSON.stringify(body), { status: 200 }) as unknown as Response;
  });
}

function clearGeoCache() {
  (globalThis as { __zoeGeocache?: Map<string, unknown> }).__zoeGeocache = new Map();
}

describe("geocode — Census-first keyless provider chain", () => {
  beforeEach(() => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    clearGeoCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  it("geocodes via the US Census geocoder (keyless default) — not Nominatim", async () => {
    const urls: string[] = [];
    mockByHost(urls, { census: census(-76.7425, 39.2193) });
    const r = await geocode("6555 Belmont Woods Rd, Elkridge, MD, 21075");
    expect(r).toEqual({ lat: 39.2193, lng: -76.7425 }); // Census x=lng, y=lat
    expect(urls[0]).toContain("census.gov");
    expect(urls.join(" ")).not.toContain("nominatim");
  });

  it("falls back to Nominatim only when Census has no match", async () => {
    const urls: string[] = [];
    mockByHost(urls, { census: censusEmpty, nominatim: [{ lat: "38.9", lon: "-77.03" }] });
    const r = await geocode("somewhere only Nominatim knows");
    expect(r).toEqual({ lat: 38.9, lng: -77.03 });
    expect(urls[0]).toContain("census.gov");
    expect(urls[1]).toContain("nominatim");
  });

  it("uses Google first ONLY when the key is explicitly set", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    const urls: string[] = [];
    mockByHost(urls, { google: { status: "OK", results: [{ geometry: { location: { lat: 40, lng: -75 } } }] } });
    const r = await geocode("123 Anywhere St");
    expect(r).toEqual({ lat: 40, lng: -75 });
    expect(urls[0]).toContain("maps.googleapis.com");
  });

  it("does NOT cache a total miss — re-queries next time (one transient miss can't poison an address)", async () => {
    const urls: string[] = [];
    mockByHost(urls, { census: censusEmpty, nominatim: [] });
    expect(await geocode("ungeocodable for now")).toBeNull();
    const afterFirst = urls.length;
    expect(await geocode("ungeocodable for now")).toBeNull();
    expect(urls.length).toBeGreaterThan(afterFirst); // tried again, not served a cached null
  });

  it("caches a success (no repeat network call)", async () => {
    const urls: string[] = [];
    mockByHost(urls, { census: census(-77.1, 39.0) });
    await geocode("111 Rockville Pike, Rockville, MD");
    const afterFirst = urls.length;
    await geocode("111 Rockville Pike, Rockville, MD");
    expect(urls.length).toBe(afterFirst); // served from cache
  });
});

describe("driveTime provider selection", () => {
  beforeEach(() => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    clearGeoCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  it("routes via keyless OSRM when no Google key is set", async () => {
    const urls: string[] = [];
    mockByHost(urls, { osrm: { routes: [{ duration: 600, distance: 8000 }] } });
    const r = await driveTime({ lat: 38.9, lng: -77.03 }, { lat: 39.0, lng: -77.1 });
    expect(r).toEqual({ seconds: 600, meters: 8000 });
    expect(urls[0]).toContain("router.project-osrm.org");
  });

  it("uses Google (traffic-aware) ONLY when the key is explicitly set", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    const urls: string[] = [];
    mockByHost(urls, {
      google: { status: "OK", routes: [{ legs: [{ duration_in_traffic: { value: 540 }, duration: { value: 600 }, distance: { value: 8000 } }] }] },
    });
    const r = await driveTime({ lat: 38.9, lng: -77.03 }, { lat: 39.0, lng: -77.1 });
    expect(r).toEqual({ seconds: 540, meters: 8000 }); // prefers duration_in_traffic
    expect(urls[0]).toContain("maps.googleapis.com");
  });
});

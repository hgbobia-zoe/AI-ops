// eventWeather orchestration tests — all with a MOCKED client + injected in-memory geocode cache, so no
// network and no DB. Verifies the honest fallbacks and that a real forecast is only returned when both
// the horizon and the location resolve.

import { describe, it, expect, vi } from "vitest";
import { eventWeather, daysUntilDate } from "./weather";
import type { GeocodeCache } from "./cache";
import type { Forecast, GeoPoint } from "./types";

const NOW = new Date("2026-06-20T12:00:00Z");

function memCache(): GeocodeCache {
  const m = new Map<string, { point: GeoPoint | null; resolved: boolean }>();
  return {
    get: (k) => m.get(k),
    set: (k, point) => void m.set(k, { point, resolved: !!point }),
  };
}

const sampleForecast = (dateISO: string): Forecast => ({
  dateISO,
  lat: 38.9,
  lon: -77.0,
  precipitationProbabilityMax: 10,
  precipitationSum: 0,
  temperatureMax: 78,
  temperatureMin: 61,
  windspeedMax: 8,
  weathercode: 1,
});

// A fetch stub that must never be called (we inject geocode/forecast directly).
const noFetch = vi.fn() as unknown as typeof fetch;

describe("eventWeather — honest fallbacks", () => {
  it("no date -> BEYOND_HORIZON (nothing to forecast)", async () => {
    const r = await eventWeather({ dateISO: null, address: "123 Main St" }, { now: NOW, fetch: noFetch });
    expect(r.status).toBe("BEYOND_HORIZON");
  });

  it("date past the 16-day horizon -> BEYOND_HORIZON", async () => {
    const r = await eventWeather(
      { dateISO: "2026-08-01", point: { lat: 1, lon: 2 } },
      { now: NOW, fetch: noFetch, forecast: async () => sampleForecast("2026-08-01") },
    );
    expect(r.status).toBe("BEYOND_HORIZON");
  });

  it("past date -> BEYOND_HORIZON", async () => {
    const r = await eventWeather(
      { dateISO: "2026-06-01", point: { lat: 1, lon: 2 } },
      { now: NOW, fetch: noFetch },
    );
    expect(r.status).toBe("BEYOND_HORIZON");
  });

  it("in-horizon but no address and no point -> LOCATION_UNKNOWN", async () => {
    const r = await eventWeather({ dateISO: "2026-06-25" }, { now: NOW, fetch: noFetch });
    expect(r.status).toBe("LOCATION_UNKNOWN");
  });

  it("geocoder returns null -> LOCATION_UNKNOWN (and caches the miss)", async () => {
    const cache = memCache();
    const geocode = vi.fn(async () => null);
    const r = await eventWeather(
      { dateISO: "2026-06-25", address: "nowhere" },
      { now: NOW, fetch: noFetch, geocode, geocodeCache: cache, forecast: async () => sampleForecast("2026-06-25") },
    );
    expect(r.status).toBe("LOCATION_UNKNOWN");
    // Second call hits the cached known-miss — geocoder not called again.
    await eventWeather(
      { dateISO: "2026-06-25", address: "nowhere" },
      { now: NOW, fetch: noFetch, geocode, geocodeCache: cache, forecast: async () => sampleForecast("2026-06-25") },
    );
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  it("forecast fetch fails -> UNAVAILABLE (never throws, never fabricates)", async () => {
    const r = await eventWeather(
      { dateISO: "2026-06-25", point: { lat: 38.9, lon: -77 } },
      { now: NOW, fetch: noFetch, forecast: async () => null },
    );
    expect(r.status).toBe("UNAVAILABLE");
  });
});

describe("eventWeather — real forecast path", () => {
  it("in-horizon + resolved point -> OK with the real forecast", async () => {
    const r = await eventWeather(
      { dateISO: "2026-06-25", point: { lat: 38.9, lon: -77 } },
      { now: NOW, fetch: noFetch, forecast: async (_p, dt) => sampleForecast(dt) },
    );
    expect(r.status).toBe("OK");
    if (r.status === "OK") expect(r.forecast.dateISO).toBe("2026-06-25");
  });

  it("geocodes an address through the cache, then forecasts", async () => {
    const cache = memCache();
    const geocode = vi.fn(async () => ({ lat: 38.9, lon: -77 }));
    const forecast = vi.fn(async (_p: GeoPoint, dt: string) => sampleForecast(dt));
    const r = await eventWeather(
      { dateISO: "2026-06-25", address: "100 Independence Ave SW, Washington, DC" },
      { now: NOW, fetch: noFetch, geocode, geocodeCache: cache, forecast },
    );
    expect(r.status).toBe("OK");
    // Second call reuses the cached geocode (geocoder called once).
    await eventWeather(
      { dateISO: "2026-06-26", address: "100 Independence Ave SW, Washington, DC" },
      { now: NOW, fetch: noFetch, geocode, geocodeCache: cache, forecast },
    );
    expect(geocode).toHaveBeenCalledTimes(1);
  });
});

describe("daysUntilDate", () => {
  it("computes whole-day differences in UTC", () => {
    expect(daysUntilDate("2026-06-20", NOW)).toBe(0);
    expect(daysUntilDate("2026-06-21", NOW)).toBe(1);
    expect(daysUntilDate("2026-06-19", NOW)).toBe(-1);
  });
});

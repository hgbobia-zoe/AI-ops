// Weather domain types — honest by construction.
//
// Governing law: RULES CALCULATE. A forecast is only ever a REAL value fetched from Open-Meteo for a
// geocoded location within the ~16-day forecast horizon. When we cannot get one, we return a TYPED
// status — never a fabricated forecast. `classifyWeatherRisk` is the only interpretation step and it is
// a pure deterministic function of a real forecast.

/** A real daily forecast for one date + location. Units are US-friendly (°F, mph, inches) because the
 *  thresholds below are tuned for a DMV outdoor-tent events company. Any field the source omitted is
 *  null (never zero-filled). */
export interface Forecast {
  /** The event date this forecast is for (YYYY-MM-DD). */
  dateISO: string;
  lat: number;
  lon: number;
  /** Max probability of precipitation across the day, 0-100 (%). */
  precipitationProbabilityMax: number | null;
  /** Total precipitation for the day, inches. */
  precipitationSum: number | null;
  /** Daily high / low, °F. */
  temperatureMax: number | null;
  temperatureMin: number | null;
  /** Max sustained wind, mph. */
  windspeedMax: number | null;
  /** WMO weather code for the day (0 clear … 95-99 thunderstorm). */
  weathercode: number | null;
}

/** Why a real forecast is not available. These are the ONLY non-forecast outcomes — the module never
 *  invents weather. */
export type WeatherUnavailableStatus = "BEYOND_HORIZON" | "LOCATION_UNKNOWN" | "UNAVAILABLE";

/** The honest result of `eventWeather`: either a real forecast, or a typed reason there isn't one. */
export type WeatherResult =
  | { status: "OK"; forecast: Forecast }
  | { status: WeatherUnavailableStatus };

/** The deterministic weather-risk verdict for an outdoor-tent event. */
export type WeatherRiskLevel = "NONE" | "WATCH" | "RISK";

export interface WeatherRisk {
  level: WeatherRiskLevel;
  /** Human-readable, each citing the threshold that fired (empty when NONE). */
  reasons: string[];
}

/** A resolved geocode (what the Census geocoder gives us for a US address). */
export interface GeoPoint {
  lat: number;
  lon: number;
}

/** Open-Meteo's forecast horizon in days. Dates beyond this (or in the past) can't be forecast by the
 *  free endpoint → BEYOND_HORIZON (we never fabricate). */
export const OPEN_METEO_HORIZON_DAYS = 16;

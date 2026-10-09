// Pure weather-risk classification for an outdoor-tent events company (DMV / US).
//
// Deterministic, no network, no DB, fully unit-tested. Given a REAL forecast it returns a NONE/WATCH/RISK
// verdict with the reasons that fired. It NEVER guesses — a null field simply doesn't trip its threshold.
//
// Thresholds (why these, for a tent/rental operation):
//   • WIND is the dominant tent hazard. Industry practice strikes/evacuates tents well below gale force;
//     20 mph gusts warrant watching, 30 mph is a real staking/stability risk. (Config below.)
//   • PRECIPITATION affects load-in/out, flooring, and guest comfort. A high chance (≥40%) is a WATCH;
//     ≥70% chance OR ≥0.5" of accumulation is a RISK.
//   • TEMPERATURE extremes stress guests and crew: ≥90°F / ≤40°F WATCH, ≥95°F / ≤32°F (freeze) RISK.
//   • WMO WEATHERCODE: thunderstorms (95-99), snow (71-77, 85-86) are a RISK; rain/drizzle a WATCH.
// All thresholds live in WEATHER_THRESHOLDS so they can be tuned without touching the logic.

import type { Forecast, WeatherRisk } from "./types";

export const WEATHER_THRESHOLDS = {
  /** Precipitation probability (%) — chance of rain over the day. */
  precipProbWatch: 40,
  precipProbRisk: 70,
  /** Precipitation accumulation (inches). */
  precipSumWatch: 0.1,
  precipSumRisk: 0.5,
  /** Sustained wind (mph) — the tent hazard. */
  windWatch: 20,
  windRisk: 30,
  /** Heat (°F). */
  heatWatch: 90,
  heatRisk: 95,
  /** Cold (°F). */
  coldWatch: 40,
  coldRisk: 32,
} as const;

// WMO weather codes (https://open-meteo.com/en/docs): grouped for our purposes.
const THUNDERSTORM = new Set([95, 96, 99]);
const SNOW = new Set([71, 73, 75, 77, 85, 86]);
const RAIN = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]);

/** Classify a real forecast into NONE/WATCH/RISK with reasons. PURE. */
export function classifyWeatherRisk(f: Forecast): WeatherRisk {
  const t = WEATHER_THRESHOLDS;
  const reasons: string[] = [];
  let risk = false;
  let watch = false;

  const flag = (isRisk: boolean, isWatch: boolean, reason: string): void => {
    if (isRisk) {
      risk = true;
      reasons.push(reason);
    } else if (isWatch) {
      watch = true;
      reasons.push(reason);
    }
  };

  if (f.precipitationProbabilityMax != null) {
    flag(
      f.precipitationProbabilityMax >= t.precipProbRisk,
      f.precipitationProbabilityMax >= t.precipProbWatch,
      `${f.precipitationProbabilityMax}% chance of precipitation`,
    );
  }
  if (f.precipitationSum != null) {
    flag(
      f.precipitationSum >= t.precipSumRisk,
      f.precipitationSum >= t.precipSumWatch,
      `${f.precipitationSum}" of precipitation expected`,
    );
  }
  if (f.windspeedMax != null) {
    flag(
      f.windspeedMax >= t.windRisk,
      f.windspeedMax >= t.windWatch,
      `winds up to ${f.windspeedMax} mph (tent hazard)`,
    );
  }
  if (f.temperatureMax != null) {
    flag(f.temperatureMax >= t.heatRisk, f.temperatureMax >= t.heatWatch, `high of ${f.temperatureMax}°F`);
  }
  if (f.temperatureMin != null) {
    flag(f.temperatureMin <= t.coldRisk, f.temperatureMin <= t.coldWatch, `low of ${f.temperatureMin}°F`);
  }
  if (f.weathercode != null) {
    if (THUNDERSTORM.has(f.weathercode)) flag(true, false, "thunderstorms in the forecast");
    else if (SNOW.has(f.weathercode)) flag(true, false, "snow in the forecast");
    else if (RAIN.has(f.weathercode)) flag(false, true, "rain in the forecast");
  }

  const level = risk ? "RISK" : watch ? "WATCH" : "NONE";
  return { level, reasons };
}

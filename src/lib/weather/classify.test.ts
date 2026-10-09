import { describe, it, expect } from "vitest";
import { classifyWeatherRisk } from "./classify";
import type { Forecast } from "./types";

function fc(over: Partial<Forecast> = {}): Forecast {
  return {
    dateISO: "2026-07-04",
    lat: 38.9,
    lon: -77.0,
    precipitationProbabilityMax: 0,
    precipitationSum: 0,
    temperatureMax: 75,
    temperatureMin: 60,
    windspeedMax: 5,
    weathercode: 0,
    ...over,
  };
}

describe("classifyWeatherRisk", () => {
  it("benign day -> NONE with no reasons", () => {
    const r = classifyWeatherRisk(fc());
    expect(r.level).toBe("NONE");
    expect(r.reasons).toHaveLength(0);
  });

  it("40% rain chance -> WATCH", () => {
    expect(classifyWeatherRisk(fc({ precipitationProbabilityMax: 45 })).level).toBe("WATCH");
  });

  it("70% rain chance -> RISK", () => {
    const r = classifyWeatherRisk(fc({ precipitationProbabilityMax: 80 }));
    expect(r.level).toBe("RISK");
    expect(r.reasons.join(" ")).toMatch(/80% chance/);
  });

  it("heavy accumulation -> RISK", () => {
    expect(classifyWeatherRisk(fc({ precipitationSum: 0.75 })).level).toBe("RISK");
  });

  it("20 mph wind -> WATCH, 30 mph -> RISK (tent hazard)", () => {
    expect(classifyWeatherRisk(fc({ windspeedMax: 22 })).level).toBe("WATCH");
    const r = classifyWeatherRisk(fc({ windspeedMax: 35 }));
    expect(r.level).toBe("RISK");
    expect(r.reasons.join(" ")).toMatch(/tent hazard/);
  });

  it("extreme heat/cold", () => {
    expect(classifyWeatherRisk(fc({ temperatureMax: 92 })).level).toBe("WATCH");
    expect(classifyWeatherRisk(fc({ temperatureMax: 98 })).level).toBe("RISK");
    expect(classifyWeatherRisk(fc({ temperatureMin: 38 })).level).toBe("WATCH");
    expect(classifyWeatherRisk(fc({ temperatureMin: 28 })).level).toBe("RISK");
  });

  it("thunderstorm/snow weathercodes -> RISK; rain -> WATCH", () => {
    expect(classifyWeatherRisk(fc({ weathercode: 95 })).level).toBe("RISK");
    expect(classifyWeatherRisk(fc({ weathercode: 73 })).level).toBe("RISK");
    expect(classifyWeatherRisk(fc({ weathercode: 61 })).level).toBe("WATCH");
  });

  it("null fields never trip a threshold (honest)", () => {
    const r = classifyWeatherRisk(
      fc({
        precipitationProbabilityMax: null,
        precipitationSum: null,
        temperatureMax: null,
        temperatureMin: null,
        windspeedMax: null,
        weathercode: null,
      }),
    );
    expect(r.level).toBe("NONE");
  });

  it("highest signal wins: a RISK wind plus a WATCH temp -> RISK", () => {
    expect(classifyWeatherRisk(fc({ windspeedMax: 35, temperatureMax: 92 })).level).toBe("RISK");
  });
});

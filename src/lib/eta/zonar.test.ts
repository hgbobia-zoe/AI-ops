import { describe, expect, it } from "vitest";
import { parsePosition } from "./zonar";

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

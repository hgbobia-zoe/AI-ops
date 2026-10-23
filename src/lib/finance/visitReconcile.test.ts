import { describe, it, expect } from "vitest";
import {
  withinRadius,
  deriveDispatchVisit,
  geofenceVisit,
  reconcileVisit,
  actualStopSpan,
  type VisitWindow,
} from "./visitReconcile";

// A venue + a nearby point + a far point (metres). WAREHOUSE-area coords for realism.
const CENTER = { lat: 39.0638628, lng: -77.1127462 };
const NEAR = { lat: 39.0640, lng: -77.1128 }; // ~20 m away
const FAR = { lat: 39.0800, lng: -77.1500 }; // ~3 km away

describe("geofence point-in-radius", () => {
  it("counts a point inside the radius and excludes one outside", () => {
    expect(withinRadius(CENTER, NEAR, 150)).toBe(true);
    expect(withinRadius(CENTER, FAR, 150)).toBe(false);
  });
  it("a zero/negative radius is never inside (no fabricated presence)", () => {
    expect(withinRadius(CENTER, CENTER, 0)).toBe(false);
  });
});

describe("dispatch visit deriver", () => {
  it("builds a LOW-confidence window from arrived→completed", () => {
    const v = deriveDispatchVisit({ stopId: "S1", routeId: "R1", txId: "TX1", arrivedAt: "2026-10-20T14:00:00Z", completedAt: "2026-10-20T14:40:00Z" });
    expect(v).not.toBeNull();
    expect(v!.source).toBe("dispatch");
    expect(v!.confidence).toBe("LOW");
    expect(v!.enterTs).toBe("2026-10-20T14:00:00Z");
    expect(v!.exitTs).toBe("2026-10-20T14:40:00Z");
  });
  it("returns null with no arrival (no crew-action evidence)", () => {
    expect(deriveDispatchVisit({ stopId: "S1", routeId: "R1" })).toBeNull();
    expect(deriveDispatchVisit({ stopId: "S1", routeId: "R1", completedAt: "2026-10-20T14:40:00Z" })).toBeNull();
  });
  it("keeps an open window (arrived, not yet completed)", () => {
    const v = deriveDispatchVisit({ stopId: "S1", routeId: "R1", arrivedAt: "2026-10-20T14:00:00Z" });
    expect(v!.enterTs).toBe("2026-10-20T14:00:00Z");
    expect(v!.exitTs).toBeNull();
  });
});

describe("geofenceVisit", () => {
  const fixes = [
    { ts: "2026-10-20T13:55:00Z", lat: FAR.lat, lng: FAR.lng }, // en route, outside
    { ts: "2026-10-20T14:02:00Z", lat: NEAR.lat, lng: NEAR.lng }, // arrived, inside
    { ts: "2026-10-20T14:20:00Z", lat: CENTER.lat, lng: CENTER.lng }, // dwelling, inside
    { ts: "2026-10-20T14:45:00Z", lat: FAR.lat, lng: FAR.lng }, // departed, outside
  ];
  it("windows from first→last inside fix with HIGH confidence for a real dwell", () => {
    const g = geofenceVisit(fixes, CENTER, 150);
    expect(g).not.toBeNull();
    expect(g!.enterTs).toBe("2026-10-20T14:02:00Z");
    expect(g!.exitTs).toBe("2026-10-20T14:20:00Z");
    expect(g!.fixCount).toBe(2);
    expect(g!.confidence).toBe("HIGH");
  });
  it("a single inside ping is MEDIUM (presence, not a dwell)", () => {
    const g = geofenceVisit([fixes[1]], CENTER, 150);
    expect(g!.confidence).toBe("MEDIUM");
    expect(g!.enterTs).toBe(g!.exitTs);
  });
  it("returns null when no fix is inside (forward-only, never fabricated)", () => {
    expect(geofenceVisit([fixes[0], fixes[3]], CENTER, 150)).toBeNull();
  });
  it("honours a time window to scope the visit", () => {
    const window = { startMs: Date.parse("2026-10-20T14:15:00Z"), endMs: Date.parse("2026-10-20T14:30:00Z") };
    const g = geofenceVisit(fixes, CENTER, 150, window);
    expect(g!.enterTs).toBe("2026-10-20T14:20:00Z");
    expect(g!.exitTs).toBe("2026-10-20T14:20:00Z");
    expect(g!.confidence).toBe("MEDIUM"); // only one fix falls in the window
  });
});

const gpsWin = (enter: string, exit: string, confidence: VisitWindow["confidence"] = "HIGH"): VisitWindow => ({ stopId: "S1", routeId: "R1", txId: "TX1", source: "gps", enterTs: enter, exitTs: exit, confidence });
const dispWin = (enter: string, exit: string | null): VisitWindow => ({ stopId: "S1", routeId: "R1", txId: "TX1", source: "dispatch", enterTs: enter, exitTs: exit, confidence: "LOW" });
const ids = { stopId: "S1", routeId: "R1", txId: "TX1" };

describe("two-evidence reconcile rule (audit §5.2)", () => {
  it("AGREE within tolerance → GPS enter → dispatch complete, HIGH, not flagged", () => {
    const gps = gpsWin("2026-10-20T14:02:00Z", "2026-10-20T14:22:00Z");
    const dispatch = dispWin("2026-10-20T14:05:00Z", "2026-10-20T14:40:00Z"); // 3 min apart
    const r = reconcileVisit(gps, dispatch, 15, ids);
    expect(r.agree).toBe(true);
    expect(r.flagged).toBe(false);
    expect(r.confidence).toBe("HIGH");
    expect(r.label).toBe("GPS_DISPATCH");
    expect(r.authoritative).toEqual({ enterTs: "2026-10-20T14:02:00Z", exitTs: "2026-10-20T14:40:00Z", source: "gps+dispatch" });
    expect(Math.round(r.discrepancyMinutes!)).toBe(3);
  });
  it("DIVERGE beyond tolerance → flagged, keeps DISPATCH window, MEDIUM", () => {
    const gps = gpsWin("2026-10-20T14:02:00Z", "2026-10-20T14:22:00Z");
    const dispatch = dispWin("2026-10-20T15:00:00Z", "2026-10-20T15:30:00Z"); // 58 min apart
    const r = reconcileVisit(gps, dispatch, 15, ids);
    expect(r.agree).toBe(false);
    expect(r.flagged).toBe(true);
    expect(r.confidence).toBe("MEDIUM");
    expect(r.label).toBe("DISPATCH_FLAGGED");
    expect(r.authoritative).toEqual({ enterTs: "2026-10-20T15:00:00Z", exitTs: "2026-10-20T15:30:00Z", source: "dispatch" });
  });
  it("GPS only → GPS_CONFIRMED, GPS window, GPS confidence", () => {
    const r = reconcileVisit(gpsWin("2026-10-20T14:02:00Z", "2026-10-20T14:22:00Z"), null, 15, ids);
    expect(r.label).toBe("GPS_CONFIRMED");
    expect(r.confidence).toBe("HIGH");
    expect(r.flagged).toBe(false);
    expect(r.authoritative).toEqual({ enterTs: "2026-10-20T14:02:00Z", exitTs: "2026-10-20T14:22:00Z", source: "gps" });
  });
  it("DISPATCH only (GPS absent) → DISPATCH_ONLY, LOW / PROVISIONAL", () => {
    const r = reconcileVisit(null, dispWin("2026-10-20T14:05:00Z", "2026-10-20T14:40:00Z"), 15, ids);
    expect(r.label).toBe("DISPATCH_ONLY");
    expect(r.confidence).toBe("LOW");
    expect(r.flagged).toBe(false);
    expect(r.authoritative!.source).toBe("dispatch");
  });
  it("neither source → NONE, no authoritative window", () => {
    const r = reconcileVisit(null, null, 15, ids);
    expect(r.label).toBe("NONE");
    expect(r.authoritative).toBeNull();
  });
});

describe("actualStopSpan — the narrow boundary into the cascade", () => {
  it("yields a span ONLY from a genuine GPS dwell", () => {
    const r = reconcileVisit(gpsWin("2026-10-20T14:02:00Z", "2026-10-20T14:22:00Z"), dispWin("2026-10-20T14:05:00Z", "2026-10-20T14:40:00Z"), 15, ids);
    expect(actualStopSpan(r)).toEqual({ enterTs: "2026-10-20T14:02:00Z", exitTs: "2026-10-20T14:22:00Z" });
  });
  it("NEVER yields a span from a dispatch-only visit", () => {
    const r = reconcileVisit(null, dispWin("2026-10-20T14:05:00Z", "2026-10-20T14:40:00Z"), 15, ids);
    expect(actualStopSpan(r)).toBeNull();
  });
  it("NEVER yields a span from a single-ping GPS window (presence, not a dwell)", () => {
    const r = reconcileVisit(gpsWin("2026-10-20T14:02:00Z", "2026-10-20T14:02:00Z", "MEDIUM"), null, 15, ids);
    expect(actualStopSpan(r)).toBeNull();
  });
});

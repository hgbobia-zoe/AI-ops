import { describe, it, expect } from "vitest";
import { recomputeVisitReconciliation } from "./visitReconcileRun";
import { writeRoute, updateStopState, saveGpsPosition, getVisitReconciliation, getGpsVisitSpans } from "@/lib/db/repo";
import { getDb } from "@/lib/db";
import type { Route } from "@/lib/types";
import type { LatLng } from "@/lib/eta/geo";

// DATABASE_PATH is ":memory:" (vitest.config.ts); tables are cleared per file.

const DAY = "2026-10-20";
const CENTER: LatLng = { lat: 39.0638628, lng: -77.1127462 };
const NEAR = { lat: 39.0640, lng: -77.1128 }; // ~20 m
const FAR = { lat: 39.2, lng: -77.4 }; // far away

// A geocoder stub: the GPS-visited stop's address resolves to CENTER; everything else resolves far away,
// so only the first stop can ever have an inside fix.
const geo = async (address: string): Promise<LatLng | null> => (address === "100 Venue Way" ? CENTER : FAR);

function seedRoute(): void {
  const route: Route = {
    routeId: "R-VR-1",
    date: DAY,
    truckId: "NPR-1",
    status: "done",
    gsRouteId: "777",
    stops: [
      { stopId: "S1", routeId: "R-VR-1", customerId: "C1", sequence: 1, state: "Completed", custName: "Alpha", kind: "delivery", custPhone: "", address: "100 Venue Way", txId: "TX-A" },
      { stopId: "S2", routeId: "R-VR-1", customerId: "C2", sequence: 2, state: "Completed", custName: "Bravo", kind: "delivery", custPhone: "", address: "200 Other Rd", txId: "TX-B" },
    ],
  };
  writeRoute(route);
  // Dispatch-reported times for both stops (server-receive).
  updateStopState("S1", "Completed", { arrivedAt: `${DAY}T18:00:00Z`, completedAt: `${DAY}T18:30:00Z` });
  updateStopState("S2", "Completed", { arrivedAt: `${DAY}T19:00:00Z`, completedAt: `${DAY}T19:20:00Z` });
  // GPS fixes for the truck: two inside the S1 geofence during its window (a real dwell), one far earlier.
  saveGpsPosition({ vehicleId: "NPR-1", lat: FAR.lat, lng: FAR.lng, ts: `${DAY}T17:00:00Z`, source: "gpstrackit" });
  saveGpsPosition({ vehicleId: "NPR-1", lat: NEAR.lat, lng: NEAR.lng, ts: `${DAY}T18:05:00Z`, source: "gpstrackit" });
  saveGpsPosition({ vehicleId: "NPR-1", lat: CENTER.lat, lng: CENTER.lng, ts: `${DAY}T18:20:00Z`, source: "gpstrackit" });
}

describe("recomputeVisitReconciliation — dispatch + geofenced GPS", () => {
  it("derives a dispatch window for every arrived stop and a GPS window only where fixes landed", async () => {
    seedRoute();
    const r = await recomputeVisitReconciliation([DAY], geo);
    expect(r.dispatchRows).toBe(2); // both stops have arrived→completed
    expect(r.gpsRows).toBe(1); // only S1 had inside fixes

    const rows = getVisitReconciliation(DAY, DAY);
    const s1 = rows.find((x) => x.stopId === "S1")!;
    const s2 = rows.find((x) => x.stopId === "S2")!;
    // S1: both sources present; GPS dwell 18:05 → 18:20.
    expect(s1.gpsEnter).toBe(`${DAY}T18:05:00Z`);
    expect(s1.gpsExit).toBe(`${DAY}T18:20:00Z`);
    expect(s1.gpsConfidence).toBe("HIGH");
    expect(s1.dispatchEnter).toBe(`${DAY}T18:00:00Z`);
    // S2: dispatch only (no GPS fix in its geofence).
    expect(s2.gpsEnter).toBeNull();
    expect(s2.dispatchEnter).toBe(`${DAY}T19:00:00Z`);
  });

  it("feeds a genuine GPS span to the cascade ONLY for the GPS-confirmed stop", async () => {
    seedRoute();
    await recomputeVisitReconciliation([DAY], geo);
    const spans = getGpsVisitSpans(["R-VR-1"]);
    expect(spans.has("S1")).toBe(true); // genuine dwell → feeds ACTUAL_STOP
    expect(spans.get("S1")).toEqual({ enterTs: `${DAY}T18:05:00Z`, exitTs: `${DAY}T18:20:00Z` });
    expect(spans.has("S2")).toBe(false); // dispatch-only → never fed
  });

  it("is idempotent — re-running produces the same rows, not duplicates", async () => {
    seedRoute();
    await recomputeVisitReconciliation([DAY], geo);
    await recomputeVisitReconciliation([DAY], geo);
    await recomputeVisitReconciliation([DAY], geo);
    const count = getDb().prepare("SELECT COUNT(*) AS n FROM visit_events").get() as { n: number };
    expect(count.n).toBe(3); // 2 dispatch + 1 gps, stable across re-runs (UNIQUE(stop_id, source))
    const spans = getGpsVisitSpans(["R-VR-1"]);
    expect(spans.get("S1")).toEqual({ enterTs: `${DAY}T18:05:00Z`, exitTs: `${DAY}T18:20:00Z` });
  });

  it("clears a GPS window that no longer derives (fixes gone) without touching the dispatch row", async () => {
    seedRoute();
    await recomputeVisitReconciliation([DAY], geo);
    expect(getGpsVisitSpans(["R-VR-1"]).has("S1")).toBe(true);
    // Remove the GPS fixes and recompute: the gps row for S1 should disappear, dispatch stays.
    getDb().prepare("DELETE FROM gps_positions").run();
    await recomputeVisitReconciliation([DAY], geo);
    expect(getGpsVisitSpans(["R-VR-1"]).has("S1")).toBe(false);
    const rows = getVisitReconciliation(DAY, DAY);
    expect(rows.find((x) => x.stopId === "S1")!.dispatchEnter).toBe(`${DAY}T18:00:00Z`); // non-destructive
  });
});

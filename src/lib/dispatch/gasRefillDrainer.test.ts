import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildOfficePullScript } from "@/lib/gsPull";

// The refill_stop op replays the calls captured live on past route 66192 (2026-11-13, route restored after).
describe("refill_stop drainer (extension) and the pull skipping our own refill waypoint", () => {
  const ext = readFileSync("extension/pull-injected.js", "utf8");

  it("the extension drains refill_stop with the captured endpoints and bodies", () => {
    expect(ext).toMatch(/refill_stop: 1/);
    expect(ext).toContain('"/app/location/saveNewLocation"');
    expect(ext).toContain("streetAddress_zipCode");
    expect(ext).toContain('"/app/routing/saveWaypoint", { locationID: loc.locationID, name: p.name, arrivalTime: p.arrivalTime, departureTime: p.departureTime, notes: "" }');
    expect(ext).toContain('"/app/routing/scheduleWaypoint", { vehicleID: route.vehicleID, routeID: route.id, routeColor: route.color, waypointID: wp.id, logisticID: null');
    expect(ext).toContain("/app/routing/deleteUnscheduledCustomStop?waypointID=");
  });

  it("both pullers skip the Goodshuffle refill waypoint so it never comes back as a blank stop", () => {
    for (const src of [ext, buildOfficePullScript("https://zoe-dispatch.fly.dev")]) {
      expect(src).toMatch(/waypointType\s*===\s*"CUSTOM"\s*&&\s*\/\^gas refill\/i\.test/);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Route, Stop, RouteStatus } from "@/lib/types";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-prune-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function repo() {
  return import("./repo");
}
async function store() {
  return import("@/lib/scheduling/store");
}

function stop(routeId: string, seq: number): Stop {
  return {
    stopId: `${routeId}-S${seq}`,
    routeId,
    customerId: `c${seq}`,
    sequence: seq,
    state: "Waiting",
    custName: "Cust",
    custPhone: "",
    address: "",
    kind: "delivery",
  };
}
function route(truckId: string, date: string, status: RouteStatus = "ready"): Route {
  const routeId = `R-${date}-${truckId}`;
  return { routeId, date, truckId, status, stops: [stop(routeId, 1)] };
}

describe("pruneStaleRoutes", () => {
  const DAY = "2026-10-15";

  it("drops a ready route GS no longer has, on a swept date", async () => {
    const { writeRoute, getRouteById, pruneStaleRoutes } = await repo();
    writeRoute(route("E450", DAY)); // still in GS
    writeRoute(route("NPR-1", DAY)); // gone from GS (stale)

    const { deleted } = pruneStaleRoutes([DAY], [`R-${DAY}-E450`]);
    expect(deleted).toEqual([`R-${DAY}-NPR-1`]);
    expect(getRouteById(`R-${DAY}-NPR-1`)).toBeNull();
    expect(getRouteById(`R-${DAY}-E450`)).not.toBeNull(); // kept
  });

  it("never prunes a date the sweep didn't cover", async () => {
    const { writeRoute, getRouteById, pruneStaleRoutes } = await repo();
    const OTHER = "2026-10-16";
    writeRoute(route("NPR-1", OTHER));
    // Sweep only covered DAY, so OTHER's route must survive even though it's not in keep.
    pruneStaleRoutes([DAY], [`R-${DAY}-E450`]);
    expect(getRouteById(`R-${OTHER}-NPR-1`)).not.toBeNull();
  });

  it("never prunes an active/done route, even when GS no longer has it", async () => {
    const { writeRoute, getRouteById, pruneStaleRoutes } = await repo();
    const D = "2026-10-17";
    writeRoute(route("E450", D)); // keep
    writeRoute(route("NPR-1", D, "active")); // in progress → protected
    pruneStaleRoutes([D], [`R-${D}-E450`]);
    expect(getRouteById(`R-${D}-NPR-1`)).not.toBeNull();
  });

  it("empty swept-dates prunes nothing (guards a failed/empty sweep)", async () => {
    const { writeRoute, getRouteById, pruneStaleRoutes } = await repo();
    const D = "2026-10-18";
    writeRoute(route("NPR-1", D));
    const { deleted } = pruneStaleRoutes([], []);
    expect(deleted).toEqual([]);
    expect(getRouteById(`R-${D}-NPR-1`)).not.toBeNull();
  });

  it("clears the orphaned derived draft shift for a pruned route, keeps a human-touched one", async () => {
    const { writeRoute, pruneStaleRoutes } = await repo();
    const { createShift, getShiftsForDate } = await store();
    const D = "2026-10-19";
    writeRoute(route("E450", D)); // keep
    writeRoute(route("NPR-1", D)); // stale
    writeRoute(route("NPR-2", D)); // stale, but its shift is human-touched
    createShift({ date: D, role: "driver", headcount: 1, routeId: `R-${D}-NPR-1`, source: "derived" });
    createShift({ date: D, role: "driver", headcount: 1, routeId: `R-${D}-NPR-2`, source: "derived", assignees: [42] });

    pruneStaleRoutes([D], [`R-${D}-E450`]);
    const shifts = getShiftsForDate(D);
    expect(shifts.some((s) => s.routeId === `R-${D}-NPR-1`)).toBe(false); // orphaned draft cleared
    expect(shifts.some((s) => s.routeId === `R-${D}-NPR-2`)).toBe(true); // human-touched kept
  });
});

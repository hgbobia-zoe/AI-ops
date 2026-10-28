import { describe, expect, it, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { writeRoute, getRouteById, getActiveRouteForTruck, getAuditForEntity } from "@/lib/db/repo";
import { runRouteHandoffTick } from "./handoffTick";
import type { Route, RouteStatus, StopState } from "@/lib/types";

// DATABASE_PATH is ":memory:" (vitest.config.ts). vitest.setup clears tables per file; clear again per test.
beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM routes").run();
  db.prepare("DELETE FROM stops").run();
  db.prepare("DELETE FROM audit_logs").run();
});

const DAY = "2026-10-02";
function seed(truckId: string, id: string, status: RouteStatus, startIso: string | undefined, states: StopState[]): void {
  const route: Route = {
    routeId: id,
    date: DAY,
    truckId,
    status,
    stops: states.map((state, i) => ({
      stopId: `${id}-s${i + 1}`,
      routeId: id,
      customerId: "C",
      sequence: i + 1,
      state,
      custName: "Cust",
      custPhone: "+15555550111",
      address: "1 Main St",
      plannedWindow: i === 0 ? startIso : undefined,
    })),
  };
  writeRoute(route);
}

// 22:45Z is inside EVE's (23:00Z) handoff window and is 2026-10-02 in ET (the ops day the tick derives).
const inWindow = new Date(`${DAY}T22:45:00.000Z`);

describe("runRouteHandoffTick", () => {
  it("Scenario A: finalizes a verified-complete earlier route a driver left open", async () => {
    seed("T1", "DAY", "active", `${DAY}T14:00:00.000Z`, ["Completed", "Returned"]);
    seed("T1", "EVE", "ready", `${DAY}T23:00:00.000Z`, ["Waiting"]);
    const r = await runRouteHandoffTick(inWindow);
    expect(r.finalized).toBe(1);
    const day = getRouteById("DAY")!;
    expect(day.status).toBe("done");
    expect(day.autoFinalizedAt).toBeTruthy();
    // And the next driver now sees EVE on the kiosk.
    expect(getActiveRouteForTruck("T1", DAY, inWindow.getTime())?.routeId).toBe("EVE");
  });

  it("Scenario B: flags (does NOT close) an unverified active earlier route and alerts on conflict", async () => {
    seed("T2", "DAY", "active", `${DAY}T14:00:00.000Z`, ["Completed", "Arrived"]);
    seed("T2", "EVE", "ready", `${DAY}T23:00:00.000Z`, ["Waiting"]);
    const r = await runRouteHandoffTick(inWindow);
    expect(r.flagged).toBe(1);
    expect(r.conflicts).toBe(1);
    const day = getRouteById("DAY")!;
    expect(day.status).toBe("active"); // preserved — never a fabricated close
    expect(day.handoffFlag).toBe("active_truck_unverified");
    // The next driver can still reach their route despite the open prior route.
    expect(getActiveRouteForTruck("T2", DAY, inWindow.getTime())?.routeId).toBe("EVE");
    expect(getAuditForEntity("route", "DAY").some((a) => a.action === "ROUTE_HANDOFF_FLAGGED")).toBe(true);
  });

  it("is idempotent — a second run makes no further changes and does not re-alert", async () => {
    seed("T3", "DAY", "active", `${DAY}T14:00:00.000Z`, ["Completed", "Arrived"]);
    seed("T3", "EVE", "ready", `${DAY}T23:00:00.000Z`, ["Waiting"]);
    await runRouteHandoffTick(inWindow);
    const second = await runRouteHandoffTick(inWindow);
    expect(second.flagged).toBe(0);
    expect(second.conflicts).toBe(0);
  });

  it("does nothing for a truck with a single route", async () => {
    seed("T4", "ONLY", "active", `${DAY}T14:00:00.000Z`, ["Arrived"]);
    const r = await runRouteHandoffTick(inWindow);
    expect(r.finalized + r.flagged + r.conflicts).toBe(0);
    expect(getRouteById("ONLY")!.status).toBe("active");
  });

  it("does nothing before the next route's window opens", async () => {
    seed("T5", "DAY", "active", `${DAY}T14:00:00.000Z`, ["Completed", "Returned"]);
    seed("T5", "EVE", "ready", `${DAY}T23:00:00.000Z`, ["Waiting"]);
    const r = await runRouteHandoffTick(new Date(`${DAY}T20:00:00.000Z`));
    expect(r.finalized + r.flagged).toBe(0);
    expect(getRouteById("DAY")!.status).toBe("active");
  });
});

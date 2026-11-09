import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { writeRoute, updateStopState } from "@/lib/db/repo";
import { closeOneRoute } from "@/lib/dispatch/closeRoute";
import type { Route, StopState } from "@/lib/types";
import { decideGsStatusWrite, gsWaypointStatusFor, syncGsRouteStatus, syncGsStopStatus, GS_STATUS_OP } from "./gsStatusSync";

// DATABASE_PATH is ":memory:" (vitest.config.ts).
let n = 0;
function seed(opts: { gs?: boolean; kind?: "delivery" | "pickup" } = {}): { routeId: string; stopId: string; stop2: string } {
  n++;
  const gsRouteId = opts.gs === false ? undefined : `9${n}`;
  const routeId = `R-2031-01-0${(n % 9) + 1}-GSS${n}${gsRouteId ? `-${gsRouteId}` : ""}`;
  const route: Route = {
    routeId,
    date: `2031-01-0${(n % 9) + 1}`,
    truckId: `GSS${n}`,
    status: "ready",
    gsRouteId,
    stops: [
      { stopId: `${routeId}-S1`, routeId, customerId: "C1", sequence: 1, state: "Waiting", custName: "Ana", custPhone: "+15555550111", address: "1 Main St", txId: `7${n}1`, kind: opts.kind ?? "delivery" },
      { stopId: `${routeId}-S2`, routeId, customerId: "C2", sequence: 2, state: "Waiting", custName: "Bo", custPhone: "+15555550112", address: "2 Main St", txId: `7${n}2`, kind: "pickup" },
    ],
  };
  writeRoute(route);
  return { routeId, stopId: `${routeId}-S1`, stop2: `${routeId}-S2` };
}

type Row = { route_id: string; stop_id: string | null; gs_route_id: string; transaction_id: string | null; status: string; payload: string };
function ops(routeId: string): Array<Row & { p: { target: string; status: string; waypointType?: string } }> {
  return (getDb().prepare("SELECT * FROM gs_outbox WHERE op = ? AND route_id = ? ORDER BY created_at, rowid").all(GS_STATUS_OP, routeId) as Row[]).map((r) => ({ ...r, p: JSON.parse(r.payload) }));
}
function move(stopId: string, state: StopState): void {
  updateStopState(stopId, state);
  syncGsStopStatus(stopId);
}

afterEach(() => {
  delete process.env.GS_STATUS_SYNC;
});

describe("gsWaypointStatusFor", () => {
  it("maps Zoe stop states to Goodshuffle waypoint statuses", () => {
    expect(gsWaypointStatusFor("Arrived")).toBe("ARRIVED");
    expect(gsWaypointStatusFor("Completed")).toBe("COMPLETED");
    expect(gsWaypointStatusFor("Returned")).toBe("COMPLETED");
    expect(gsWaypointStatusFor("Waiting")).toBe("SCHEDULED");
    expect(gsWaypointStatusFor("EnRoute")).toBeNull();
    expect(gsWaypointStatusFor("Exception")).toBeNull();
    expect(gsWaypointStatusFor("HeadingBack")).toBeNull();
  });
});

describe("decideGsStatusWrite", () => {
  it("inserts, replaces a pending op, and never re-sends what Goodshuffle already has from us", () => {
    expect(decideGsStatusWrite(null, "ARRIVED")).toBe("insert");
    expect(decideGsStatusWrite(null, "SCHEDULED", { noopFirst: ["SCHEDULED"] })).toBe("skip");
    expect(decideGsStatusWrite({ status: "pending", sent: "ARRIVED" }, "COMPLETED")).toBe("update");
    expect(decideGsStatusWrite({ status: "pending", sent: "ARRIVED" }, "ARRIVED")).toBe("skip");
    expect(decideGsStatusWrite({ status: "done", sent: "COMPLETED" }, "COMPLETED")).toBe("skip");
    expect(decideGsStatusWrite({ status: "done", sent: "COMPLETED" }, "SCHEDULED")).toBe("insert");
    expect(decideGsStatusWrite({ status: "dead", sent: "ARRIVED" }, "ARRIVED")).toBe("insert");
  });
});

describe("syncGsStopStatus", () => {
  it("queues the route start, then one live op per stop that follows the latest state", () => {
    const { routeId, stopId } = seed();
    move(stopId, "EnRoute");
    let q = ops(routeId);
    expect(q.map((o) => o.p)).toEqual([{ target: "route", status: "IN_PROGRESS" }]);
    expect(q[0].gs_route_id).toMatch(/^9\d+$/);

    move(stopId, "Arrived");
    move(stopId, "Completed"); // still pending: the arrived op is replaced, not stacked
    q = ops(routeId);
    expect(q.map((o) => [o.p.target, o.p.status])).toEqual([
      ["route", "IN_PROGRESS"],
      ["waypoint", "COMPLETED"],
    ]);
    const wp = q[1];
    expect(wp.stop_id).toBe(stopId);
    expect(wp.transaction_id).toMatch(/^7\d+1$/);
    expect(wp.p.waypointType).toBe("DROP_OFF");
  });

  it("does not re-send a status Goodshuffle already accepted, but sends a real change after it", () => {
    const { routeId, stopId } = seed();
    move(stopId, "Arrived");
    getDb().prepare("UPDATE gs_outbox SET status = 'done' WHERE route_id = ?").run(routeId);
    move(stopId, "Arrived");
    expect(ops(routeId).filter((o) => o.status === "pending")).toHaveLength(0);
    move(stopId, "Completed");
    expect(ops(routeId).filter((o) => o.status === "pending").map((o) => o.p.status)).toEqual(["COMPLETED"]);
  });

  it("tags a pickup stop so the drainer picks the PICK_UP waypoint", () => {
    const { routeId, stop2 } = seed();
    move(stop2, "Arrived");
    expect(ops(routeId).find((o) => o.p.target === "waypoint")?.p.waypointType).toBe("PICK_UP");
  });

  it("skips stops from routes that didn't come from Goodshuffle", () => {
    const { routeId, stopId } = seed({ gs: false });
    updateStopState(stopId, "Arrived");
    expect(syncGsStopStatus(stopId)).toBe("no_ids");
    expect(ops(routeId)).toHaveLength(0);
  });

  it("queues nothing when GS_STATUS_SYNC=false", () => {
    process.env.GS_STATUS_SYNC = "false";
    const { routeId, stopId } = seed();
    updateStopState(stopId, "Arrived");
    expect(syncGsStopStatus(stopId)).toBe("off");
    expect(ops(routeId)).toHaveLength(0);
  });

  it("a stop reopened before anything was sent queues no SCHEDULED op", () => {
    const { routeId, stopId } = seed();
    expect(syncGsStopStatus(stopId)).toBe("skipped");
    expect(ops(routeId).filter((o) => o.p.target === "waypoint")).toHaveLength(0);
  });
});

describe("route close and reopen", () => {
  it("closing marks the Goodshuffle route complete once; reopening undoes only a route we synced", () => {
    const { routeId, stopId } = seed();
    move(stopId, "Completed");
    closeOneRoute(routeId);
    closeOneRoute(routeId); // repeat close is a no-op
    const route = ops(routeId).filter((o) => o.p.target === "route");
    // IN_PROGRESS was still pending, so COMPLETE replaced it.
    expect(route.map((o) => o.p.status)).toEqual(["COMPLETE"]);

    getDb().prepare("UPDATE gs_outbox SET status = 'done' WHERE route_id = ?").run(routeId);
    expect(syncGsRouteStatus(routeId, "IN_PROGRESS", { onlyIfSynced: true })).toBe("queued");

    const other = seed();
    expect(syncGsRouteStatus(other.routeId, "IN_PROGRESS", { onlyIfSynced: true })).toBe("skipped");
  });
});

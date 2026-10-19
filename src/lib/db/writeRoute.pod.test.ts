import { describe, expect, it } from "vitest";
import { writeRoute, getRouteById, setStopProof, getStop } from "./repo";
import type { Route } from "@/lib/types";

// DATABASE_PATH is ":memory:" (see vitest.config.ts), so this hits a throwaway DB.
//
// Regression for the POD-WIPE-ON-RE-PULL defect: writeRoute used to DELETE every stop and re-INSERT
// with a column list that OMITTED photos_ref/signature_ref, so a re-pull of a route with a completed
// delivery silently erased its proof of delivery. writeRoute now UPSERTs per stop and COALESCEs the POD
// columns, so a re-pull preserves it.

function routeWith(stops: Route["stops"], truckId = "NPR-1", gsRouteId = "900"): Route {
  const routeId = `R-2026-08-30-${truckId}-${gsRouteId}`;
  return { routeId, date: "2026-08-30", truckId, status: "ready", gsRouteId, stops };
}

function stop(stopId: string, seq: number, overrides: Partial<Route["stops"][number]> = {}): Route["stops"][number] {
  return {
    stopId,
    routeId: "",
    customerId: `C${seq}`,
    sequence: seq,
    state: "Waiting",
    custName: `Customer ${seq}`,
    custPhone: "+15555550100",
    address: `${seq} Main St`,
    txId: `TX${seq}`,
    ...overrides,
  };
}

describe("writeRoute — proof-of-delivery survives a re-pull", () => {
  it("preserves photos_ref/signature_ref when a later write omits them", () => {
    const r = routeWith([stop(`S1`, 1, { state: "Completed" }), stop(`S2`, 2)]);
    writeRoute(r);

    // Driver completes the delivery → POD is written separately (as the action route does).
    setStopProof(`S1`, { photoIds: ["pod-photo-1", "pod-photo-2"], signatureId: "pod-sig-1" });
    expect(getStop("S1")?.photoIds).toEqual(["pod-photo-1", "pod-photo-2"]);

    // Office Auto-Pull re-pulls the SAME route (incoming stops carry NO POD, as a GS pull never does).
    writeRoute(routeWith([stop(`S1`, 1, { state: "Completed" }), stop(`S2`, 2)]));

    const after = getStop("S1");
    expect(after?.photoIds).toEqual(["pod-photo-1", "pod-photo-2"]); // was wiped before the fix
    expect(after?.signatureId).toBe("pod-sig-1");
  });

  it("lets an incoming write with POD override stored POD (COALESCE prefers excluded)", () => {
    writeRoute(routeWith([stop("S1", 1, { state: "Completed" })]));
    setStopProof("S1", { photoIds: ["old"], signatureId: "old-sig" });

    // A write that explicitly carries fresh POD (e.g. a reconciled in-progress route) wins.
    writeRoute(routeWith([stop("S1", 1, { state: "Completed", photoIds: ["new"], signatureId: "new-sig" })]));

    const after = getStop("S1");
    expect(after?.photoIds).toEqual(["new"]);
    expect(after?.signatureId).toBe("new-sig");
  });

  it("still deletes stops that are gone from the new write (no orphans)", () => {
    writeRoute(routeWith([stop("S1", 1), stop("S2", 2), stop("S3", 3)]));
    expect(getRouteById("R-2026-08-30-NPR-1-900")?.stops).toHaveLength(3);

    // Re-pull returns only two stops → the third must be removed, not linger.
    writeRoute(routeWith([stop("S1", 1), stop("S2", 2)]));
    const after = getRouteById("R-2026-08-30-NPR-1-900");
    expect(after?.stops).toHaveLength(2);
    expect(after?.stops.map((s) => s.stopId).sort()).toEqual(["S1", "S2"]);
    expect(getStop("S3")).toBeNull();
  });

  it("keeps the duplicate-stop_id self-heal and preserves the first's POD across a re-pull", () => {
    // Two incoming stops share a stop_id → the second is remapped to "<id>-d2".
    writeRoute(routeWith([stop("DUP", 1, { state: "Completed" }), stop("DUP", 2)]));
    const first = getRouteById("R-2026-08-30-NPR-1-900");
    expect(first?.stops).toHaveLength(2);
    expect(first?.stops.map((s) => s.stopId).sort()).toEqual(["DUP", "DUP-d2"]);

    setStopProof("DUP", { photoIds: ["p"], signatureId: "s" });
    writeRoute(routeWith([stop("DUP", 1, { state: "Completed" }), stop("DUP", 2)]));

    expect(getRouteById("R-2026-08-30-NPR-1-900")?.stops).toHaveLength(2);
    expect(getStop("DUP")?.photoIds).toEqual(["p"]);
  });

  it("round-trips normal fields unchanged on re-write (no behavior drift)", () => {
    writeRoute(routeWith([stop("S1", 1, { custName: "Acme", address: "1 A St", dayOfName: "Jo", dayOfPhone: "+15555550190" })]));
    writeRoute(routeWith([stop("S1", 1, { custName: "Acme Renamed", address: "2 B St" })]));
    const s = getStop("S1");
    expect(s?.custName).toBe("Acme Renamed"); // non-POD columns are overwritten by the incoming value
    expect(s?.address).toBe("2 B St");
    expect(s?.dayOfName).toBeUndefined(); // cleared because the second write omitted it (old INSERT behavior)
  });
});

import { describe, it, expect } from "vitest";
import { reconcileStops } from "./reconcile";
import type { Stop } from "@/lib/types";

const R = "R-2026-09-12-NPR-1";

function stop(over: Partial<Stop> & { stopId: string; sequence: number; state: Stop["state"] }): Stop {
  return {
    routeId: R,
    customerId: over.stopId + "-C",
    custName: "",
    custPhone: "",
    address: "",
    ...over,
  } as Stop;
}

const incoming = (over: Partial<Stop>): Partial<Stop> => over;

describe("reconcileStops", () => {
  it("full replace when nothing has started", () => {
    const { stops, keptCount } = reconcileStops(
      [],
      [incoming({ txId: "A", custName: "Ann" }), incoming({ txId: "B", custName: "Bob" })],
      R,
    );
    expect(keptCount).toBe(0);
    expect(stops.map((s) => s.custName)).toEqual(["Ann", "Bob"]);
    expect(stops.every((s) => s.state === "Waiting")).toBe(true);
    expect(stops[0].routeId).toBe(R);
  });

  it("preserves an OUT-OF-ORDER completed stop (past a Waiting gap) — no revert, POD kept", () => {
    const existing = [
      stop({ stopId: `${R}-S1`, sequence: 1, state: "Completed", txId: "A", custName: "Ann", completedAt: "t1", signatureId: "sig-A" }),
      stop({ stopId: `${R}-S2`, sequence: 2, state: "Waiting", txId: "B", custName: "Bob" }),
      stop({ stopId: `${R}-S3`, sequence: 3, state: "Completed", txId: "C", custName: "Cy", completedAt: "t3", signatureId: "sig-C" }),
    ];
    // A fresh pull still lists all three (Goodshuffle order).
    const { stops, keptCount } = reconcileStops(
      existing,
      [incoming({ txId: "A", custName: "Ann" }), incoming({ txId: "B", custName: "Bob" }), incoming({ txId: "C", custName: "Cy" })],
      R,
    );
    expect(keptCount).toBe(2);
    const byTx = Object.fromEntries(stops.map((s) => [s.txId, s]));
    // Both completed stops survive with state + POD intact.
    expect(byTx["A"].state).toBe("Completed");
    expect(byTx["A"].signatureId).toBe("sig-A");
    expect(byTx["C"].state).toBe("Completed");
    expect(byTx["C"].signatureId).toBe("sig-C");
    expect(byTx["C"].stopId).toBe(`${R}-S3`); // original stopId preserved (POD ref key)
    // Bob (still Waiting) is refreshed as upcoming, not lost.
    expect(byTx["B"].state).toBe("Waiting");
  });

  it("overlays the corrected address onto the EnRoute stop by txId even when Goodshuffle REORDERED", () => {
    const existing = [
      stop({ stopId: `${R}-S1`, sequence: 1, state: "EnRoute", txId: "A", custName: "Ann", address: "1 Old St" }),
      stop({ stopId: `${R}-S2`, sequence: 2, state: "Waiting", txId: "B", custName: "Bob" }),
    ];
    // Goodshuffle reordered: B now first, A second, and A's address was corrected.
    const { stops } = reconcileStops(
      existing,
      [incoming({ txId: "B", custName: "Bob" }), incoming({ txId: "A", custName: "Ann", address: "2 New St" })],
      R,
    );
    const enroute = stops.find((s) => s.txId === "A")!;
    expect(enroute.state).toBe("EnRoute"); // still the active stop
    expect(enroute.address).toBe("2 New St"); // corrected address reached it (matched by txId, not index)
  });

  it("drops an upcoming stop Goodshuffle removed, adds a new one, keeps completed", () => {
    const existing = [
      stop({ stopId: `${R}-S1`, sequence: 1, state: "Completed", txId: "A", custName: "Ann" }),
      stop({ stopId: `${R}-S2`, sequence: 2, state: "Waiting", txId: "B", custName: "Bob" }),
    ];
    // Pull: A still there, B removed, new D added.
    const { stops } = reconcileStops(
      existing,
      [incoming({ txId: "A", custName: "Ann" }), incoming({ txId: "D", custName: "Dee" })],
      R,
    );
    const txs = stops.map((s) => s.txId);
    expect(txs).toContain("A"); // completed kept
    expect(txs).toContain("D"); // new added
    expect(txs).not.toContain("B"); // removed dropped
    // Sequence is contiguous 1..N with no collisions.
    expect(stops.map((s) => s.sequence)).toEqual([1, 2]);
    expect(new Set(stops.map((s) => s.stopId)).size).toBe(stops.length);
  });

  it("new (upcoming) stopIds never collide with a preserved stop's original stopId", () => {
    // Driver completed only the originally-5th stop; a naive counter would regenerate an S5 clash.
    const existing = [stop({ stopId: `${R}-S5`, sequence: 5, state: "Completed", txId: "E", custName: "Eve" })];
    const { stops } = reconcileStops(
      existing,
      [incoming({ txId: "E" }), incoming({ txId: "X" }), incoming({ txId: "Y" }), incoming({ txId: "Z" })],
      R,
    );
    expect(new Set(stops.map((s) => s.stopId)).size).toBe(stops.length); // all unique
    expect(stops.find((s) => s.txId === "E")!.stopId).toBe(`${R}-S5`); // preserved
  });
});

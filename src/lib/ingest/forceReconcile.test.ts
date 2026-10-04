import { describe, it, expect } from "vitest";
import { forceReconcileStops } from "./reconcile";
import { markForceResync, consumeForceResync } from "./forceResync";
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

describe("forceReconcileStops", () => {
  it("(a) moving a stop AHEAD of an EnRoute stop resets that EnRoute stop to Waiting and puts the moved stop first", () => {
    const existing = [
      stop({ stopId: `${R}-S1`, sequence: 1, state: "EnRoute", txId: "A", custName: "Ann", arrivedAt: "t1" }),
      stop({ stopId: `${R}-S2`, sequence: 2, state: "Waiting", txId: "B", custName: "Bob" }),
    ];
    // Goodshuffle now lists B first, A second.
    const { stops, keptCount } = forceReconcileStops(
      existing,
      [incoming({ txId: "B", custName: "Bob" }), incoming({ txId: "A", custName: "Ann" })],
      R,
    );
    expect(keptCount).toBe(0);
    expect(stops.map((s) => s.txId)).toEqual(["B", "A"]); // Goodshuffle order applied
    const a = stops.find((s) => s.txId === "A")!;
    expect(a.state).toBe("Waiting"); // the EnRoute stop was redirected back to Waiting
    expect(a.arrivedAt).toBeUndefined(); // in-progress timestamp cleared
    expect(a.stopId).toBe(`${R}-S1`); // identity preserved
    expect(stops[0].txId).toBe("B"); // moved stop is first
  });

  it("(b) a Completed stop keeps its state + stopId and is repositioned to the GS slot", () => {
    const existing = [
      stop({ stopId: `${R}-S1`, sequence: 1, state: "Completed", txId: "A", custName: "Ann", completedAt: "t1", signatureId: "sig-A" }),
      stop({ stopId: `${R}-S2`, sequence: 2, state: "Waiting", txId: "B", custName: "Bob" }),
    ];
    // Goodshuffle reordered: B first, completed A second.
    const { stops, keptCount } = forceReconcileStops(
      existing,
      [incoming({ txId: "B", custName: "Bob" }), incoming({ txId: "A", custName: "Ann", address: "2 New St" })],
      R,
    );
    expect(keptCount).toBe(1);
    const a = stops.find((s) => s.txId === "A")!;
    expect(a.state).toBe("Completed"); // done state preserved
    expect(a.stopId).toBe(`${R}-S1`); // POD-ref stopId preserved
    expect(a.completedAt).toBe("t1");
    expect(a.signatureId).toBe("sig-A");
    expect(a.address).toBe("2 New St"); // mutable field still overlaid from GS
    expect(a.sequence).toBe(2); // repositioned to the GS slot
  });

  it("(c) a stop removed in GS is dropped, but a Completed stop missing from GS is preserved at the end", () => {
    const existing = [
      stop({ stopId: `${R}-S1`, sequence: 1, state: "Completed", txId: "A", custName: "Ann", signatureId: "sig-A" }),
      stop({ stopId: `${R}-S2`, sequence: 2, state: "Waiting", txId: "B", custName: "Bob" }),
    ];
    // GS now lists only a brand-new stop C. A (completed) and B (waiting) are both missing from the pull.
    const { stops, keptCount } = forceReconcileStops(existing, [incoming({ txId: "C", custName: "Cy" })], R);
    const txs = stops.map((s) => s.txId);
    expect(txs).toContain("C"); // new stop added
    expect(txs).toContain("A"); // completed preserved
    expect(txs).not.toContain("B"); // waiting removal honored (dropped)
    expect(keptCount).toBe(1);
    const a = stops.find((s) => s.txId === "A")!;
    expect(a.state).toBe("Completed");
    expect(a.signatureId).toBe("sig-A");
    expect(stops[stops.length - 1].txId).toBe("A"); // appended at the end
    // Sequence contiguous, ids unique.
    expect(stops.map((s) => s.sequence)).toEqual([1, 2]);
    expect(new Set(stops.map((s) => s.stopId)).size).toBe(stops.length);
  });

  it("(d) a brand-new GS stop is added as Waiting", () => {
    const existing = [stop({ stopId: `${R}-S1`, sequence: 1, state: "Completed", txId: "A", custName: "Ann" })];
    const { stops } = forceReconcileStops(
      existing,
      [incoming({ txId: "A", custName: "Ann" }), incoming({ txId: "N", custName: "New", address: "9 Fresh Rd" })],
      R,
    );
    const n = stops.find((s) => s.txId === "N")!;
    expect(n.state).toBe("Waiting");
    expect(n.address).toBe("9 Fresh Rd");
    expect(n.custName).toBe("New");
    // New stop id never collides with the preserved completed stop.
    expect(new Set(stops.map((s) => s.stopId)).size).toBe(stops.length);
  });

  it("new-stop ids never collide with a preserved stop whose GS position shifted", () => {
    // Completed A keeps stopId S1 but Goodshuffle moved it to slot 2; the slot-1 new stop must not reuse S1.
    const existing = [stop({ stopId: `${R}-S1`, sequence: 1, state: "Completed", txId: "A", custName: "Ann" })];
    const { stops } = forceReconcileStops(
      existing,
      [incoming({ txId: "X", custName: "Xavier" }), incoming({ txId: "A", custName: "Ann" })],
      R,
    );
    expect(new Set(stops.map((s) => s.stopId)).size).toBe(stops.length);
    expect(stops.find((s) => s.txId === "A")!.stopId).toBe(`${R}-S1`);
  });
});

describe("markForceResync / consumeForceResync", () => {
  it("set then consume true once; a second consume is false", () => {
    const id = "R-2026-10-03-FR-set-once";
    markForceResync(id);
    expect(consumeForceResync(id)).toBe(true);
    expect(consumeForceResync(id)).toBe(false);
  });

  it("an expired flag consumes false", () => {
    const id = "R-2026-10-03-FR-expired";
    const t0 = Date.parse("2026-10-03T12:00:00.000Z");
    markForceResync(id, t0);
    // 21 minutes later (TTL is 20 min) → expired.
    expect(consumeForceResync(id, t0 + 21 * 60 * 1000)).toBe(false);
  });

  it("an unarmed route consumes false", () => {
    expect(consumeForceResync("R-never-armed")).toBe(false);
  });
});

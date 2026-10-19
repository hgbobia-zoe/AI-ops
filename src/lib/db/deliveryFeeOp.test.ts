import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { enqueueGsOp, pendingDeliveryFeeOp, getGsOpStatus, ackGsOp, listPendingGsOps } from "./repo";

beforeEach(() => {
  getDb().prepare("DELETE FROM gs_outbox").run();
});

function queueFee(projectId: string, amount: number): string {
  return enqueueGsOp({
    op: "set_delivery_fee",
    transactionId: projectId,
    label: `delivery fee $${amount.toFixed(2)}`,
    payload: { amount, by: "Tester" },
  }).id;
}

describe("pendingDeliveryFeeOp (push idempotency)", () => {
  it("matches a pending op for the same project + amount", () => {
    const id = queueFee("P1", 275.5);
    const hit = pendingDeliveryFeeOp("P1", 275.5);
    expect(hit?.id).toBe(id);
  });

  it("does NOT match a different amount or a different project", () => {
    queueFee("P1", 275.5);
    expect(pendingDeliveryFeeOp("P1", 300)).toBeNull();
    expect(pendingDeliveryFeeOp("P2", 275.5)).toBeNull();
  });

  it("stops matching once the op is no longer pending (done/failed)", () => {
    const id = queueFee("P1", 275.5);
    ackGsOp(id, true);
    expect(pendingDeliveryFeeOp("P1", 275.5)).toBeNull();
  });

  it("dedupes a double-push: reusing the pending op leaves exactly one queued", () => {
    const first = queueFee("P1", 275.5);
    // Simulate the route's guard: a second push at the same amount reuses `first` instead of enqueuing.
    const dup = pendingDeliveryFeeOp("P1", 275.5);
    expect(dup?.id).toBe(first);
    const feeOps = listPendingGsOps(50).filter((o) => o.op === "set_delivery_fee");
    expect(feeOps).toHaveLength(1);
  });
});

describe("getGsOpStatus", () => {
  it("reports pending → done with the real status", () => {
    const id = queueFee("P1", 100);
    expect(getGsOpStatus(id)?.status).toBe("pending");
    ackGsOp(id, true);
    expect(getGsOpStatus(id)?.status).toBe("done");
  });

  it("records the error on a failed ack (WS03 keeps it pending for bounded retry, not instantly failed)", () => {
    const id = queueFee("P1", 100);
    ackGsOp(id, false, "no_delivery_line");
    const st = getGsOpStatus(id);
    // Under the WS03 outbox lifecycle a single ack-failure stays pending (backoff retry) with the error
    // recorded; it only dead-letters (→ "dead") after the attempt budget is exhausted.
    expect(st?.status).toBe("pending");
    expect(st?.lastError).toBe("no_delivery_line");
  });

  it("returns null for an unknown id", () => {
    expect(getGsOpStatus("nope")).toBeNull();
  });
});

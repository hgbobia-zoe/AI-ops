import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Slack transport so no network is touched and we can count posts. Both the shared builder
// test and the driver-close integration rely on this.
const slackNotify = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/notify/slack", () => ({ slackNotify: (t: string) => slackNotify(t) }));
// Fan-out is fire-and-forget network work; stub it so the action route under test stays hermetic.
vi.mock("@/lib/notify/fanout", () => ({ runFanout: vi.fn(async () => {}) }));

import { rescheduleAlertLine, type CloseOneResult } from "./closeRoute";
import { writeRoute } from "@/lib/db/repo";
import type { Route } from "@/lib/types";

describe("rescheduleAlertLine (shared close-path alert builder)", () => {
  it("returns a line naming the unfinished stops", () => {
    const result: CloseOneResult = {
      ok: true,
      truckId: "NPR-1",
      incomplete: [
        { stopId: "S1", sequence: 1, custName: "Acme", state: "Waiting" },
        { stopId: "S2", sequence: 2, custName: "", state: "EnRoute" },
      ],
    };
    const line = rescheduleAlertLine(result, "the driver");
    expect(line).toContain("NPR-1 route closed by the driver with 2 unfinished stops");
    expect(line).toContain("needs rescheduling");
    expect(line).toContain("#1 Acme (Waiting)");
    expect(line).toContain("#2 — (EnRoute)");
  });

  it("returns null when the close was clean or a repeat", () => {
    expect(rescheduleAlertLine({ ok: true, truckId: "NPR-1", incomplete: [] }, "the driver")).toBeNull();
    expect(
      rescheduleAlertLine({ ok: true, already: true, truckId: "NPR-1", incomplete: [{ stopId: "S1", sequence: 1, custName: "Acme", state: "Waiting" }] }, "the driver"),
    ).toBeNull();
  });
});

function routeWithHeadingBack(): Route {
  const routeId = "R-2026-08-30-NPR-1-700";
  return {
    routeId,
    date: "2026-08-30",
    truckId: "NPR-1",
    status: "active",
    gsRouteId: "700",
    stops: [
      { stopId: "S1", routeId, customerId: "C1", sequence: 1, state: "Waiting", custName: "Unfinished Co", custPhone: "+15555550111", address: "1 Oak St", txId: "TX1" },
      { stopId: "S2", routeId, customerId: "C2", sequence: 2, state: "HeadingBack", custName: "Done Co", custPhone: "+15555550122", address: "2 Oak St", txId: "TX2" },
    ],
  };
}

describe("driver ARRIVED_WAREHOUSE close fires the rescheduling alert (defect #2)", () => {
  beforeEach(() => slackNotify.mockClear());
  afterEach(() => vi.clearAllMocks());

  async function postAction(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/action/route");
    return POST(new Request("http://localhost/api/action", { method: "POST", body: JSON.stringify(body) }));
  }

  it("Slacks the unfinished stops when the driver closes the route from the tablet", async () => {
    writeRoute(routeWithHeadingBack());
    const res = await postAction({
      idempotencyKey: "idem-warehouse-1",
      action: "ARRIVED_WAREHOUSE",
      fromState: "HeadingBack",
      stopId: "S2",
      routeId: "R-2026-08-30-NPR-1-700",
      truckId: "NPR-1",
    });
    expect(res.status).toBe(200);
    expect(slackNotify).toHaveBeenCalledTimes(1);
    expect(slackNotify.mock.calls[0][0]).toContain("needs rescheduling");
    expect(slackNotify.mock.calls[0][0]).toContain("Unfinished Co");
    expect(slackNotify.mock.calls[0][0]).toContain("closed by the driver");
  });

  it("does NOT Slack when the route closed with every stop finished", async () => {
    const routeId = "R-2026-08-30-NPR-1-701";
    writeRoute({
      routeId,
      date: "2026-08-30",
      truckId: "NPR-1",
      status: "active",
      gsRouteId: "701",
      stops: [
        { stopId: "T1", routeId, customerId: "C1", sequence: 1, state: "Completed", custName: "Done A", custPhone: "+1", address: "a", txId: "X1" },
        { stopId: "T2", routeId, customerId: "C2", sequence: 2, state: "HeadingBack", custName: "Done B", custPhone: "+1", address: "b", txId: "X2" },
      ],
    });
    const res = await postAction({
      idempotencyKey: "idem-warehouse-2",
      action: "ARRIVED_WAREHOUSE",
      fromState: "HeadingBack",
      stopId: "T2",
      routeId,
      truckId: "NPR-1",
    });
    expect(res.status).toBe(200);
    expect(slackNotify).not.toHaveBeenCalled();
  });
});

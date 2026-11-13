import { describe, expect, it, vi } from "vitest";

// Side effects of an import that this test doesn't exercise.
vi.mock("@/lib/notify/routeRisk", () => ({ alertRouteRisks: vi.fn(async () => {}) }));
vi.mock("@/lib/risk/scan", () => ({ scheduleScanSoon: vi.fn() }));
vi.mock("@/lib/eta/preMintTick", () => ({ runEtaPreMintTick: vi.fn(async () => {}) }));
vi.mock("@/lib/comms/openphoneSync", () => ({ syncActiveLeadTextThreads: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/slack", () => ({ slackNotify: vi.fn(async () => ({ ok: true })) }));
// No network: the drive time is unknown, so the 30 minute fallback applies.
vi.mock("@/lib/eta/geo", () => ({ geocode: vi.fn(async () => null), driveTime: vi.fn(async () => null) }));

import { POST } from "./route";
import { getRouteById, updateStopState } from "@/lib/db/repo";
import { isRefillStop } from "@/lib/dispatch/gasRefill";

const D = "2031-02-03"; // EST
const pull = (stops: Array<Record<string, unknown>>) =>
  POST(new Request("http://localhost/api/route/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ truckId: "NPR-1", date: D, gsRouteId: "77001", stops }) }));
const delivery = { custName: "Lee", custPhone: "+13015550101", address: "2 Oak St, Rockville, MD", kind: "delivery", plannedWindow: `${D}T09:00:00.000-05:00`, txId: "T9", items: [{ name: "Chair" }] };
const heaterPickup = { custName: "Jones Wedding", custPhone: "+13015550100", address: "1 Main St, Bethesda, MD", kind: "pickup", plannedWindow: `${D}T14:00:00.000-05:00`, plannedOnSiteMin: 45, txId: "T1", items: [{ name: "Patio Heater", quantity: 2 }] };
const RID = `R-${D}-NPR-1-77001`;

describe("route import places the gas refill stop and keeps it across re-pulls", () => {
  it("adds it last, re-pulls never duplicate or drop it, and a completed one survives", async () => {
    expect((await pull([delivery, heaterPickup])).status).toBe(200);
    let r = getRouteById(RID)!;
    expect(r.stops.map((s) => s.custName)).toEqual(["Lee", "Jones Wedding", "Gas refill: Patio Heater x2"]);
    const gas = r.stops.find(isRefillStop)!;
    expect(gas.plannedWindow).toBe(new Date(`${D}T15:15:00.000-05:00`).toISOString()); // 2:45 PM + 30 min fallback

    await pull([delivery, heaterPickup]);
    await pull([delivery, heaterPickup]);
    r = getRouteById(RID)!;
    expect(r.stops.filter(isRefillStop)).toHaveLength(1);

    // The driver finishes it, then Goodshuffle re-sends the route: it stays done.
    updateStopState(gas.stopId, "Completed");
    await pull([delivery, heaterPickup]);
    expect(getRouteById(RID)!.stops.find(isRefillStop)?.state).toBe("Completed");
  });
});

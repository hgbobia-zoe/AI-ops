import { describe, expect, it, vi } from "vitest";
import type { Stop } from "@/lib/types";
import { applyGasRefill, type GasRefillDeps } from "./gasRefillApply";
import { DEFAULT_GAS_REFILL, gasTaskDedupeKey, isRefillStop } from "./gasRefill";

const D = "2031-01-06"; // EST
const R = "R-2031-01-06-NPR-1-7";
const pickupAt = (hm: string, txId: string | null = "T1"): Stop => ({
  stopId: `${R}-S1`, routeId: R, customerId: "c", sequence: 1, state: "Waiting", custName: "Jones Wedding", custPhone: "+13015550100",
  address: "1 Main St, Bethesda, MD", kind: "pickup", plannedWindow: `${D}T${hm}:00.000-05:00`, plannedOnSiteMin: 45, txId: txId ?? undefined,
  items: [{ name: "Patio Heater", quantity: 2 }],
});

function deps(over: Partial<GasRefillDeps> = {}): GasRefillDeps & { queued: unknown[]; posts: string[] } {
  const queued: unknown[] = [];
  const posts: string[] = [];
  const keys = new Set<string>();
  return {
    queued,
    posts,
    settings: () => DEFAULT_GAS_REFILL,
    driveMinutes: async () => 20,
    taskExists: (k) => keys.has(k),
    queueTask: (t) => {
      keys.add(t.dedupeKey);
      queued.push(t);
    },
    notify: async (text) => {
      posts.push(text);
    },
    audit: () => {},
    ...over,
  };
}

describe("applyGasRefill on a route import", () => {
  it("in time: adds the refill stop, queues nothing", async () => {
    const d = deps();
    const stops = await applyGasRefill({ routeId: R, date: D, truckId: "NPR-1", stops: [pickupAt("14:00")] }, d);
    expect(stops.filter(isRefillStop)).toHaveLength(1);
    expect(d.queued).toHaveLength(0);
    expect(d.posts).toHaveLength(0);
  });

  it("too late: no stop, one next-day Goodshuffle task and one Slack post, even across re-pulls", async () => {
    const d = deps();
    for (let i = 0; i < 3; i++) {
      const stops = await applyGasRefill({ routeId: R, date: D, truckId: "NPR-1", stops: [pickupAt("19:00")] }, d);
      expect(stops.some(isRefillStop)).toBe(false);
    }
    expect(d.queued).toEqual([
      expect.objectContaining({ transactionId: "T1", routeId: R, dueDate: "2031-01-07", dedupeKey: gasTaskDedupeKey(R), title: "Refill the gas tanks from the NPR-1 route on 2031-01-06" }),
    ]);
    expect(d.posts).toHaveLength(1);
    expect(d.posts[0]).toContain("Refill tomorrow");
    expect(d.posts[0]).toContain("Patio Heater x2");
    expect(d.posts[0]).toContain("8:00 PM");
    expect(d.posts[0]).not.toMatch(/—|–/); // house style: no dashes
  });

  it("too late with no Goodshuffle project: still tells dispatch in Slack", async () => {
    const d = deps();
    await applyGasRefill({ routeId: R, date: D, truckId: "NPR-1", stops: [pickupAt("19:00", null)] }, d);
    expect(d.queued).toHaveLength(0);
    expect(d.posts[0]).toContain("refill them tomorrow by hand");
  });

  it("only looks up drive time when there is a tank, and GAS_REFILL=false turns it off", async () => {
    const drive = vi.fn(async () => 20);
    const noGas = { ...pickupAt("14:00"), items: [{ name: "Round Table" }] };
    await applyGasRefill({ routeId: R, date: D, truckId: "NPR-1", stops: [noGas] }, deps({ driveMinutes: drive }));
    expect(drive).not.toHaveBeenCalled();
    process.env.GAS_REFILL = "false";
    try {
      const stops = await applyGasRefill({ routeId: R, date: D, truckId: "NPR-1", stops: [pickupAt("14:00")] }, deps());
      expect(stops.some(isRefillStop)).toBe(false);
    } finally {
      delete process.env.GAS_REFILL;
    }
  });
});

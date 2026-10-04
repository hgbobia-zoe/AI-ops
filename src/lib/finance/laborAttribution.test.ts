import { describe, it, expect } from "vitest";
import { attributeLabor, instaworkPremium, type AttribRoute, type WorkerShiftCost } from "./laborAttribution";
import type { LaborAttributionConfig } from "./config";

// Base config with carve-offs OFF so a test can isolate the customer split; individual tests opt in.
const baseCfg = (over: Partial<LaborAttributionConfig> = {}): LaborAttributionConfig => ({
  travelFractionL3: 0,
  warehouseFromBuffers: false,
  loadWeightByItems: false,
  loadBufferMin: 60,
  returnBufferMin: 60,
  ...over,
});

const route = (routeId: string, stops: AttribRoute["stops"], o: Partial<AttribRoute> = {}): AttribRoute => ({
  routeId,
  date: "2026-10-01",
  stops,
  windowHours: o.windowHours ?? null,
  rawHours: o.rawHours ?? null,
  bufferHours: o.bufferHours ?? null,
});

const worker = (o: Partial<WorkerShiftCost> & { workerKey: string; routesServed: string[] }): WorkerShiftCost => ({
  kind: "internal",
  hours: 8,
  rate: 25,
  cost: 200,
  status: "ACTUAL",
  ...o,
});

const sumAmounts = (es: { amount: number | null }[]): number => es.reduce((a, e) => a + (e.amount ?? 0), 0);

describe("attributeLabor — L0 route-duration split", () => {
  it("splits a shift across routes by DURATION share, not evenly", () => {
    const routes = [route("R1", [{ txId: "A" }], { windowHours: 8 }), route("R2", [{ txId: "B" }], { windowHours: 2 })];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1", "R2"], hours: 10, cost: 100 })] });
    const r1 = r.entries.filter((e) => e.routeId === "R1");
    const r2 = r.entries.filter((e) => e.routeId === "R2");
    expect(sumAmounts(r1)).toBeCloseTo(80, 1); // 8/10
    expect(sumAmounts(r2)).toBeCloseTo(20, 1); // 2/10
    expect(sumAmounts(r.entries)).toBeCloseTo(100, 1); // reconciles to the shift
  });

  it("even-splits when no durations are known", () => {
    const routes = [route("R1", [{ txId: "A" }]), route("R2", [{ txId: "B" }])];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1", "R2"], hours: 8, cost: 100 })] });
    expect(sumAmounts(r.entries.filter((e) => e.routeId === "R1"))).toBeCloseTo(50, 1);
    expect(sumAmounts(r.entries.filter((e) => e.routeId === "R2"))).toBeCloseTo(50, 1);
  });
});

describe("attributeLabor — bucket carve-off", () => {
  it("carves warehouse (buffer) + travel BEFORE the customer split", () => {
    const routes = [route("R1", [{ txId: "A" }], { windowHours: 10, rawHours: 8, bufferHours: 2 })];
    const cfg = baseCfg({ warehouseFromBuffers: true, travelFractionL3: 0.2 });
    const r = attributeLabor({ date: "2026-10-01", routes, cfg, workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1"], hours: 10, cost: 100 })] });
    const by = (b: string) => sumAmounts(r.entries.filter((e) => e.bucket === b));
    expect(by("warehouse")).toBeCloseTo(20, 1); // 2/10 buffer
    expect(by("travel")).toBeCloseTo(16, 1); // 0.8 * 0.2
    expect(by("customer")).toBeCloseTo(64, 1); // 0.8 - 0.16
    expect(sumAmounts(r.entries)).toBeCloseTo(100, 1); // nothing lost
    // customer leaf is ESTIMATED (planned/derived), never fake ACTUAL
    expect(r.entries.find((e) => e.bucket === "customer")!.amountStatus).toBe("ESTIMATED");
    expect(r.entries.find((e) => e.bucket === "customer")!.eventId).toBe("A");
    expect(r.entries.find((e) => e.bucket === "warehouse")!.eventId).toBeUndefined(); // never on a project
  });

  it("a prep worker's whole slice is warehouse/prep, never a project", () => {
    const routes = [route("R1", [{ txId: "A" }], { windowHours: 8, rawHours: 6, bufferHours: 2 })];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg({ warehouseFromBuffers: true }), workerShiftCosts: [worker({ workerKey: "ct:9", role: "prep", routesServed: ["R1"], hours: 8, cost: 160 })] });
    expect(r.entries.every((e) => e.bucket === "prep")).toBe(true);
    expect(r.entries.every((e) => e.eventId == null)).toBe(true);
    expect(sumAmounts(r.entries)).toBeCloseTo(160, 1);
  });

  it("a route with no identified project puts the customer window into UNALLOCATED, never a project", () => {
    const routes = [route("R1", [{}], { windowHours: 8, rawHours: 6, bufferHours: 2 })];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg({ warehouseFromBuffers: true }), workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1"], hours: 8, cost: 100 })] });
    expect(r.entries.some((e) => e.bucket === "customer")).toBe(false);
    expect(sumAmounts(r.entries.filter((e) => e.bucket === "unallocated"))).toBeCloseTo(75, 1); // 6/8
    expect(sumAmounts(r.entries)).toBeCloseTo(100, 1);
  });
});

describe("attributeLabor — L3 planned stop-share + L2 derived", () => {
  it("L3: splits the customer remainder across projects by stop share", () => {
    const routes = [route("R1", [{ txId: "A" }, { txId: "A" }, { txId: "B" }])];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1"], hours: 8, cost: 100 })] });
    const a = r.entries.find((e) => e.eventId === "A")!;
    const b = r.entries.find((e) => e.eventId === "B")!;
    expect(a.amount).toBeCloseTo((100 * 2) / 3, 1);
    expect(b.amount).toBeCloseTo((100 * 1) / 3, 1);
    expect(a.method).toBe("PLANNED");
    expect(a.confidence).toBe("LOW");
  });

  it("L2: uses arrived→completed durations when every stop has them (DERIVED, MEDIUM)", () => {
    const routes = [
      route("R1", [
        { txId: "A", arrivedAt: "2026-10-01T10:00:00Z", completedAt: "2026-10-01T11:00:00Z" }, // 1h
        { txId: "B", arrivedAt: "2026-10-01T12:00:00Z", completedAt: "2026-10-01T15:00:00Z" }, // 3h
      ]),
    ];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1"], hours: 8, cost: 100 })] });
    expect(r.entries.find((e) => e.eventId === "A")!.amount).toBeCloseTo(25, 1); // 1/4
    expect(r.entries.find((e) => e.eventId === "B")!.amount).toBeCloseTo(75, 1); // 3/4
    expect(r.entries.find((e) => e.eventId === "A")!.method).toBe("DERIVED_STOP");
    expect(r.entries.find((e) => e.eventId === "A")!.amountStatus).toBe("ESTIMATED"); // derived, not actual
  });
});

describe("attributeLabor — reconciliation + no double-count", () => {
  it("every worker's leaves sum back to the shift cost (balanced)", () => {
    const routes = [route("R1", [{ txId: "A" }, { txId: "B" }], { windowHours: 10, rawHours: 8, bufferHours: 2 }), route("R2", [{ txId: "C" }], { windowHours: 5, rawHours: 4, bufferHours: 1 })];
    const r = attributeLabor({
      date: "2026-10-01",
      routes,
      cfg: baseCfg({ warehouseFromBuffers: true, travelFractionL3: 0.15 }),
      workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1", "R2"], hours: 15, cost: 375 }), worker({ workerKey: "iw:g1:Sam", kind: "instawork", routesServed: ["R1"], hours: 8, rate: 40, cost: 320, status: "PLANNED" })],
    });
    for (const row of r.reconciliation) expect(row.balanced).toBe(true);
    expect(r.reconciliation.find((x) => x.workerKey === "ct:1")!.residual).toBeCloseTo(0, 2);
    expect(sumAmounts(r.entries)).toBeCloseTo(375 + 320, 1); // both shifts, each counted once
  });

  it("a temp gig matched to several routes is single-counted (partitioned, not per-route)", () => {
    const routes = [route("R1", [{ txId: "A" }], { windowHours: 6 }), route("R2", [{ txId: "B" }], { windowHours: 6 })];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "iw:g1:Sam", kind: "instawork", routesServed: ["R1", "R2"], hours: 8, rate: 40, cost: 320, status: "PLANNED" })] });
    expect(sumAmounts(r.entries)).toBeCloseTo(320, 1); // NOT 640
    expect(r.reconciliation[0].balanced).toBe(true);
  });

  it("unknown cost → UNAVAILABLE leaves (never 0), reconciliation still balanced", () => {
    const routes = [route("R1", [{ txId: "A" }])];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1"], hours: 8, rate: null, cost: null })] });
    expect(r.entries.every((e) => e.amount === null && e.amountStatus === "UNAVAILABLE")).toBe(true);
    expect(r.reconciliation[0].balanced).toBe(true);
  });

  it("a shift tied to no route is fully UNALLOCATED, never forced onto a project", () => {
    const r = attributeLabor({ date: "2026-10-01", routes: [], cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: [], hours: 8, cost: 200 })] });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].bucket).toBe("unallocated");
    expect(r.entries[0].amount).toBeCloseTo(200, 1);
  });

  it("delivery AND pickup visits both carry labor to the same project (not a double-count)", () => {
    const routes = [route("R1", [{ txId: "A", kind: "delivery" }]), route("R2", [{ txId: "A", kind: "pickup" }])];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1", "R2"], hours: 8, cost: 100 })] });
    const aLeaves = r.entries.filter((e) => e.eventId === "A");
    expect(aLeaves).toHaveLength(2); // one per route visit
    expect(sumAmounts(aLeaves)).toBeCloseTo(100, 1);
  });
});

describe("instaworkPremium", () => {
  it("premium = temp cost − same hours at measured internal rate; never hardcoded", () => {
    const { equivalentInternalCost, premium } = instaworkPremium(320, 8, 25);
    expect(equivalentInternalCost).toBeCloseTo(200, 1);
    expect(premium).toBeCloseTo(120, 1);
  });
  it("null when either side unknown", () => {
    expect(instaworkPremium(320, 8, null).premium).toBeNull();
    expect(instaworkPremium(null, 8, 25).premium).toBeNull();
  });
});

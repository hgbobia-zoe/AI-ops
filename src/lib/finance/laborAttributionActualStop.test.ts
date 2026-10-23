import { describe, it, expect } from "vitest";
import { attributeLabor, type AttribRoute, type WorkerShiftCost } from "./laborAttribution";
import type { LaborAttributionConfig } from "./config";

// FI Stage 4 — the ACTUAL_STOP feed. These tests guard the CRITICAL correctness boundary: feeding a
// genuine GPS-derived on-stop span lifts a route's customer split to ACTUAL_STOP, WITHOUT changing the
// partition/allocation math, and a dispatch-only route NEVER becomes ACTUAL_STOP/ACTUAL.

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

describe("ACTUAL_STOP feed — additive, math unchanged", () => {
  it("allocation totals for a NON-GPS (dispatch/derived) input are the exact pre-change figures", () => {
    // Two derived stops (arrived→completed spans present, NO GPS actual span) on a carved route.
    const routes = [
      route(
        "R1",
        [
          { txId: "A", arrivedAt: "2026-10-01T14:00:00Z", completedAt: "2026-10-01T14:30:00Z" }, // 1800 s
          { txId: "B", arrivedAt: "2026-10-01T15:00:00Z", completedAt: "2026-10-01T15:10:00Z" }, // 600 s
        ],
        { windowHours: 10, rawHours: 8, bufferHours: 2 },
      ),
    ];
    const cfg = baseCfg({ warehouseFromBuffers: true, travelFractionL3: 0.2 });
    const r = attributeLabor({ date: "2026-10-01", routes, cfg, workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1"], hours: 10, cost: 100 })] });
    const by = (b: string) => sumAmounts(r.entries.filter((e) => e.bucket === b));
    expect(by("warehouse")).toBeCloseTo(20, 2); // 2/10 buffer
    expect(by("travel")).toBeCloseTo(16, 2); // 0.8 * 0.2
    expect(by("customer")).toBeCloseTo(64, 2); // 0.8 - 0.16
    // Customer split is DERIVED (arrived→completed), weighted by the 1800:600 span ratio → A=48, B=16.
    const cust = r.entries.filter((e) => e.bucket === "customer");
    expect(cust.every((e) => e.method === "DERIVED_STOP")).toBe(true);
    expect(cust.find((e) => e.eventId === "A")!.amount).toBeCloseTo(48, 2);
    expect(cust.find((e) => e.eventId === "B")!.amount).toBeCloseTo(16, 2);
    expect(sumAmounts(r.entries)).toBeCloseTo(100, 2); // conserved
    expect(r.reconciliation[0].balanced).toBe(true);
    expect(r.reconciliation[0].residual).toBeCloseTo(0, 2);
  });

  it("is BYTE-FOR-BYTE identical whether the GPS fields are absent or explicitly undefined", () => {
    const stopsAbsent: AttribRoute["stops"] = [
      { txId: "A", arrivedAt: "2026-10-01T14:00:00Z", completedAt: "2026-10-01T14:30:00Z" },
      { txId: "B", arrivedAt: "2026-10-01T15:00:00Z", completedAt: "2026-10-01T15:10:00Z" },
    ];
    const stopsUndef: AttribRoute["stops"] = stopsAbsent.map((s) => ({ ...s, actualEnterAt: undefined, actualExitAt: undefined }));
    const cfg = baseCfg({ warehouseFromBuffers: true, travelFractionL3: 0.2 });
    const w = [worker({ workerKey: "ct:1", routesServed: ["R1"], hours: 10, cost: 100 })];
    const a = attributeLabor({ date: "2026-10-01", routes: [route("R1", stopsAbsent, { windowHours: 10, rawHours: 8, bufferHours: 2 })], cfg, workerShiftCosts: w });
    const b = attributeLabor({ date: "2026-10-01", routes: [route("R1", stopsUndef, { windowHours: 10, rawHours: 8, bufferHours: 2 })], cfg, workerShiftCosts: w });
    expect(b).toEqual(a);
  });
});

describe("ACTUAL_STOP feed — only a genuine GPS dwell lifts the method", () => {
  it("GPS-complete route (every stop has an actual span) → ACTUAL_STOP / HIGH", () => {
    const routes = [
      route("R1", [
        { txId: "A", arrivedAt: "2026-10-01T14:00:00Z", completedAt: "2026-10-01T14:30:00Z", actualEnterAt: "2026-10-01T14:00:00Z", actualExitAt: "2026-10-01T14:30:00Z" }, // 1800 s
        { txId: "B", arrivedAt: "2026-10-01T15:00:00Z", completedAt: "2026-10-01T15:10:00Z", actualEnterAt: "2026-10-01T15:00:00Z", actualExitAt: "2026-10-01T15:10:00Z" }, // 600 s
      ]),
    ];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1"], hours: 8, cost: 240 })] });
    const cust = r.entries.filter((e) => e.bucket === "customer");
    expect(cust.every((e) => e.method === "ACTUAL_STOP")).toBe(true);
    expect(cust.every((e) => e.confidence === "HIGH")).toBe(true);
    // Weighted by the GPS dwell seconds 1800:600 (= 3:1) → A=180, B=60.
    expect(cust.find((e) => e.eventId === "A")!.amount).toBeCloseTo(180, 2);
    expect(cust.find((e) => e.eventId === "B")!.amount).toBeCloseTo(60, 2);
    expect(sumAmounts(r.entries)).toBeCloseTo(240, 2); // still conserved
  });

  it("ANY stop missing an actual span → stays DERIVED (never ACTUAL_STOP)", () => {
    const routes = [
      route("R1", [
        { txId: "A", arrivedAt: "2026-10-01T14:00:00Z", completedAt: "2026-10-01T14:30:00Z", actualEnterAt: "2026-10-01T14:00:00Z", actualExitAt: "2026-10-01T14:30:00Z" },
        { txId: "B", arrivedAt: "2026-10-01T15:00:00Z", completedAt: "2026-10-01T15:10:00Z" }, // no GPS span
      ]),
    ];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1"], hours: 8, cost: 240 })] });
    expect(r.entries.filter((e) => e.bucket === "customer").every((e) => e.method === "DERIVED_STOP")).toBe(true);
  });

  it("DISPATCH-ONLY never yields ACTUAL_STOP or an ACTUAL amount, even for an ACTUAL-status worker", () => {
    const routes = [route("R1", [{ txId: "A", arrivedAt: "2026-10-01T14:00:00Z", completedAt: "2026-10-01T14:30:00Z" }])];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1"], status: "ACTUAL", cost: 100 })] });
    const cust = r.entries.filter((e) => e.bucket === "customer");
    expect(cust.every((e) => e.method === "DERIVED_STOP")).toBe(true);
    expect(cust.every((e) => e.method !== "ACTUAL_STOP")).toBe(true);
    expect(cust.every((e) => e.amountStatus === "ESTIMATED")).toBe(true); // never ACTUAL without an on-stop clock
  });
});

describe("ACTUAL_STOP feed — amount honesty (method vs amount_status)", () => {
  it("ACTUAL_STOP method with a PLANNED worker is still ESTIMATED dollars (hours are scheduled)", () => {
    const routes = [route("R1", [{ txId: "A", actualEnterAt: "2026-10-01T14:00:00Z", actualExitAt: "2026-10-01T14:30:00Z" }])];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "iw:1", routesServed: ["R1"], kind: "instawork", status: "PLANNED", cost: 100 })] });
    const cust = r.entries.find((e) => e.bucket === "customer")!;
    expect(cust.method).toBe("ACTUAL_STOP");
    expect(cust.amountStatus).toBe("ESTIMATED");
  });
  it("ACTUAL_STOP method with an ACTUAL worker + real rate yields ACTUAL dollars", () => {
    const routes = [route("R1", [{ txId: "A", actualEnterAt: "2026-10-01T14:00:00Z", actualExitAt: "2026-10-01T14:30:00Z" }])];
    const r = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg(), workerShiftCosts: [worker({ workerKey: "ct:1", routesServed: ["R1"], status: "ACTUAL", cost: 100 })] });
    const cust = r.entries.find((e) => e.bucket === "customer")!;
    expect(cust.method).toBe("ACTUAL_STOP");
    expect(cust.amountStatus).toBe("ACTUAL");
  });
});

import { describe, it, expect } from "vitest";
import { internalShiftCostsFromAssignments } from "./internalLabor";
import { attributeLabor, type AttribRoute } from "./laborAttribution";
import type { LaborAttributionConfig } from "./config";
import type { ShiftAssignment, StaffShift } from "@/lib/scheduling/types";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────
type ShiftFacts = Pick<StaffShift, "id" | "routeId" | "startTime" | "endTime" | "windowKnown">;

const shift = (id: string, o: Partial<ShiftFacts> = {}): ShiftFacts => ({
  id,
  routeId: o.routeId ?? null,
  startTime: o.startTime ?? "2026-10-01T08:00:00Z",
  endTime: o.endTime ?? "2026-10-01T16:00:00Z", // 8h default window
  windowKnown: o.windowKnown ?? true,
});

const asg = (shiftId: string, o: Partial<ShiftAssignment> & { connecteamUserId?: number } = {}): ShiftAssignment => ({
  id: `SA-${shiftId}-${o.connecteamUserId ?? 0}`,
  shiftId,
  workerKind: o.workerKind ?? "internal",
  connecteamUserId: o.connecteamUserId ?? null,
  instaworkWorker: o.instaworkWorker ?? null,
  instaworkGigId: null,
  displayName: o.displayName ?? null,
  role: o.role ?? "driver",
  state: o.state ?? "ASSIGNED",
  packetVersion: null,
  packetSentAt: null,
  confirmedAt: null,
  confirmMethod: null,
  clockInAt: null,
  clockOutAt: null,
  clockSource: null,
  noShow: false,
  tempReason: null,
  routeReason: null,
  estHours: null,
  estRate: null,
  estCost: null,
  overridden: false,
  overrideReason: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
});

const map = (entries: [string, ShiftAssignment[]][]): Map<string, ShiftAssignment[]> => new Map(entries);
const rate = (table: Record<number, number>) => (uid: number) => table[uid] ?? null;

const baseCfg = (over: Partial<LaborAttributionConfig> = {}): LaborAttributionConfig => ({
  travelFractionL3: 0,
  warehouseFromBuffers: false,
  loadWeightByItems: false,
  loadBufferMin: 60,
  returnBufferMin: 60,
  ...over,
});

describe("internalShiftCostsFromAssignments — field + prep now costed (not just drivers)", () => {
  it("builds a WorkerShiftCost per internal worker incl. FIELD and PREP, each at its Connecteam rate", () => {
    const shifts = [
      shift("S-drv", { routeId: "R1" }),
      shift("S-fld", { routeId: "R1" }),
      shift("S-prep", { routeId: null }), // prep: route-less
    ];
    const assignments = map([
      ["S-drv", [asg("S-drv", { connecteamUserId: 1, role: "driver", displayName: "Dana" })]],
      ["S-fld", [asg("S-fld", { connecteamUserId: 2, role: "field", displayName: "Finn" })]],
      ["S-prep", [asg("S-prep", { connecteamUserId: 3, role: "prep", displayName: "Pat" })]],
    ]);
    const out = internalShiftCostsFromAssignments("2026-10-01", shifts, assignments, rate({ 1: 25, 2: 20, 3: 18 }));
    expect(out.map((w) => w.workerKey)).toEqual(["ct:1", "ct:2", "ct:3"]);
    const field = out.find((w) => w.workerKey === "ct:2")!;
    expect(field.role).toBe("field");
    expect(field.hours).toBeCloseTo(8, 2);
    expect(field.cost).toBeCloseTo(160, 2); // 8h * $20
    const prep = out.find((w) => w.workerKey === "ct:3")!;
    expect(prep.role).toBe("prep");
    expect(prep.routesServed).toEqual([]); // route-less prep → the cascade will bucket it non-customer
    expect(prep.cost).toBeCloseTo(144, 2); // 8h * $18
    // every internal worker is PLANNED (scheduled), never fabricated ACTUAL
    expect(out.every((w) => w.status === "PLANNED" && w.kind === "internal")).toBe(true);
  });

  it("an unknown window → null hours/cost (excluded, honest), never 0", () => {
    const shifts = [shift("S1", { routeId: "R1", windowKnown: false, startTime: null, endTime: null })];
    const assignments = map([["S1", [asg("S1", { connecteamUserId: 1, role: "prep" })]]]);
    const out = internalShiftCostsFromAssignments("2026-10-01", shifts, assignments, rate({ 1: 25 }));
    expect(out[0].hours).toBeNull();
    expect(out[0].cost).toBeNull();
  });

  it("an unknown rate → null cost (excluded), hours still known", () => {
    const shifts = [shift("S1", { routeId: "R1" })];
    const assignments = map([["S1", [asg("S1", { connecteamUserId: 9, role: "driver" })]]]);
    const out = internalShiftCostsFromAssignments("2026-10-01", shifts, assignments, rate({}));
    expect(out[0].hours).toBeCloseTo(8, 2);
    expect(out[0].rate).toBeNull();
    expect(out[0].cost).toBeNull();
  });
});

describe("internalShiftCostsFromAssignments — anti-double-count (once per worker per day)", () => {
  it("a worker on TWO shifts the same day is ONE WorkerShiftCost (hours summed, routes unioned)", () => {
    const shifts = [shift("S-a", { routeId: "R1" }), shift("S-b", { routeId: "R2", startTime: "2026-10-01T17:00:00Z", endTime: "2026-10-01T19:00:00Z" })];
    const assignments = map([
      ["S-a", [asg("S-a", { connecteamUserId: 7, role: "driver" })]],
      ["S-b", [asg("S-b", { connecteamUserId: 7, role: "field" })]],
    ]);
    const out = internalShiftCostsFromAssignments("2026-10-01", shifts, assignments, rate({ 7: 30 }));
    expect(out).toHaveLength(1);
    const w = out[0];
    expect(w.hours).toBeCloseTo(10, 2); // 8h + 2h
    expect(w.cost).toBeCloseTo(300, 2); // 10h * $30 — counted ONCE
    expect(new Set(w.routesServed)).toEqual(new Set(["R1", "R2"]));
    expect(w.role).toBe("driver"); // driver > field in the roll-up
  });

  it("excludes non-committed / dropped states (PROPOSED, DECLINED, NO_SHOW, CANCELLED, REPLACED)", () => {
    const shifts = [shift("S1", { routeId: "R1" })];
    const assignments = map([
      [
        "S1",
        [
          asg("S1", { connecteamUserId: 1, state: "PROPOSED" }),
          asg("S1", { connecteamUserId: 2, state: "REPLACED" }),
          asg("S1", { connecteamUserId: 3, state: "NO_SHOW" }),
          asg("S1", { connecteamUserId: 4, state: "CONFIRMED" }), // the only costable one
        ],
      ],
    ]);
    const out = internalShiftCostsFromAssignments("2026-10-01", shifts, assignments, rate({ 1: 25, 2: 25, 3: 25, 4: 25 }));
    expect(out.map((w) => w.workerKey)).toEqual(["ct:4"]);
  });

  it("ignores Instawork assignments (temp flows via basePrice elsewhere — unchanged)", () => {
    const shifts = [shift("S1", { routeId: "R1" })];
    const assignments = map([["S1", [asg("S1", { workerKind: "instawork", instaworkWorker: "Sam", connecteamUserId: null })]]]);
    const out = internalShiftCostsFromAssignments("2026-10-01", shifts, assignments, rate({}));
    expect(out).toEqual([]);
  });
});

describe("internalShiftCostsFromAssignments — graceful fallback signal + reconciliation", () => {
  it("returns [] when the day has no costable internal assignments (caller falls back to driver-day)", () => {
    const shifts = [shift("S1", { routeId: "R1" })];
    // Only an Instawork seat + a dropped internal worker → nothing costable internally.
    const assignments = map([
      ["S1", [asg("S1", { workerKind: "instawork", instaworkWorker: "Sam" }), asg("S1", { connecteamUserId: 1, state: "CANCELLED" })]],
    ]);
    expect(internalShiftCostsFromAssignments("2026-10-01", shifts, assignments, rate({ 1: 25 }))).toEqual([]);
  });

  it("the built rows reconcile end-to-end through the cascade (Σ leaves === Σ shift costs)", () => {
    const shifts = [shift("S-drv", { routeId: "R1" }), shift("S-fld", { routeId: "R1" }), shift("S-prep", { routeId: null })];
    const assignments = map([
      ["S-drv", [asg("S-drv", { connecteamUserId: 1, role: "driver" })]],
      ["S-fld", [asg("S-fld", { connecteamUserId: 2, role: "field" })]],
      ["S-prep", [asg("S-prep", { connecteamUserId: 3, role: "prep" })]],
    ]);
    const workerShiftCosts = internalShiftCostsFromAssignments("2026-10-01", shifts, assignments, rate({ 1: 25, 2: 20, 3: 18 }));
    const routes: AttribRoute[] = [{ routeId: "R1", date: "2026-10-01", stops: [{ txId: "A" }, { txId: "B" }], windowHours: 10, rawHours: 8, bufferHours: 2 }];
    const res = attributeLabor({ date: "2026-10-01", routes, cfg: baseCfg({ warehouseFromBuffers: true, travelFractionL3: 0.15 }), workerShiftCosts });

    const totalShiftCost = workerShiftCosts.reduce((a, w) => a + (w.cost ?? 0), 0); // 200 + 160 + 144 = 504
    const totalLeaves = res.entries.reduce((a, e) => a + (e.amount ?? 0), 0);
    expect(totalLeaves).toBeCloseTo(totalShiftCost, 1);
    for (const row of res.reconciliation) expect(row.balanced).toBe(true);
    // the route-less prep worker's whole cost is non-customer (never on a project)
    const prepLeaves = res.entries.filter((e) => e.workerRef === "ct:3");
    expect(prepLeaves.every((e) => e.eventId == null)).toBe(true);
  });
});

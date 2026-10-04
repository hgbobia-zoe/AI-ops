// Labor attribution (FI-Phase 1–4) — the deterministic cascade that turns a worker's shift/gig labor
// cost into cost_entries leaves down the hierarchy WORKER → SHIFT → ROUTE → STOP → PROJECT, always
// reconciling to the route/shift total and never double-counting. Pure + unit-tested. Supersedes
// allocation.ts (which stays as the legacy driver-only special case).
//
// Design law: RULES CALCULATE. Every hour/rate/cost/allocation weight is deterministic; every leaf
// carries a bucket + method + confidence + amount_status so an ESTIMATE is never shown as an ACTUAL and
// non-customer labor (travel / warehouse / unallocated) never lands on a customer project.
//
// The dollar ALWAYS originates at a worker's shift/gig cost and is PARTITIONED downward, so the leaves
// sum back to it by construction (§5 reconciliation):
//   L0  worker→route   split the shift cost across the routes it served by route-DURATION share
//   carve-off          separate WAREHOUSE/buffer (+ prep) and TRAVEL from the customer remainder
//   L1/L2/L3           attribute the customer remainder to stops→projects at the best grain the data
//                      supports (L1 ACTUAL on-stop clock → L2 DERIVED arrived→completed → L3 PLANNED)

import type { CostEntryInput, CostBucket, AttribMethod, AttribConfidence, LaborWorkerKind } from "./allocation";
import type { LaborAttributionConfig } from "./config";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** One worker on one shift/gig, already costed by the staffing-cost model (scheduling/cost.ts) or the
 *  legacy driver-day source. The INPUT to the cascade — FI allocates this cost downward, never upward. */
export interface WorkerShiftCost {
  /** Stable key for reconciliation + idempotency (e.g. "ct:1234" or "iw:<gigId>:<name>"). */
  workerKey: string;
  kind: LaborWorkerKind;
  displayName?: string;
  shiftId?: string;
  role?: "driver" | "field" | "prep";
  /** Route ids this shift/gig served. Empty → the whole cost is UNALLOCATED (can't tie to a route). */
  routesServed: string[];
  hours: number | null; // shift/gig window hours (null = unknown window)
  rate: number | null; // $/h (internal: Connecteam; temp: basePrice/hours when derivable)
  cost: number | null; // total labor dollars for this worker-shift (null = rate/window unknown → excluded)
  /** ACTUAL (timesheet/realized) vs PLANNED (scheduled/posted) — drives amount_status of the leaves. */
  status: "ACTUAL" | "PLANNED";
}

export interface AttribStop {
  txId?: string;
  sequence?: number;
  kind?: "delivery" | "pickup";
  arrivedAt?: string; // ISO — dispatch state machine; present → L2 DERIVED signal
  completedAt?: string; // ISO
  itemCount?: number; // line-item count for optional load-weighting
}

export interface AttribRoute {
  routeId: string;
  date: string;
  stops: AttribStop[];
  /** Full operational window hours incl. load+return buffers (routeWindow). Null = unknown. */
  windowHours: number | null;
  /** Raw stop-span hours (no buffers). Null = unknown. */
  rawHours: number | null;
  /** load buffer + return buffer hours (windowHours − rawHours). Null = unknown. */
  bufferHours: number | null;
}

/** The reconciliation ANCHOR: per-route rolled-up labor (summed across all workers on the route). */
export interface RouteLaborCost {
  routeId: string;
  date: string;
  hours: number | null;
  cost: number | null;
  /** Dollars by bucket (null when nothing of that bucket, or all unknown). */
  customerCost: number | null;
  travelCost: number | null;
  warehouseCost: number | null;
  unallocatedCost: number | null;
  internalCost: number | null;
  tempCost: number | null;
}

export interface ReconciliationRow {
  workerKey: string;
  kind: LaborWorkerKind;
  displayName?: string;
  shiftCost: number | null;
  allocated: { customer: number; travel: number; warehouse: number; prep: number; unallocated: number };
  allocatedTotal: number | null;
  /** shiftCost − allocatedTotal (should be ~0). */
  residual: number | null;
  balanced: boolean;
}

export interface AttributeLaborInput {
  date: string;
  routes: AttribRoute[];
  workerShiftCosts: WorkerShiftCost[];
  cfg: LaborAttributionConfig;
}

export interface AttributeLaborResult {
  routeCosts: RouteLaborCost[];
  entries: CostEntryInput[];
  reconciliation: ReconciliationRow[];
}

/** Split `total` across `weights` preserving the exact total (round2, remainder to the last bucket so
 *  pennies never vanish). Even split when all weights are 0/absent. Empty → []. */
function partition(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = sum > 0 ? weights.map((w) => total * (w / sum)) : weights.map(() => total / weights.length);
  const out = raw.map(round2);
  const diff = round2(total - out.reduce((a, b) => a + b, 0));
  out[out.length - 1] = round2(out[out.length - 1] + diff);
  return out;
}

/** Each stop's duration in seconds from arrived→completed, or null when either timestamp is missing. */
function stopDerivedSeconds(s: AttribStop): number | null {
  if (!s.arrivedAt || !s.completedAt) return null;
  const a = Date.parse(s.arrivedAt);
  const c = Date.parse(s.completedAt);
  if (Number.isNaN(a) || Number.isNaN(c) || c <= a) return null;
  return (c - a) / 1000;
}

interface ProjectWeight {
  txId: string;
  weight: number;
}

/** Choose the attribution method + per-project weights for a route's customer-bearing stops.
 *  L2 DERIVED when EVERY txId stop has a usable arrived→completed span; else L3 PLANNED (stop count,
 *  optionally load-weighted by items). L1 ACTUAL_STOP is reserved for a real on-stop clock (FI-Phase 6)
 *  — it does not exist today, so the cascade never emits it yet but the shape is ready for it. */
function customerSplit(route: AttribRoute, cfg: LaborAttributionConfig): { method: AttribMethod; confidence: AttribConfidence; weights: ProjectWeight[] } {
  const txStops = route.stops.filter((s) => s.txId);
  if (txStops.length === 0) return { method: "UNALLOCATED", confidence: "LOW", weights: [] };

  const derived = txStops.map(stopDerivedSeconds);
  const allDerived = derived.every((d) => d != null && d > 0);
  const byProject = new Map<string, number>();

  if (allDerived) {
    txStops.forEach((s, i) => byProject.set(s.txId!, (byProject.get(s.txId!) ?? 0) + (derived[i] as number)));
    return { method: "DERIVED_STOP", confidence: "MEDIUM", weights: [...byProject].map(([txId, weight]) => ({ txId, weight })) };
  }
  // L3 PLANNED — stop count, optionally weighted by each stop's line-item load.
  for (const s of txStops) {
    const w = cfg.loadWeightByItems && s.itemCount && s.itemCount > 0 ? s.itemCount : 1;
    byProject.set(s.txId!, (byProject.get(s.txId!) ?? 0) + w);
  }
  return { method: "PLANNED", confidence: "LOW", weights: [...byProject].map(([txId, weight]) => ({ txId, weight })) };
}

function entry(
  base: {
    eventId?: string;
    routeId?: string;
    day: string;
    hours: number;
    cost: number | null;
    rate: number | null;
    costKnown: boolean;
    bucket: CostBucket;
    method: AttribMethod;
    confidence: AttribConfidence;
    worker: WorkerShiftCost;
  },
): CostEntryInput {
  // Dollars are ACTUAL only when the rate is real AND the leaf came from an ACTUAL on-stop clock
  // (status ACTUAL + method ACTUAL_STOP). A planned/derived split with a real rate is ESTIMATED, not
  // ACTUAL — this is the honest-labeling fix. No rate → UNAVAILABLE (never 0).
  const amountStatus = !base.costKnown
    ? "UNAVAILABLE"
    : base.worker.status === "ACTUAL" && base.method === "ACTUAL_STOP"
      ? "ACTUAL"
      : "ESTIMATED";
  const kindTag = base.bucket === "customer" ? base.eventId ?? "-" : base.bucket;
  return {
    type: "labor",
    class: "DIRECT",
    eventId: base.bucket === "customer" ? base.eventId : undefined,
    routeId: base.routeId,
    day: base.day,
    amount: base.costKnown ? round2(base.cost as number) : null,
    amountStatus,
    hours: round2(base.hours),
    rate: base.rate,
    source: base.worker.kind === "instawork" ? "instawork" : base.worker.kind === "internal" ? "connecteam" : "derived",
    sourceRef: `labor:${base.worker.workerKey}:${base.routeId ?? "noroute"}:${base.bucket}:${kindTag}`,
    note: base.worker.displayName ? `${base.worker.kind} ${base.worker.displayName}` : undefined,
    workerKind: base.worker.kind,
    workerRef: base.worker.workerKey,
    shiftId: base.worker.shiftId,
    bucket: base.bucket,
    method: base.method,
    confidence: base.confidence,
  };
}

/**
 * The full cascade. Returns the per-route anchor, the cost_entries leaves (customer/travel/warehouse/
 * unallocated), and a per-worker reconciliation proving Σ leaves === the worker's shift cost.
 */
export function attributeLabor(input: AttributeLaborInput): AttributeLaborResult {
  const { date, routes, workerShiftCosts, cfg } = input;
  const routeById = new Map(routes.map((r) => [r.routeId, r]));
  const entries: CostEntryInput[] = [];
  const reconciliation: ReconciliationRow[] = [];
  // Accumulators for the route-level anchor.
  const routeAcc = new Map<string, { hours: number; cost: number; customer: number; travel: number; warehouse: number; unallocated: number; internal: number; temp: number }>();
  const bumpRoute = (routeId: string, bucket: CostBucket, hours: number, cost: number, kind: LaborWorkerKind) => {
    const a = routeAcc.get(routeId) ?? { hours: 0, cost: 0, customer: 0, travel: 0, warehouse: 0, unallocated: 0, internal: 0, temp: 0 };
    a.hours += hours;
    a.cost += cost;
    if (bucket === "customer") a.customer += cost;
    else if (bucket === "travel") a.travel += cost;
    else if (bucket === "warehouse" || bucket === "prep") a.warehouse += cost;
    else a.unallocated += cost;
    if (kind === "internal") a.internal += cost;
    else if (kind === "instawork") a.temp += cost;
    routeAcc.set(routeId, a);
  };

  for (const w of workerShiftCosts) {
    const costKnown = w.cost != null;
    const totalCost = w.cost ?? 0;
    const totalHours = w.hours ?? 0;
    const alloc = { customer: 0, travel: 0, warehouse: 0, prep: 0, unallocated: 0 };

    const served = w.routesServed.map((id) => routeById.get(id)).filter((r): r is AttribRoute => Boolean(r));

    if (served.length === 0) {
      // Nothing to tie this shift to → honest UNALLOCATED (never force-fit onto a project).
      alloc.unallocated += costKnown ? round2(totalCost) : 0;
      entries.push(
        entry({ day: date, hours: totalHours, cost: costKnown ? totalCost : null, rate: w.rate, costKnown, bucket: "unallocated", method: "UNALLOCATED", confidence: "LOW", worker: w }),
      );
      pushRecon(reconciliation, w, alloc, costKnown);
      continue;
    }

    // L0 — split the shift cost (and hours) across served routes by DURATION share (windowHours, then
    // rawHours, then even). A temp gig matched to several routes is single-counted here by the partition.
    const weights = served.map((r) => r.windowHours ?? r.rawHours ?? 0);
    const routeCostSlices = partition(totalCost, weights);
    const routeHourSlices = partition(totalHours, weights);

    served.forEach((route, ri) => {
      const sliceCost = routeCostSlices[ri];
      const sliceHours = routeHourSlices[ri];

      // A prep worker's whole slice is non-customer warehouse/prep labor (never split to a project).
      if (w.role === "prep") {
        alloc.prep += costKnown ? sliceCost : 0;
        entries.push(entry({ routeId: route.routeId, day: date, hours: sliceHours, cost: costKnown ? sliceCost : null, rate: w.rate, costKnown, bucket: "prep", method: "ESTIMATED", confidence: "MEDIUM", worker: w }));
        bumpRoute(route.routeId, "prep", sliceHours, costKnown ? sliceCost : 0, w.kind);
        return;
      }

      // Carve-off fractions of THIS route slice (partition of sliceCost/sliceHours → reconciles).
      const windowH = route.windowHours ?? route.rawHours ?? 0;
      const bufferH = route.bufferHours ?? 0;
      const warehouseFrac = cfg.warehouseFromBuffers && windowH > 0 ? Math.min(1, Math.max(0, bufferH / windowH)) : 0;
      const split = customerSplit(route, cfg);
      const hasCustomer = split.weights.length > 0;
      // Travel is only separable as a config fraction of the customer window at planned grain (ESTIMATED).
      const customerWindowFrac = 1 - warehouseFrac;
      const travelFrac = hasCustomer ? customerWindowFrac * Math.min(1, Math.max(0, cfg.travelFractionL3)) : 0;
      const custFrac = hasCustomer ? customerWindowFrac - travelFrac : 0;
      // When the route has NO identified project, the customer window has nowhere to go → unallocated.
      const unallocFrac = hasCustomer ? 0 : customerWindowFrac;

      // Partition the slice cost+hours across [warehouse, travel, customer-or-unallocated] exactly.
      const bucketWeights = [warehouseFrac, travelFrac, custFrac + unallocFrac];
      const [whCost, trCost, custCost] = partition(sliceCost, bucketWeights);
      const [whHours, trHours, custHours] = partition(sliceHours, bucketWeights);

      if (warehouseFrac > 0) {
        alloc.warehouse += costKnown ? whCost : 0;
        entries.push(entry({ routeId: route.routeId, day: date, hours: whHours, cost: costKnown ? whCost : null, rate: w.rate, costKnown, bucket: "warehouse", method: "ESTIMATED", confidence: "MEDIUM", worker: w }));
        bumpRoute(route.routeId, "warehouse", whHours, costKnown ? whCost : 0, w.kind);
      }
      if (travelFrac > 0) {
        alloc.travel += costKnown ? trCost : 0;
        entries.push(entry({ routeId: route.routeId, day: date, hours: trHours, cost: costKnown ? trCost : null, rate: w.rate, costKnown, bucket: "travel", method: "ESTIMATED", confidence: "LOW", worker: w }));
        bumpRoute(route.routeId, "travel", trHours, costKnown ? trCost : 0, w.kind);
      }

      if (!hasCustomer) {
        alloc.unallocated += costKnown ? custCost : 0;
        entries.push(entry({ routeId: route.routeId, day: date, hours: custHours, cost: costKnown ? custCost : null, rate: w.rate, costKnown, bucket: "unallocated", method: "UNALLOCATED", confidence: "LOW", worker: w }));
        bumpRoute(route.routeId, "unallocated", custHours, costKnown ? custCost : 0, w.kind);
        return;
      }

      // Customer remainder → split across projects by the chosen method (L2 DERIVED / L3 PLANNED).
      const projWeights = split.weights.map((p) => p.weight);
      const projCosts = partition(custCost, projWeights);
      const projHours = partition(custHours, projWeights);
      split.weights.forEach((p, pi) => {
        alloc.customer += costKnown ? projCosts[pi] : 0;
        entries.push(entry({ eventId: p.txId, routeId: route.routeId, day: date, hours: projHours[pi], cost: costKnown ? projCosts[pi] : null, rate: w.rate, costKnown, bucket: "customer", method: split.method, confidence: split.confidence, worker: w }));
        bumpRoute(route.routeId, "customer", projHours[pi], costKnown ? projCosts[pi] : 0, w.kind);
      });
    });

    pushRecon(reconciliation, w, alloc, costKnown);
  }

  const routeCosts: RouteLaborCost[] = [...routeAcc].map(([routeId, a]) => ({
    routeId,
    date: routeById.get(routeId)?.date ?? date,
    hours: round2(a.hours),
    cost: round2(a.cost),
    customerCost: round2(a.customer),
    travelCost: round2(a.travel),
    warehouseCost: round2(a.warehouse),
    unallocatedCost: round2(a.unallocated),
    internalCost: round2(a.internal),
    tempCost: round2(a.temp),
  }));

  return { routeCosts, entries, reconciliation };
}

function pushRecon(out: ReconciliationRow[], w: WorkerShiftCost, alloc: ReconciliationRow["allocated"], costKnown: boolean): void {
  const allocatedTotal = costKnown ? round2(alloc.customer + alloc.travel + alloc.warehouse + alloc.prep + alloc.unallocated) : null;
  const residual = costKnown && w.cost != null ? round2((w.cost as number) - (allocatedTotal as number)) : null;
  out.push({
    workerKey: w.workerKey,
    kind: w.kind,
    displayName: w.displayName,
    shiftCost: w.cost,
    allocated: { customer: round2(alloc.customer), travel: round2(alloc.travel), warehouse: round2(alloc.warehouse), prep: round2(alloc.prep), unallocated: round2(alloc.unallocated) },
    allocatedTotal,
    residual,
    balanced: residual == null ? true : Math.abs(residual) < 0.01,
  });
}

/** Instawork premium = actual temp cost − the SAME temp hours costed at the measured internal $/h.
 *  Never a hardcoded multiplier; null when either side is unknown. (Shared law with scheduling/cost.ts.) */
export function instaworkPremium(tempCost: number | null, tempHours: number | null, avgInternalRate: number | null): { equivalentInternalCost: number | null; premium: number | null } {
  const equivalentInternalCost = tempHours != null && avgInternalRate != null ? round2(tempHours * avgInternalRate) : null;
  const premium = tempCost != null && equivalentInternalCost != null ? round2(tempCost - equivalentInternalCost) : null;
  return { equivalentInternalCost, premium };
}

# Financial Intelligence — Labor Attribution (Instawork + Internal) across Routes, Stops & Projects

**Status:** Design for review (ANALYSIS ONLY — no production code, schema, config, git, or flyctl changed by this task).
**Author:** Engineering analysis pass, 2026-10-04.
**Scope:** Extend the existing Financial Intelligence (FI) model so that **temp (Instawork) and internal
labor cost** is attributed defensibly down the hierarchy **Worker → Shift → Route → Stop → Project**, always
reconciling to the route-level labor cost and never double-counting. This is **not** a parallel financial system
— it extends `src/lib/finance/*` (the `cost_entries` ledger, `financeForPeriod`, the `/finance` blade) and
**consumes** the forthcoming staffing cost model rather than duplicating it.

**Cross-references (read first):**
- `docs/shift-lifecycle-engine-analysis.md` — defines `shift_assignments` (one row per worker × shift), the
  per-worker lifecycle, and the data-ownership matrix. FI's labor attribution **consumes** that entity; it does
  not create a competing worker/assignment row.
- `docs/shift-staffing-cost-optimization.md` — defines the deterministic **labor-cost model** (`scheduling/cost.ts`
  `shiftLaborCost`/`tempPremium`, `StaffingCostConfig`, internal rate via Connecteam `getPayRates`, temp rate via
  Instawork `basePrice`, the honest `basePrice` per-gig-vs-per-hour caveat, and the measured — never hardcoded —
  temp premium). FI reads the **worker→shift→route labor cost** this model produces and allocates it downward.

**Governing design law (unchanged):** **RULES CALCULATE. AI INTERPRETS.** Every hour, rate, cost, allocation
weight, premium, projected-vs-actual figure, variance %, attribution-confidence tag, and period total is a
deterministic rule. The optional AI layer only *explains* ("why labor rose this week", "which projects had
unusual variance", "does this increase look justified") from already-structured numbers. AI never invents a
figure. Every number carries a STATUS/method label (`ACTUAL | DERIVED | PLANNED | ESTIMATED | UNALLOCATED |
UNAVAILABLE`); an unknown stays `null`, never 0, and an estimate is never shown as an actual.

---

## Table of contents

- 1. Current state — what FI does today (file refs)
- 2. Gap — what's missing for Instawork + multi-stop attribution
- 3. Proposed model — labor flows Worker → Shift → Route → Stop → Project
- 4. Attribution algorithm — the 3-level hierarchy + travel/warehouse/unallocated policy
- 5. Reconciliation — nothing disappears, never double-count
- 6. Financial metrics — projected/actual, internal/temp, premium, necessary/avoidable, utilization, WoW
- 7. The three reconciling dimensions — calendar week / operational cycle / project
- 8. UI — Overview / Week / Cycle / Routes / Projects / Labor / Instawork / Variance + data lineage
- 9. Implementation plan — smallest safe steps first; buildable-now vs waits-for-actual
- 10. Risks + unresolved questions + the explicit "build first / wait / why"

---

## 1. Current state — what Financial Intelligence does today

**Bottom line up front:** FI already has a deterministic labor-cost scorecard, an event-level labor *allocation*,
and an idempotent cost ledger. But today it costs **driver labor only**, sourced **only** from internal
Connecteam hours, and **dumps 100% of the driver's day onto customer events** — there is no Instawork temp cost,
no field/prep labor, no route-level labor bridge, and no travel/warehouse/unallocated bucket.

### 1.1 The period scorecard — `src/lib/finance/service.ts` `financeForPeriod(period)`
- **Labor** = Connecteam hours × pay rate, computed **account-wide for the period**, not per route/stop:
  `getPlannedHours(start,end)` + `getActualHours(start,end)` return `Map<userId, hours>` (day-aggregated), and
  `sumHoursCost(hours, rateAt)` multiplies each user's hours by `rateForUserOn(rates, uid, end)`
  (`src/lib/connecteam.ts:333/362`). `laborVerified = planned.ok && actual.ok`. If a user has no rate the user is
  counted in `employeesMissingRate` and their cost is excluded; if **no** rate resolves, cost is `null`
  ("UNAVAILABLE", never 0). `actualHours` is `null` when the timesheet map is empty (no "0 worked").
- **Revenue** = `getBookingsRevenueInRange(start,end)` (`repo.ts:1092`) from the `bookings` table, split
  `signed` (committed) vs `pipeline` (unsigned quotes), **in dollars** (the GS import already normalized the
  cents-grained `searchProjects`/`grandTotalCents` feed to dollars in `bookings.grand_total`; do not re-divide).
- **Contribution** = `contribution(signed, actualCost)` — `null` unless both exist (never revenue with a zeroed
  cost). `calc.ts` holds all the pure math (`computeVariance`, `laborLine`, `laborPctOfRevenue`, `contribution`,
  `contributionMargin`) and the `MoneyStatus` enum (`ACTUAL|SIGNED|SCHEDULED|PLANNED|PROJECTED|ESTIMATED|UNAVAILABLE`).
- **Labor trajectory** (`laborHistory.ts`): for a week only, snapshots planned/actual hours+cost into
  `labor_snapshots`, deduped by signature — the plan→actual drift over time.

### 1.2 The event-level allocation — `src/lib/finance/allocation.ts` `allocateDriverLabor(...)`
This is the **one place labor is already pushed down to events**, and the seed to extend. Deterministic:
> driver's day cost = Σ(shift hours) × pay rate → **split evenly across the driver's routes** (`shiftHours /
> drRoutes.length`) → split across each route's events by that event's **share of the route's txId-bearing stops**
> (`eventHours = perRouteHours × cnt/totalTx`).

It emits `CostEntryInput` rows (`type:"labor"`, `class:"DIRECT"`, `eventId`, `routeId`, `day`, `amount`,
`amountStatus:"ACTUAL"|"UNAVAILABLE"`, `hours`, `rate`, `source:"connecteam"`, `sourceRef` idempotency key). When
`rate` or shift is missing the entry is `UNAVAILABLE` (never 0). Routes with zero txId stops allocate nothing.

### 1.3 How allocation is driven + stored
- **Driven by** `src/lib/risk/scan.ts:189` — only `if (staffingVerified)`, it maps `rawRoutes`
  (routeId/date/driverId/driverName/stops→txId) + `driverShifts` (userId/startUnix/endUnix) + `rateForUserOn` into
  `allocateDriverLabor`, accumulates `costEntries`, then `saveCostEntries(costEntries)` (`repo.ts:1298`).
  **`driverShifts` here are the Connecteam day-shift windows, not per-route clock punches.**
- **Stored in** `cost_entries` (`db/index.ts:305`): finest-grain cost ledger — `event_id > route_id > day`,
  `amount_status ACTUAL|ESTIMATED|UNAVAILABLE`, carries `hours` + `rate` (so cost recomputes if a rate is
  backfilled), idempotent by `source_ref UNIQUE`. **This table is the correct foundation for the whole design.**
- **Read back by** `getEventDirectCosts(ids)` (`repo.ts:1335`) → per-event `{labor, laborStatus:
  ACTUAL|UNAVAILABLE|NONE}`, aggregating DIRECT rows: ACTUAL if any actual, else UNAVAILABLE if any expected,
  else NONE. `eventsEconomics()` in the service joins this to booking revenue for the per-event table on `/finance`.

### 1.4 Routes / stops / projects (the hierarchy substrate)
- `src/lib/types.ts`: `Route` (`routeId`, `date`, `truckId`, `driverId`, `driverName`, `stops[]`), `Stop`
  (`stopId`, `sequence`, `txId` = the Goodshuffle transaction = **the project/event id**, `plannedWindow`, `eta`,
  `kind: delivery|pickup`, `items[]`, `grandTotalCents`/`paidCents` pull-time only). **A route holds many stops;
  each stop's `txId` maps it to a project/event.** One project can appear on several routes (delivery + pickup, or
  multiple trucks).
- **Route window / duration:** `routeWindow(route, cfg)` (`src/lib/risk/engine.ts:45`) = `{startUnix =
  firstStop − loadBuffer, endUnix = lastStop + returnBuffer, rawStart, rawEnd, known}`. Duration =
  `(endUnix − startUnix)/3600`. This is a **PLANNED** window derived from stop times ± config buffers — it is the
  only route-duration signal that exists.
- **Stop duration:** there is **no per-stop actual worker time** and **no per-stop planned duration**. A stop has
  a `plannedWindow`/`eta` (an arrival target), `arrivedAt`/`completedAt` **timestamps captured by the dispatch
  state machine** on the truck, but these are drop-off arrival/complete events, not a worker's on-stop labor
  clock, and are not fed to finance today. **Confirmed: actual stop-level labor time does not exist.** (The
  upgrade path in §4 uses `arrivedAt→completedAt` as the first real "derived actual" when/if surfaced.)

### 1.5 Instawork + internal rates (the inputs the new layer consumes)
- **Instawork** (`src/lib/instawork/types.ts`, `reconcile.ts`): read-only browser-pull snapshot. Per gig group:
  `id, name, startsAt, endsAt, timezone, position ("Driver"|"General Labor"), basePrice (dollars|null), filled,
  total, locationName, workers: string[] (NAMES only), interestedPending`. `instaworkGigsForRoute(gigs, route)`
  matches a gig to a route by **day + position→role + window-overlap** — explicitly an **availability match, not
  an allocation**, and a gig can match several routes. **`basePrice` per-gig vs per-hour is UNCONFIRMED** (same
  caveat as the staffing-cost doc). No worker id, no phone, no clock punch.
- **Internal rate:** `getPayRates`/`rateForUserOn` (Connecteam) — proven, already consumed by FI. `null` when a
  worker has no effective rate on the date.

### 1.6 Reporting period today
- `src/lib/finance/periods.ts`: `today | thisWeek | nextWeek | thisMonth | lastMonth`. **Weeks are Monday–Sunday**
  (`getPeriod` computes `weekStart` as Monday). A weekly revenue target applies only to `isWeek` periods
  (`financeConfig().weeklyRevenueTarget`, default $10k, env-overridable). **There is no operational-cycle concept
  and no first-class project dimension** (per-event economics exist as a table, but not as a selectable period).

---

## 2. Gap — what's missing for Instawork + multi-stop attribution

1. **No temp (Instawork) labor cost anywhere in FI.** `allocateDriverLabor` and `financeForPeriod` are
   Connecteam-only. Instawork `basePrice` never reaches `cost_entries` or the scorecard.
2. **Driver-only.** Field and prep labor are never costed or allocated. A route's true labor is driver + field
   crew (+ a share of prep); FI sees only the driver.
3. **100% of worker time is dumped on customer projects.** `allocateDriverLabor` pushes the *entire* driver day
   onto event stops — no travel-between-stops, no warehouse/load/return-buffer, no idle/unallocated bucket. This
   over-attributes cost to projects and makes per-project contribution look worse than it is (and makes "labor
   that belongs to no single project" invisible).
4. **No worker→shift→route labor bridge.** Allocation jumps straight from a Connecteam day-shift to events. It
   does not consume a `shift_assignments`-backed per-worker-per-route labor cost (the staffing-cost model), so a
   worker on a multi-project route isn't attributed per the hierarchy the brief requires.
5. **Route is not a visible financial level.** `cost_entries` can carry `route_id`, but nothing rolls labor up to
   a **route profitability** view (the natural bridge between a shift's cost and a project's cost).
6. **Even split, not duration-weighted.** The driver-day → routes split is `shiftHours / routeCount` (even), not
   weighted by each route's duration — a driver who spent 8h on route A and 1h on route B is costed 4.5h/4.5h.
7. **No internal-vs-temp split, premium, or avoidable-cost view in FI.** The staffing-cost doc computes these for
   the scheduling board; FI has no labor scorecard dimension for them.
8. **No attribution-method labeling.** Every allocated figure today is tagged `ACTUAL`, even though it rests on a
   **planned** route window and an **even** route split — i.e. it is really DERIVED. There is no `DERIVED |
   PLANNED | UNALLOCATED` honesty in the per-project labor number.
9. **No operational-cycle or project period** (§7).

---

## 3. Proposed model — labor flows Worker → Shift → Route → Stop → Project

**Principle:** one source of labor cost (the staffing-cost model), one ledger (`cost_entries`), and a
**cascade of deterministic allocators** each of which preserves the total it was handed. The entity hierarchy is
exactly the brief's hard hierarchy; the dollar always originates at the **route-level labor transaction** and is
split downward, never summed upward from guesses.

```
  Connecteam getPayRates + getActual/PlannedHours        Instawork snapshot (basePrice)
                 │                                                     │
                 ▼                                                     ▼
        ┌───────────────────────────────────────────────────────────────────┐
        │  scheduling/cost.ts  (STAFFING-COST MODEL — consumed, not rebuilt)  │
        │  worker × shift → shiftLaborCost (hours × rate), internal | temp    │
        └───────────────────────────────────────────────────────────────────┘
                 │  one WorkerShiftCost per (worker, shift)   [ACTUAL|PLANNED]
                 ▼
        ┌───────────────────────────────────────────────────────────────────┐
        │  L0  WORKER→ROUTE   finance/laborAttribution.ts                     │
        │  a shift serves ≥1 route; split the shift cost across its routes    │
        │  by route DURATION share (routeWindow). Preserves shift total.      │
        └───────────────────────────────────────────────────────────────────┘
                 │  RouteLaborCost per (route) — THE RECONCILIATION ANCHOR
                 ▼
        ┌───────────────────────────────────────────────────────────────────┐
        │  L1/L2/L3  ROUTE→STOP→PROJECT   (the 3-level attribution, §4)       │
        │  carve off TRAVEL + WAREHOUSE/BUFFER + UNALLOCATED first, then       │
        │  split the customer-attributable remainder across stops→projects    │
        └───────────────────────────────────────────────────────────────────┘
                 │  cost_entries rows: event_id (project), route_id, day,
                 │  amount_status + method + confidence + bucket
                 ▼
        getEventDirectCosts (projects) · new getRouteLaborCosts (routes) · financeForPeriod (periods)
```

### 3.1 The one new pure module
`src/lib/finance/laborAttribution.ts` — sibling of `allocation.ts`, which it supersedes (allocation.ts becomes a
thin special case / is folded in). It is pure and unit-tested like `allocation.ts`/`calc.ts`. Signature:

```ts
function attributeLabor(input: {
  date: string;
  routes: AttribRoute[];                 // routeId, date, stops[{txId, sequence, kind, arrivedAt?, completedAt?}], window
  workerShiftCosts: WorkerShiftCost[];    // FROM scheduling/cost.ts: worker, kind:'internal'|'instawork',
                                          //   routesServed[], hours, rate, cost, status:'ACTUAL'|'PLANNED', method
  cfg: LaborAttributionConfig;            // travel %, warehouse policy, buffers, weights (§4.5)
}): {
  routeCosts: RouteLaborCost[];           // the reconciliation anchor (never lost)
  entries: CostEntryInput[];              // event/route/day rows for cost_entries (incl. UNALLOCATED/TRAVEL/WAREHOUSE)
  reconciliation: ReconciliationReport;   // Σ entries === Σ workerShiftCosts, per worker (§5)
}
```

It **consumes** `WorkerShiftCost` from the staffing-cost model (worker→shift→route labor cost). Where that model
is not yet built, L0 falls back to the current driver-day source (`driverShifts` + `rateForUserOn`) so FI keeps
working — but the module boundary is drawn so that swapping in `shift_assignments`-backed costs is a data-source
change, not a rewrite.

### 3.2 Data model — additive, reuse `cost_entries`
No new financial table. Add **nullable** columns to `cost_entries` (the DB auto-creates schema on import; additive
only), so a labor row can declare *how* it was attributed and *what bucket* it is:

```sql
ALTER TABLE cost_entries ADD COLUMN worker_kind TEXT;   -- 'internal' | 'instawork' | null (legacy)
ALTER TABLE cost_entries ADD COLUMN worker_ref  TEXT;   -- connecteam userId or instawork worker name (link, not a new SoR)
ALTER TABLE cost_entries ADD COLUMN shift_id    TEXT;   -- → staff_shifts.id / shift_assignments.id when available
ALTER TABLE cost_entries ADD COLUMN bucket      TEXT;   -- 'customer' | 'travel' | 'warehouse' | 'unallocated'
ALTER TABLE cost_entries ADD COLUMN method      TEXT;   -- 'ACTUAL_STOP' | 'DERIVED_STOP' | 'PLANNED' (the attribution level, §4)
ALTER TABLE cost_entries ADD COLUMN confidence  TEXT;   -- 'HIGH' | 'MEDIUM' | 'LOW'
```

`amount_status` keeps its current meaning (`ACTUAL|ESTIMATED|UNAVAILABLE`) for whether the *rate×hours dollars*
are real; `method`/`confidence` describe the *allocation*. A project-labor figure is only `ACTUAL` dollars when
both the rate is real **and** it came from `ACTUAL_STOP` time; a planned-window split is `amount_status=ESTIMATED`
+ `method=PLANNED` even when the rate is real — this fixes gap #8 (today everything reads ACTUAL). `UNALLOCATED`/
`TRAVEL`/`WAREHOUSE` rows carry a `route_id`/`day` but a `null` `event_id`, so they never attach to a project yet
are never lost (§5).

---

## 4. Attribution algorithm — the 3-level hierarchy + non-customer policy

Given a **`RouteLaborCost`** (the route-level labor dollars + hours for one worker-or-crew on one route, from L0),
split it to the route's stops/projects. The **method is chosen per route by the best data available**, each level
tagged with `method` + `confidence`, and the customer split is only ever applied to the **customer-attributable
remainder** after travel/warehouse/unallocated is carved off (§4.4). This is what stops a worker's whole shift
landing on customer projects.

### 4.1 L1 — ACTUAL stop-level time (highest confidence) — *upgrade path, not available today*
**If** per-stop worker time exists for the route (today it does **not** — see §1.4; the first real source will be
dispatch `arrivedAt→completedAt` per stop once surfaced to finance):
- per-stop customer hours = `Σ (completedAt − arrivedAt)` for that stop's project;
- project share = that project's summed on-stop hours ÷ route's total on-stop hours;
- `method = ACTUAL_STOP`, `confidence = HIGH`, `amount_status = ACTUAL` (if rate real).
This is designed in now so the later data **replaces** the estimate without reworking callers (same `entries`
shape, better `method`).

### 4.2 L2 — DERIVED stop duration (medium confidence) — *buildable soon*
**If** stop-sequence timing can be derived but not measured — e.g. the route's planned window split across stops
by sequence spacing, or `plannedWindow`/`eta` deltas, or `arrivedAt` timestamps present but not `completedAt`:
- derive each stop's duration from the available timing signal; project share = project's derived stop-duration ÷
  route derived total;
- `method = DERIVED_STOP`, `confidence = MEDIUM`, `amount_status = ESTIMATED`.

### 4.3 L3 — PLANNED duration / stop-count (lowest confidence) — *buildable now, the default*
**Else** (today's reality for every route): split the customer-attributable remainder across projects by each
project's **share of the route's txId-bearing stops** (exactly what `allocation.ts` does today), optionally
weighted by line-item load (`stop.items` count — a 40×60-tent stop is more labor than a single-table drop):
- project share = project's stop-count (or load-weight) ÷ route total;
- `method = PLANNED`, `confidence = LOW`, `amount_status = ESTIMATED`.

Each route independently picks the **highest level its data supports** (L1 if present, else L2, else L3) — so the
system upgrades per-route as real data arrives, and a single route's figure is honestly labeled.

### 4.4 Non-customer policy — carve-off BEFORE the customer split (fixes "100% dumped on projects")
From each `RouteLaborCost`, before any L1/L2/L3 split, deterministically separate:
- **WAREHOUSE / BUFFER** = the route's **load buffer + return buffer** hours (`routeWindow` uses
  `loadBufferMin`/`returnBufferMin`) + any **prep** shift hours. These are real labor not attributable to one
  project → `bucket='warehouse'`, `event_id=null`, `route_id=set`. (Prep is day-level with unknown window in
  scheduling; if its window is unknown its hours stay `UNALLOCATED`, never force-split.)
- **TRAVEL** = inter-stop drive + depot↔first/last-stop drive. With no telematics feed in finance, v1 derives it
  as the route span **not** inside a stop's on-stop time (available only at L1/L2); at L3 travel is modeled as a
  **config fraction** of the customer window (`cfg.travelFractionL3`, default from Zoe, labeled `ESTIMATED`), or
  left folded into the customer remainder and **explicitly flagged** "travel not separable at planned grain". Any
  travel dollars → `bucket='travel'`, `event_id=null`.
- **UNALLOCATED** = any shift hours that cannot be tied to a route at all (e.g. a worker paid for 8h but routes
  only account for 6h, or a shift with unknown window) → `bucket='unallocated'`, `event_id=null`, `route_id`
  best-effort or null. **Never force-fit onto a project.**

Only the residue — **customer-attributable hours** — is divided by L1/L2/L3 into project (`event_id`) rows,
`bucket='customer'`.

### 4.5 Config (a type, not a table) — `LaborAttributionConfig`
Defaults in `laborAttribution.ts`, overridable in the `settings` KV / `/admin` (the app's existing pattern):
`{ travelFractionL3, warehouseFromBuffers:boolean, loadWeightByItems:boolean, tempPremiumFallback (shared with
staffing-cost cfg, NOT hardcoded 2×), loadBufferMin/returnBufferMin (reuse risk cfg) }`. No magic numbers in the
algorithm body.

---

## 5. Reconciliation — nothing disappears, never double-count

**The guarantee (an invariant the module asserts and a test pins):**

```
for every worker w on day d:
  Σ cost_entries(w, bucket=customer)      // project labor
+ Σ cost_entries(w, bucket=travel)        // route travel labor
+ Σ cost_entries(w, bucket=warehouse)     // warehouse/buffer/prep labor
+ Σ cost_entries(w, bucket=unallocated)   // unattributable (honest)
= WorkerShiftCost(w, d).cost              // the ORIGINAL route/shift labor transaction
   (within rounding; every split uses the same round2 and a last-bucket remainder trick so pennies never vanish)
```

- **Anchor = `RouteLaborCost`** (L0 output). All downward splits are *partitions* of an anchor, so they sum back
  to it by construction. L0 itself partitions the shift cost across routes by duration share, so it sums back to
  the shift. Transitively, the leaf entries sum back to the worker's shift cost.
- **No double-count across routes:** an Instawork gig that `instaworkGigsForRoute` matches to *several* routes is
  an **availability** match, not an allocation (reconcile.ts is explicit). For costing, a temp worker's
  `basePrice` is assigned to **exactly one** route via the same L0 duration-share partition (or split across the
  routes they actually served, each a fraction) — never counted once per matched route. The partition enforces
  single-counting.
- **No double-count across delivery+pickup:** a project with both a delivery stop and a pickup stop legitimately
  incurs labor on both; they are **different route visits**, so both carry labor and that is correct (not a
  double-count). The project's total labor = Σ its stop-entries across all routes — this is *why* the project
  dimension must be independent of any single route (§7C).
- **Reconciliation view** (§8): a table per worker/day showing shift cost → route splits → bucket splits →
  project leaves, with the residual line, so a human can see the dollar conserved end-to-end. Any non-zero
  `unallocated` is surfaced, not hidden — it is a signal (over-staffed, idle, or a data gap), not an error.

---

## 6. Financial metrics — deterministic, UNKNOWN-honest

All computed in `laborAttribution.ts` / a `finance/laborMetrics.ts`, each `null` when inputs are missing, each
tagged internal/temp and method. They extend the existing `FinanceSummary.labor` block (they don't replace it).

- **Projected vs actual labor**, split **internal / temp / total**, with **variance %** (reuse `computeVariance`,
  `kind:"cost"`): projected = PLANNED hours×rate (scheduled shifts / posted gigs); actual = ACTUAL timesheet hours
  (internal) and realized gig cost (temp). Temp "actual" is day-grain until a punch feed exists (labeled).
- **Instawork premium** = `actualTempCost − equivalentInternalCost`, where equivalent-internal = the same temp
  hours costed at the **measured** internal $/h for that role (avg of real internal rates), **never** a hardcoded
  2× (the ~2× is anecdotal; use `tempPremiumFallback` only when one side is unknown, and label it ESTIMATED).
- **Necessary vs potentially-avoidable vs UNDETERMINED temp cost:** necessary = temp seats on routes where
  internal supply was exhausted or unqualified (from the staffing-cost model's `temp_reason`); potentially
  avoidable = temp hours the optimizer could have displaced to internal (its `avoidableTempCost`); UNDETERMINED =
  everything the staffing model can't classify (e.g. staffing-cost not yet wired) — **UNDETERMINED is a labeled
  bucket, never silently "necessary" or "avoidable"**.
- **Internal / temp utilization:** internal = internal hours ÷ internal capacity; temp share = temp hours ÷ total
  labor hours. **Labor % of revenue** already exists (`laborPctOfRevenue`), now also split internal/temp.
- **Week-over-week:** the labor-cost scorecard (internal/temp/premium/avoidable) compared to the prior equivalent
  period, using the existing `labor_snapshots` pattern extended with temp + bucket fields (so the trajectory shows
  temp creep, not just total). **WoW uses the calendar-week dimension (§7A) for a stable baseline.**

---

## 7. The three reconciling dimensions (keep all three; don't force one period to do all)

The brief's key insight: labor must be summable three ways, and these ways don't nest cleanly, so each is a
first-class lens over the **same `cost_entries` leaves** (which carry `day`, `route_id`, `event_id`). No figure is
recomputed differently per dimension — they are different `GROUP BY`s of one ledger, which is what makes them
reconcile to each other.

- **A. Calendar / financial week (Mon–Sun).** Unchanged — `periods.ts` already defines it; it stays the baseline
  for trend comparison and the weekly revenue target. All WoW comparisons use it. **Do not change this.**
- **B. Operational cycle (configurable, can cross calendar weeks).** A new period type, e.g. **Thu→Tue**, that
  matches how Zoe actually runs events (load Thursday, events over the weekend, returns/reset Monday–Tuesday). It
  **crosses** calendar-week boundaries, so it cannot be a week variant. Implement as a new `PeriodKey`
  (`thisCycle`/`lastCycle`) whose `start`/`end` come from a configurable **cycle anchor day + length** in
  `settings` (default anchor = Thursday). FI sums the same ledger over the cycle's `[start,end]`. **This is the
  single biggest open decision (§10 Q1): the exact cycle definition.**
- **C. Project / event (independent of any week).** A project spans whatever dates its routes fall on (delivery
  one day, pickup another, possibly across a week or cycle boundary). Project labor = Σ `cost_entries` with that
  `event_id` across **all** days/routes (this already works via `getEventDirectCosts`, extended to carry
  internal/temp + method). A project is never clipped to a week; its contribution is period-independent. This is
  why delivery+pickup both carrying labor (§5) is correct, not a double-count.

The three dimensions reconcile because **A and B are date-range sums of the same leaves**, and **C is an
event-id sum of the same leaves**; a leaf belongs to exactly one day/route/project, so no leaf is counted twice
within a dimension. (A given leaf *does* appear in both its week and its cycle — that is intended; A and B are
alternate calendars over the same facts, not additive to each other.)

---

## 8. UI — views + the bridge level + per-number data lineage

Extend the existing `/finance` blade (`src/app/(console)/finance/page.tsx`, Nocturne `FigureStrip`/`Block`
primitives) with tabs/sub-views. All additive; every figure shows its STATUS/method and a lineage affordance.

- **OVERVIEW** — the current three Blocks (Revenue / Labor / Margin) + new labor sub-rows: internal vs temp cost,
  temp premium, temp % of hours, avoidable temp cost. "—"/"Unavailable" when unknown (never 0).
- **WEEK** (Mon–Sun) and **OPERATIONAL CYCLE** (Thu→Tue, configurable) — the same scorecard over the two
  calendars, side by side when useful; WoW / cycle-over-cycle deltas.
- **ROUTES — the bridge level.** A route-profitability table (route → date → revenue of its projects → total
  labor [internal/temp/travel/warehouse/unallocated] → contribution). This is the natural join between a *shift's*
  cost and a *project's* cost, and the place the reconciliation is most legible. New reader
  `getRouteLaborCosts(ids)` (mirror of `getEventDirectCosts`, grouped by `route_id`).
- **PROJECTS** — the existing per-event table, extended with the internal/temp split, the attribution **method**
  badge (ACTUAL_STOP / DERIVED / PLANNED) and confidence, so a dispatcher sees *how* that project's labor was
  derived.
- **LABOR** — the workforce view: internal vs temp hours/cost, utilization, premium, necessary/avoidable/
  UNDETERMINED temp, week + cycle.
- **INSTAWORK** — temp-only: gigs, `basePrice` (flagged per-gig-vs-per-hour until confirmed), which routes/projects
  each gig's cost landed on, premium vs equivalent-internal, and the honest "availability-match vs cost-allocation"
  distinction.
- **VARIANCE** — projected vs actual (internal/temp/total) with variance %, the AI-interpreted "why" line
  (dormant by default, like `llm.ts`), and the labor-trajectory chart extended with temp.
- **RECONCILIATION** (§5) — per worker/day: shift cost → route splits → buckets → project leaves + residual.
- **Per-number DATA LINEAGE (hard requirement).** Clicking any labor figure (e.g. a project's **$240**) opens a
  lineage panel: **worker(s) → shift(s) → route(s) → rate ($/h, source + effective date) → hours → the split
  method (L1/L2/L3) + bucket carve-offs → this project's share**. Every hop is a stored fact (`cost_entries`
  rows + the `WorkerShiftCost` it came from), so lineage is a pure read, not a recomputation — and it is the UI
  expression of the reconciliation invariant.

---

## 9. Implementation plan — smallest safe steps first

Each phase is additive, independently shippable, test-covered (mirroring `allocation.test.ts`/`calc.test.ts`),
and reversible. **Buildable now** uses only existing data (planned windows, stop counts, Connecteam hours);
**waits** are called out.

- **FI-Phase 1 — honest labeling + non-customer buckets (pure, no new source). SMALLEST FIRST.**
  Refactor `allocation.ts` → `laborAttribution.ts`: keep the L3 stop-count split, but (a) carve off
  warehouse/buffer + unallocated buckets (§4.4) so project labor stops absorbing 100% of the shift, (b) tag every
  entry `method=PLANNED`, `confidence=LOW`, `amount_status=ESTIMATED` (not fake ACTUAL), (c) add the `cost_entries`
  columns (§3.2), (d) assert the reconciliation invariant in a test. **Ships immediately: per-project labor
  becomes defensible and honestly labeled; no behavior depends on new capability.** *Only reads what `risk/scan.ts`
  already assembles.*
- **FI-Phase 2 — route as a financial level + duration-weighted L0.**
  Add `getRouteLaborCosts` + the ROUTES bridge view; change the worker→route split from even to **duration-share**
  (`routeWindow`). Read-only display + lineage. Still Connecteam-only, still planned-grain. *Buildable now.*
- **FI-Phase 3 — Instawork temp cost into the ledger.**
  Feed Instawork gigs (matched to routes via `instaworkGigsForRoute`) as `worker_kind='instawork'` cost entries
  through the same L0→L1/L2/L3 cascade; add the INSTAWORK view, internal/temp split, and the measured premium.
  Gated on resolving `basePrice` per-gig-vs-per-hour (show "base price", not an hourly premium, until confirmed —
  §10 Q2). *Buildable now at the labeled-estimate level.*
- **FI-Phase 4 — consume the staffing-cost model.**
  Replace the L0 data source with `WorkerShiftCost` from `scheduling/cost.ts` + `shift_assignments` (per-worker,
  per-route), bringing field/prep labor and the staffing model's `temp_reason`/avoidable classification into FI's
  necessary/avoidable/UNDETERMINED metric. **Depends on the staffing-cost model + `shift_assignments` existing**
  (both in-flight per the two shift docs). The module boundary (§3.1) makes this a data-source swap.
- **FI-Phase 5 — operational cycle + project period dimensions.**
  Add the configurable Thu→Tue cycle `PeriodKey` + the project-independent period (§7B/C) + cycle-over-cycle WoW.
  *Buildable now (pure period math), but best after the ledger carries temp + buckets so the cycle view is
  complete.*
- **FI-Phase 6 — L2 then L1 actual stop-level time.**
  When dispatch `arrivedAt→completedAt` (then any real on-stop clock) is surfaced to finance, add the DERIVED_STOP
  and ACTUAL_STOP methods. Because the `entries` shape and buckets are unchanged, **actual data replaces the
  estimate per-route with no caller rework** — the figure's `method`/`confidence`/`amount_status` simply upgrade.
  *Waits on actual stop-level time (does not exist today — §1.4).*

**Design-for-upgrade guarantee:** every figure is already a leaf in `cost_entries` with a `method` tag, so moving
a route from L3→L2→L1 is a write of better leaves, not a schema or UI change. Projected→actual is the same leaf
with `amount_status` ACTUAL and the real hours.

---

## 10. Risks + unresolved questions + the explicit call

**Risks**
- **No actual stop-level labor time exists** (§1.4). v1 project attribution is a **planned-grain estimate**
  (L3), honestly labeled; precise per-project labor waits on a real on-stop clock. Over-presenting L3 as actual is
  the top honesty risk — the `method`/`confidence` tags exist to prevent it.
- **`basePrice` per-gig vs per-hour unconfirmed** — every temp $/h and premium figure depends on it; show "base
  price" until confirmed (shared risk with the staffing-cost doc).
- **Connecteam actuals are day-grain** (`getActualHours` → `dailyTotalHours`), so actual route/project labor is
  day-grain, not punch-precise; realized temp cost is likewise day-grain.
- **Instawork availability-match ≠ allocation** — a gig matches several routes; costing must partition it to one
  (or a real split), never count per matched route (§5). Getting this wrong would double-count temp cost.
- **Travel is not separable at planned grain** — v1 either models it as a config fraction (labeled ESTIMATED) or
  flags it folded into the customer bucket; it is not a real measured travel cost until L1/L2.
- **Dependency on in-flight work** — FI-Phase 4's richest metrics (field/prep labor, necessary/avoidable) need the
  staffing-cost model + `shift_assignments`, which are being built concurrently. FI degrades gracefully to the
  driver-only source until then.

**Unresolved questions (need a user decision before implementation)**
1. **Operational-cycle definition (the biggest one):** confirm the anchor day + length — is it **Thursday→Tuesday**
   (load Thu, events weekend, returns Mon–Tue)? Is it fixed or per-event-season? This defines period B and every
   cycle-over-cycle comparison.
2. **Travel + unallocated policy:** at planned grain, should non-stop route time be (a) a config **travel
   fraction** (ESTIMATED), (b) fully **unallocated** (honest but leaves more labor unattributed), or (c) folded
   into the customer bucket with a flag? And should **warehouse/load-return buffer + prep** always be a separate
   non-customer bucket (recommended), or absorbed into the day's overhead?
3. **`basePrice` semantics** — per-gig or per-hour, and the real measured internal-vs-temp premium to seed
   `tempPremiumFallback` (the ~2× is anecdotal — do not hardcode).
4. **Temp single-counting rule** — when a temp gig legitimately spans multiple routes, split its cost by route
   duration share (recommended, reconciles), or assign wholly to the primary route?
5. **Project labor across delivery+pickup** — confirm both route visits should carry labor to the project
   (recommended; it is real labor), vs attributing only the delivery.

**The explicit call — build first / wait / why**
- **Build first (FI-Phases 1–2):** honest labeling + non-customer buckets + route-as-a-financial-level +
  duration-weighted split. **Pure, deterministic, low-risk, needs no new capability** (reuses `cost_entries`, the
  stop/route substrate, and planned windows already in `risk/scan.ts`). It fixes the two worst current defects
  immediately — "100% dumped on projects" and "everything labeled ACTUAL" — and gives route profitability as the
  bridge. This is where the reconciliation guarantee lands and becomes testable.
- **Build next (FI-Phases 3–4):** Instawork temp cost into the ledger (labeled-estimate level now, hourly premium
  once `basePrice` is confirmed), then consume the staffing-cost model for field/prep + necessary/avoidable once
  `shift_assignments` exists.
- **Wait (FI-Phase 6):** actual stop-level attribution (L2→L1) until a real on-stop clock is surfaced — designed
  now so it **replaces** the estimate without rework. Operational-cycle/project dimensions (FI-Phase 5) are
  buildable now but gated on the Q1 cycle decision.
- **Why this order:** it mirrors the two shift docs' own law — *make the facts visible, deterministic, and
  honestly labeled first (planned-grain, now) → enrich with temp + the staffing model as those capabilities land
  → upgrade to actual stop-level time once it's captured* — delivering a defensible, reconciling labor picture in
  the first phase while never presenting an estimate as an actual, never double-counting, and never dumping a
  whole shift on customer projects.
```

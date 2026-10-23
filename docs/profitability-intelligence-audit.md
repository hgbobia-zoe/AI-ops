# Project Profitability & Operational Intelligence — Stage 1 Audit

Status: AUDIT ONLY (no feature code). Branch `docs/profitability-audit`.
Date: 2026-10-23. Auditor: Claude (Opus 4.8), against the live `main` tree.

Governing laws (carried forward into every recommendation): **RULES CALCULATE, AI
INTERPRETS, NEVER FABRICATE**; money in a single declared unit; missing data stays
missing and labeled (`UNAVAILABLE` / `ESTIMATED` / `PROVISIONAL`), never invented; no
double-counting; idempotent / recomputable; reconciliation ties project ↔ route ↔ portfolio.

> **Headline finding.** The hardest, most dangerous third of this capability — a
> deterministic, reconciling, honesty-labeled **labor-cost attribution engine** with a
> worker→route→stop→project cascade, bucket taxonomy, method/confidence, Instawork temp
> premium, three reconciling period dimensions, and a persisted cost ledger — **already
> exists, is unit-tested, and is wired into production** (`src/lib/finance/*`, persisted via
> `cost_entries`, surfaced on `/finance`). The profitability capability is overwhelmingly an
> **EXTENSION** of this engine, not a rebuild. The real new work is (a) revenue-state
> completeness, (b) a **persisted GPS-visit + dispatch-timestamp reconciliation layer**
> (today GPS is live-position-only, nothing historical is stored), (c) explicit cost
> families the ledger schema already names but nothing writes (sub-rental, extra trips,
> overtime, manual adjustments), (d) a reconciliation lifecycle for late data, and (e) a
> richer dashboard (advanced date filtering + saved views do **not** exist yet).

All file:line references below were read directly; anything I could not confirm from source
is explicitly marked **UNVERIFIED**.

---

## 1. Existing reusable capabilities (extend, do not rebuild)

### 1.1 Labor-cost attribution engine — EXISTS, strong, the core to extend
`src/lib/finance/laborAttribution.ts` (`attributeLabor`, 344 lines, pure + tested in
`laborAttribution.test.ts`). This is the spec's labor-cost model and shared-route allocation
already built:

- **Worker→route→stop→project cascade.** Input is `WorkerShiftCost[]` (one costed
  worker-shift; `laborAttribution.ts:24-38`). L0 splits each worker's shift cost across the
  routes it served by **route-duration share** (`windowHours ?? rawHours ?? even`,
  `:241-243`). It then carves off **warehouse/prep** and **travel** fractions, and splits the
  customer remainder across projects (`:245-302`).
- **Bucket taxonomy** `customer | travel | warehouse | prep | unallocated`
  (`allocation.ts:15`). Only `customer` attaches to a project (`event_id`); non-customer labor
  **never lands on a project** (`:267-290`). This directly satisfies the spec's
  delivery/install/pickup/warehouse separation intent.
- **Attribution method + confidence** `ACTUAL_STOP | DERIVED_STOP | PLANNED | ESTIMATED |
  UNALLOCATED` × `HIGH|MEDIUM|LOW` (`allocation.ts:17-18`). `customerSplit()` picks
  `DERIVED_STOP` when **every** project stop has an `arrived→completed` span, else `PLANNED`
  (stop-count, optionally item-weighted) (`laborAttribution.ts:131-149`). **`ACTUAL_STOP` is
  defined but deliberately never emitted today** — reserved for a real on-stop clock
  (`:128-130`). This is exactly the §4 variance ladder.
- **Honest `amount_status`.** A planned/derived split with a real rate is `ESTIMATED`, not
  `ACTUAL`; only `status===ACTUAL && method===ACTUAL_STOP` yields `ACTUAL`; no rate →
  `UNAVAILABLE` (never 0) (`:169-173`). This is the NEVER-FABRICATE law in code.
- **Reconciliation built in.** `partition()` preserves the exact total to the penny
  (`:103-111`); every worker gets a `ReconciliationRow` proving `Σ leaves === shiftCost`
  with a `residual` and `balanced` flag (`:323-336`). Route-level anchors are rolled up in
  `RouteLaborCost` (`:61-74, 307-318`). **Shared-route cost allocation that reconciles to the
  route total already works.**
- **Instawork temp premium** = actual temp cost − same hours at measured internal rate;
  never a hardcoded multiplier; null when unknown (`instaworkPremium`, `:338-344`).

### 1.2 Internal-labor source (per-worker shift_assignments) — EXISTS
`src/lib/finance/internalLabor.ts` (`internalShiftCostsFromAssignments`, `:59-111`) turns
`staff_shifts` + `shift_assignments` + Connecteam rates into `WorkerShiftCost` rows for
drivers + **field + prep** (not just drivers). Anti-double-count: exactly one row per
`(worker, day)` keyed by Connecteam userId (`:68-110`); only `COSTABLE_STATES`
(ASSIGNED/NOTIFIED/CONFIRMED/CLOCKED_IN/CLOCKED_OUT) are costed (`:23-29`). Marked `PLANNED`
(scheduled, not timesheet-verified) (`:103-106`).

### 1.3 Production wiring + persisted ledger — EXISTS
The cascade is not dormant — `src/lib/risk/scan.ts` runs it every scan:
`toAttribRoute()` builds routes **with `arrivedAt`/`completedAt`/`itemCount` per stop**
(`scan.ts:190-209`), prefers `internalShiftCostsFromAssignments` else falls back to the
legacy driver-day source (`:383-409`), adds matched Instawork gigs as temp workers
(`:410-433`), calls `attributeLabor` (`:436`), and persists via `saveDerivedLabor(dates, …)`
(`:442`). `saveDerivedLabor` (`repo.ts:1575-1593`) is a clean idempotent rewrite:
DELETE the day's derived labor leaves then re-INSERT (ON CONFLICT `source_ref`), so the
ledger is always a faithful partition and recomputable. Legacy `allocateDriverLabor`
(`allocation.ts:68-110`) is superseded but retained.

### 1.4 Period + reconciliation service and `/finance` blade — EXISTS
- `src/lib/finance/service.ts` (`financeForPeriod`) already assembles an executive summary:
  signed vs pipeline revenue, planned/actual labor hours+cost, contribution, margin, a
  per-event `EventEconomics[]` (revenue − direct labor, with method/confidence badge and
  `contribStatus`), labor trajectory, and the realized `laborLedger` summary (`:85-184`).
- `src/lib/finance/calc.ts` — pure deterministic core: `computeVariance` (financial-meaning
  favorable/unfavorable), `contribution`, `contributionMargin`, `sumKnown`, `laborPctOfRevenue`;
  every figure carries a `MoneyStatus` (`ACTUAL|SIGNED|SCHEDULED|PLANNED|PROJECTED|ESTIMATED|
  UNAVAILABLE`, `calc.ts:6`). Unknown cost is never zeroed (`:73-76`).
- `src/lib/finance/periods.ts` — **three reconciling period dimensions already exist**: week,
  **operational cycle (Thu→Tue, configurable anchor/length)**, and month; plus `today`,
  `nextWeek`, prior-period helpers (`PERIOD_KEYS`, `getPeriod`, `priorWeek`, `priorCycle`).
- `src/app/(console)/finance/page.tsx` — Nocturne blade with 9 views already including
  `routes`, `projects`, `labor`, `instawork`, `variance`, **`reconciliation`** (`page.tsx:23`).
  Repo readers already exist: `getRouteLaborCosts`, `getInstaworkLedger`,
  `getLaborReconciliation`, `getProjectLaborLineage`, `getLaborLedgerSummary` (`page.tsx:12`).

### 1.5 Config (no magic numbers) — EXISTS
`src/lib/finance/config.ts`: `financeConfig()` (targets/alert thresholds, env-overridable),
`opsCycleConfig()` / `saveOpsCycleConfig()` (settings-KV backed, team-editable, no deploy),
and `laborAttributionConfig()` — the carve-off knobs: `travelFractionL3` (default 0.2),
`warehouseFromBuffers`, `loadWeightByItems`, `loadBufferMin`/`returnBufferMin` reused from
risk config (`config.ts:74-96`).

### 1.6 Operational-history + event scaffolding reusable for §6/§8
- `event_snapshots` + `history_changes` tables (`index.ts:408-442`) already answer "what did
  we know N days out?" — the backbone for historical learning (§8).
- `event_outcomes` (`index.ts:483-492`) captures total/completed stops + `closed_at` per
  (event,route) at route close — a natural per-project operational close record.
- Event Lifecycle engine (`src/lib/event/*`): `generateTimeline`, `assessPrepOpportunities`
  (`prepOpportunity.ts:248`), readiness scoring (`event_readiness` table, `index.ts:592`).
  `assessPrepOpportunities` is the existing "missed prep window / extra trip" detector to
  extend for §(repeat/unplanned-trip detection).
- `src/lib/pricing/*` (`/pricing`) — tiered per-leg delivery formula = the estimated
  transport cost baseline and the "pricing fails to recover cost" comparison for §7.

### 1.7 Conventions already standardized
- **Money:** plain `REAL` **dollars** everywhere in the DB (`bookings`, `cost_entries`,
  `event_financials` all comment "dollars", `index.ts:471-473, 519, 390`). GS cents are
  converted to dollars **at ingest** (`finance/revenue/route.ts:25-26`; `gsPull` comment
  `index.ts:463-464`). There is **no integer-minor-unit money type** — see §4/§5.
- **Time:** ops timezone helpers in `src/lib/dates.ts` (`todayInOpsTz`, default
  `America/New_York`, `dates.ts:10,35`); all periods computed in ops TZ.
- **Idempotency:** `source_ref UNIQUE` on `cost_entries`; `gs_outbox`; `import_log` ledger;
  dedup-by-signature across `risk_items`/`event_snapshots`/`history_changes`.

---

## 2. Verified data sources + their available fields

### 2.1 Goodshuffle revenue — PARTIAL (two stores, one is the SoT)
- **`bookings` table** (`index.ts:465-478`), source `searchProjects`: `booking_id`
  (= GS project id = `stops.tx_id`), `event_name`, `event_date`, `status_label`, `signed`
  (1/0), `contract_total`, `grand_total`, `amount_paid`, `amount_due`, `client_name`,
  `client_email`. **Dollars.** This is the revenue source of truth used by finance
  (`getBookingsRevenueInRange`, `getBookingsInRange`, `repo.ts:1216,1342`). NOTE: pull comment
  says GS field is `contract_subtotal` not `contract_total` (`gsPull.ts:128`) — **UNVERIFIED**
  whether `bookings.contract_total` is reliably populated vs `grand_total`.
- **`event_financials` table** (`index.ts:385-402`): `revenue`, `revenue_status`
  (`SIGNED|SCHEDULED|COLLECTED|UNAVAILABLE`), `collected`, plus labor/contribution columns.
  Written by `/api/finance/revenue` from `loadPaymentHistoryAndContractTotals`
  (`grandTotalCents`, `paidCents`) (`revenue/route.ts:64-73`). **This table has diverged** —
  repo comment says risk/history read revenue from `bookings`, not here (`repo.ts:1359-1361`).
- **Revenue states actually stored:** contracted/grand total, amount paid (→ `COLLECTED` when
  `paid>=revenue`), amount due, signed vs quote. **Quoted-vs-contracted-vs-invoiced** as
  distinct states, and **discounts / fees / refunds**, are **NOT** separated anywhere — MISSING (§3).

### 2.2 Connecteam labor — EXISTS, with a key grain caveat
`src/lib/connecteam.ts`:
- **Pay rates** `getPayRates` + `rateForUserOn` — `/pay-rates/v1/pay-rates` with history;
  date-effective rate lookup (`connecteam.ts:647-685`). Real `$/h` per userId.
- **Planned hours** `getPlannedHours` — from schedulers/shifts (`:712-740`).
- **ACTUAL clocked hours** `getActualHours` — `/time-clock/v1/time-clocks/{id}/timesheet`,
  summed from `dailyRecords[].dailyTotalHours` (`:742-760`). **Actual timesheets ARE
  available.** **Caveat (critical for §5):** actuals are aggregated **per user per day**,
  not per shift/route/stop. So actual hours cannot today be attributed to a specific route or
  project — the cascade still runs on **PLANNED** shift windows (`internalLabor.ts:103-106`),
  and `financeForPeriod` uses day-grain actuals only for the period scorecard, not per-event.
- `shift_assignments.clock_in_at/clock_out_at/clock_source` columns exist to **mirror**
  Connecteam clock times per assignment (`index.ts:805-807`) — **UNVERIFIED** that anything
  populates them today (schema comment: internal is "MIRRORED from Connecteam timesheet";
  Instawork `clock_source='unavailable'`). If populated, this is the bridge to per-route actuals.
- `hr_time_entries` (`index.ts:1838-1857`) normalizes Connecteam/Instawork/manual hours per
  period with `hours_type` (REGULAR/**OVERTIME**/DOUBLE_OVERTIME/PTO) — an **overtime signal**
  exists at period grain for the payroll module.

### 2.3 GPS / telematics — LIVE POSITION ONLY, nothing historical persisted
(See the dedicated §2.7 for the owner-directed geofencing assessment.)
- Live provider: **Zonar / "Ignition" = GPS TrackIt REST** (`cloud-api.gpstrackit.com`,
  `x-api-key`), credentials in Fly secrets `GPSTRACKIT_API_KEY` + `GPSTRACKIT_UNITS_JSON`
  (`providers.ts:214-237`, `eta/zonar.ts:1-34`). Samsara + Motive are implemented
  alternatives (`providers.ts:239-305`).
- The `GpsProviderDef` interface exposes **`getLocation(vehicleId)` → single current fix**
  only (`providers.ts:63`); Zonar's client is `getTruckPosition` → one `{lat,lng,ts,heading}`
  (`zonar.ts:43-49`). **No history/track endpoint is called.**
- **Nothing GPS is persisted.** There is no positions/track/visit table anywhere in the schema
  (full table list reviewed, `index.ts`). GPS is fetched live for ETA only (`liveEta.ts`),
  subject to a daily quota + 429 backoff (`zonar.ts:51-60`).
- **Exception — a GPS fix at action time IS stored:** the `events` table has a `gps` column
  (`index.ts:61`) and the dispatch action handler writes `body.gps` onto each event
  (`action/route.ts:56,117`). So a one-off device fix at ARRIVED/completion may exist per
  event **if the driver client sends it** (UNVERIFIED whether the kiosk/driver app sends GPS).

### 2.4 Routes / stops / dispatch — EXISTS, rich operational timeline per project
- `routes` (`index.ts:16-23`): `route_id`, `truck_id`, `date`, `driver_id`, `status`,
  `updated_at`. No explicit open/close timestamps — close inferred from `status` + `event_outcomes.closed_at`.
- `stops` (`index.ts:26-47`): `tx_id` (via `toStop`, `repo.ts:41-80` maps `tx_id`→`txId`),
  `customer_id`, `sequence`, `state`, `kind` (delivery/pickup), `address`, `planned_window`,
  `eta`, `items` (JSON), **`arrived_at`, `completed_at`**, `photos_ref`, `signature_ref`.
- **Dispatch-reported per-stop timestamps are persisted** (see §2.7.2).
- `events` (`index.ts:50-63`): append-only action log — `action`, `from_state`, `to_state`,
  `ts`, `gps`, `payload`, idempotency key. Captures ARRIVED, HEADING_NEXT, ARRIVED_WAREHOUSE
  (route closeout), side-actions (on-the-way message, fuel log).
- `exceptions` (`index.ts:78-88`) + `shift_exceptions` (`index.ts:852-868`) — operational
  exceptions per stop/shift (reconciliation inputs for §(exceptions)).

### 2.5 Inventory / line items — titles only, no structured financials
The pull fetches `loadContractLineItemGroup` per project, but extracts only **item titles**
(`gsPull.ts:182-184`, `titlesFrom(lists)`) for keyword matching (tent detection, delivery
legs, quote context). **No quantities, prices, categories, or handling/setup times are
stored.** `bookings` has no line-item columns. Item-level labor/handling must be **inferred**
from titles (§6) — no structured per-item data today.

### 2.6 Cost ledger (`cost_entries`) — schema richer than what is written
`cost_entries` (`index.ts:513-535`) supports `type` ∈ `labor | vehicle | fuel |
subcontractor | sub_rental | consumables | event_expense | other`, `class` DIRECT/OVERHEAD,
`event_id/route_id/day`, `amount` (dollars) + `amount_status`, `hours`/`rate`,
`source` (connecteam|goodshuffle|manual|derived|instawork), `source_ref UNIQUE`, and the full
labor-attribution column set (`worker_kind`, `worker_ref`, `shift_id`, `bucket`, `method`,
`confidence`). **Today only `labor` rows are written** (by the cascade). Every other type
(`sub_rental`, `fuel`, `vehicle`, `event_expense`, `consumables`, and `source='manual'`) is
**schema-ready but unwritten** — grep found no manual/sub-rental/fuel writer.

### 2.7 Owner-directed: GPS geofencing + dispatch as two evidence layers

**2.7.1 GPS provider history & persistence (owner question 1).**
- (a) **Live provider = Zonar / Ignition via GPS TrackIt** (`providers.ts:222-237`). The code
  path only ever requests the **current** position (`getLocation`→`getTruckPosition`,
  `zonar.ts:43`). **UNVERIFIED** whether GPS TrackIt's API exposes historical positions / a
  location track — the vendor generally does (trip/history endpoints), but **no such endpoint
  is implemented or tested in this repo**, so it must be verified against live credentials
  before planning on it.
- (b) **No GPS track is persisted today.** To reconstruct past on-site windows we would need
  to **poll on a cadence and store a new positions table** (none exists). The existing daily
  quota + 429 backoff (`zonar.ts:51-60`) is a real constraint on poll frequency.
- (c) **Historical on-site windows for already-completed projects are NOT reconstructable**
  unless GPS TrackIt serves historical tracks retroactively (UNVERIFIED, likely limited
  retention). Practically: **geofence-derived presence works going FORWARD once we start
  storing positions; for past projects §3/§5 fall back to dispatch timestamps only.** State
  this limit plainly to the owner — the GPS-presence layer is forward-looking.
- Geocoding dependency is satisfied: `geocode_cache` table (`index.ts:1942+`) + `eta/geo.ts`
  already geocode addresses for ETA/pricing, so each project's stop address can yield the
  geofence center. A `geofence_radius` config knob would be new.

**2.7.2 Dispatch-reported timestamps actually persisted (owner question 2).**
- **`stops.arrived_at`** — set to **server `now`** when the crew fires `ARRIVED`
  (`action/route.ts:70-71` → `updateStopState(..., {arrivedAt: now})`, `repo.ts:2822-2833`).
- **`stops.completed_at`** — set to server `now` on the `Completed` transition
  (`action/route.ts:72-73`).
- **`events` rows** per action with `ts` (= `clientTs` or server now, `action/route.ts:55`),
  `gps`, `payload` — including the **on-the-way** side-action and `ARRIVED_WAREHOUSE`
  (route closeout, `:101-108`). So "en route / arrived / finished / warehouse-return" are all
  timestamped in `events`, while `stops` carries the canonical arrived/completed columns.
- **Route open/close:** `routes.status`/`updated_at` + `event_outcomes.closed_at`
  (`index.ts:483-492`); there is **no dedicated on-the-way column on `stops`** (it lives only
  in `events`).
- **Fuzziness to flag:** `arrived_at`/`completed_at` are the **server-receive** time, not the
  device event time; with the offline queue (`src/lib/offlineQueue.ts`) a late sync can skew
  them, while the `events.ts` keeps the client timestamp. This is exactly why a two-source
  reconciliation (below) is needed rather than trusting one clock.

---

## 3. Missing data / integration gaps

| # | Spec need | Status | Hard blocker? | Honest path |
|---|-----------|--------|---------------|-------------|
| G1 | Revenue states separated: quoted vs contracted vs invoiced vs collected; fees, discounts, refunds | **PARTIAL** — only signed/grand/paid/due stored; no fees/discounts/refunds | No | Capture-to-build: pull the GS contract breakdown (fees/discounts) + payment/refund history; add revenue-component columns. |
| G2 | **Actual clocked hours attributed per route/stop/project** | **MISSING grain** — actuals exist only per user per day (`connecteam.ts:742-760`); cascade runs on PLANNED windows | No (but caps confidence) | Estimate-only today → leaves stay `ESTIMATED`. Capture-to-build: populate `shift_assignments.clock_in/out` + map clock to route to lift to `ACTUAL`. |
| G3 | **Persisted GPS visit/presence timestamps** (arrival/departure, warehouse in/out) | **MISSING** — live position only, nothing stored | **Blocker for historical** projects; capture-to-build for future | Store a positions table + geofence (§2.7); forward-only. Past projects: dispatch-only, lower confidence. |
| G4 | Sub-rental **expense** per project | **MISSING** — line items captured as titles only; no price/qty; no expense writer | No | Capture-to-build: pull line-item amounts and/or a manual sub-rental cost entry (`type='sub_rental'`, schema ready). |
| G5 | Item-level handling/setup/breakdown times | **MISSING** — titles only | No | Infer from title keywords (reuse risk keyword config); label `PROVISIONAL`. |
| G6 | Transport cost (fuel, mileage, vehicle) per project | **MISSING** — `type` fuel/vehicle unwritten; no odometer/mileage source | No | Estimate from `/pricing` per-leg formula + route distance; `ESTIMATED`. |
| G7 | Extra-trip / repeat-trip / unplanned-return detection as a **cost** | **PARTIAL** — `assessPrepOpportunities` detects missed prep windows; not costed | No | Extend prep-opportunity + stop history into a costed extra-trip entry. |
| G8 | Overtime cost per project | **PARTIAL** — `hr_time_entries.hours_type=OVERTIME` at period grain only | No | Derive OT premium at period grain; attribute `PROVISIONAL`. |
| G9 | Manual adjustments (late invoice, correction, one-off expense) | **MISSING** — no manual cost-entry API (`source='manual'` unused) | No | Build a gated manual cost-entry endpoint + audit. |
| G10 | Reconciliation lifecycle for late timesheets/invoices/refunds | **MISSING** — ledger recomputes per scan but no "snapshot → revision → final" lifecycle or late-arrival tracking | No | Build reconciliation-run + variance-vs-prior entities (§5). |
| G11 | Advanced date filtering + **saved views** on the dashboard | **MISSING** — only preset period keys via `?period=` (`periods.ts:11`); no custom range, no saved views | No | Build a date-range control + saved-view persistence (new). |
| G12 | Per-project **profitability snapshot** entity (revenue − all cost families, margin, status) | **PARTIAL** — `event_financials` exists but diverged/labor-era; no full cost-family rollup | No | Introduce a project financial snapshot built over `cost_entries` + `bookings`. |

---

## 4. Data quality + synchronization limitations

1. **Staleness (office-pull cadence).** The server cannot reach Goodshuffle (Cloudflare blocks
   datacenter IPs — AGENTS.md/CLAUDE.md). All GS data (revenue, bookings, routes, line-item
   titles) arrives via a **once/day logged-in browser pull** (`buildOfficePullScript`). Revenue,
   amount-paid, and refunds can therefore lag reality by up to a day; `import_log`
   (`index.ts:550-561`) records each pull so staleness is detectable. Profitability figures must
   carry an "as of last pull" freshness and a `PROVISIONAL` state until reconciled.
2. **Labor is PLANNED, not ACTUAL, at project grain (G2).** The cascade attributes scheduled
   shift windows; `amount_status` is honestly `ESTIMATED`. Actual timesheet hours exist only at
   user-day grain and are not yet joined to routes. Per-project contribution is therefore
   **estimated** until G2 is closed — the engine already labels this correctly, so no figure is
   dishonest, but confidence is MEDIUM/LOW.
3. **Join reliability (tx_id ↔ route ↔ employee).**
   - `tx_id` is the single GS id space linking `stops.tx_id` ↔ `bookings.booking_id` ↔
     `cost_entries.event_id` — strong join.
   - **Route ↔ employee** depends on `shift_assignments` existing for the day; when absent the
     cascade falls back to the legacy driver-day source (`scan.ts:383-409`) — drivers only, so
     field/prep labor is unattributed on those days.
   - **Instawork ↔ route** matches by name/window heuristics (`scan.ts:412-432`); unmatched temp
     cost is honestly dropped (not force-fit), so temp labor can be under-attributed.
4. **GPS quota + no persistence.** Daily GPS TrackIt quota + 429 backoff (`zonar.ts:51-60`)
   limits any future polling cadence; combined with no stored track, GPS presence is a
   forward-only, rate-limited signal.
5. **Timestamp provenance.** `stops.arrived_at/completed_at` are server-receive times; offline
   queue sync can skew them. GPS-derived presence (future) vs dispatch times will legitimately
   disagree — the architecture treats this as signal, not error (§5).
6. **Revenue double-store divergence.** `bookings` and `event_financials` both hold revenue and
   have diverged (`repo.ts:1359-1361`); the snapshot entity must pick one SoT (`bookings`) and
   either retire or clearly subordinate `event_financials`.
7. **Money unit.** DB stores dollars as `REAL` (floating). The spec asks for integer minor
   units. Existing `round2`/`round4` discipline keeps pennies stable, but a clean cents-integer
   money representation in the new entities would better honor the law (migration/adapter
   decision, §5).

---

## 5. Recommended architecture (extend the FI engine + `/finance`, not a new nav)

**Principle:** the labor engine, cost ledger, period dimensions, and reconciliation view
already exist and are correct. Add cost **families** and **evidence**, a per-project
**snapshot**, a **GPS/dispatch reconciliation layer**, and a **reconciliation lifecycle** — all
on the current stack (better-sqlite3 via `src/lib/db`, pure testable `src/lib/finance/*`,
Nocturne `/finance` blade, Base UI — not Radix).

### 5.1 Entities — extend first, add only where there is no home
- **Keep + extend `cost_entries`** as the universal cost ledger. Start writing the unwritten
  types: `sub_rental` (G4), `fuel`/`vehicle` transport (G6), `event_expense`/`other`, and
  `source='manual'` adjustments (G9). No schema change needed for these.
- **NEW `project_financials` (or repurpose `event_financials`)** — the per-project
  profitability snapshot: revenue components (quoted/contracted/invoiced/collected, fees,
  discounts, refunds), cost-family rollup from `cost_entries`, contribution + margin, an overall
  `status` (`PROVISIONAL|ESTIMATED|RECONCILED`), and `computed_at`. Recomputable from the ledger;
  never the source of truth for a line cost.
- **NEW `gps_positions`** — polled fixes `{vehicle_id, lat, lng, ts, source}` (forward-only).
- **NEW `visit_events`** — derived on-site intervals per `(route_id, stop_id/tx_id)` from
  geofencing `gps_positions` against the stop's geocoded address:
  `{tx_id, route_id, source: 'gps'|'dispatch', enter_ts, exit_ts, confidence}`.
- **Reuse** `events` + `stops.arrived_at/completed_at` as the **dispatch** evidence source
  (no new table needed for dispatch times).
- **NEW `reconciliation_runs`** + per-run variance rows — snapshot → revision → final lifecycle
  (G10), recording what changed when late timesheets/invoices/refunds arrive. Leverages the
  existing `event_snapshots`/`history_changes` discipline.
- **`cost_entries.source_ref`** already serves as the **evidence ref**; extend notes to carry a
  lineage pointer (shift id, gig id, visit_event id, invoice id).

### 5.2 Two-evidence reconciliation (owner question 3) — explicit rule
Treat **GPS-derived presence** and **dispatch-reported times** as two **independent** sources;
store both in `visit_events`, show the discrepancy, and choose an authoritative on-site window
by a documented, non-destructive rule:
- GPS interval = **evidence the vehicle was physically on site**; dispatch interval = **evidence
  of a crew action**. Neither overwrites the other.
- Authoritative window: when both exist and agree within a tolerance, use GPS enter → dispatch
  complete (vehicle-in to work-done). When they diverge beyond `discrepancy_threshold`, **flag
  for review** and keep the dispatch window as the labeled default (crew action is the billing
  anchor), marking confidence `MEDIUM`.
- **Fallback when GPS history is unavailable** (all historical projects, and any day the poll
  gapped): **dispatch-only**, labeled `confidence=LOW` / `PROVISIONAL`. This is the honest
  majority case at launch — say so in the UI.
- New config knobs (via `laborAttributionConfig`/settings-KV): `geofenceRadiusM`,
  `gpsPollSeconds`, `visitDiscrepancyMinutes`. Geofence center = the stop address via the
  existing `geocode_cache`/`eta/geo.ts`.
- This visit window becomes the **L1 `ACTUAL_STOP`** signal the cascade already has a slot for
  (`laborAttribution.ts:128-130`): feeding real on-stop spans lifts customer leaves from
  `DERIVED/PLANNED` toward `ACTUAL` **without touching the allocation math** — the cleanest
  possible extension.

### 5.3 Reconciliation ties project ↔ route ↔ portfolio (already partly true)
`attributeLabor` already guarantees `Σ project/route leaves === worker shift cost`
(`ReconciliationRow`, `RouteLaborCost`). Extend the same partition discipline to the new cost
families so every project cost sums back to a route/day total, and every route total sums to the
portfolio period total — the `/finance` `reconciliation` view and `getLaborReconciliation`
reader are the display surface to broaden.

### 5.4 Where it lives
Extend `src/lib/finance/*` (new pure modules: `revenueModel.ts`, `visitReconcile.ts`,
`projectSnapshot.ts`, `reconciliationRun.ts`), new repo readers/writers in `src/lib/db/repo.ts`,
new tables in `src/lib/db/index.ts`, GPS polling as a server-job tick (reuse the in-process
15-min clock noted in memory) draining to `gps_positions`. UI: new `/finance` views
(`project detail`, `visit reconciliation`) + the date-range/saved-view control — **no new
top-level nav**; profitability is a deepening of Finance.

---

## 6. Implementation sequence (Stages 2–7 → workstreams)

Legend: **[DONE]** largely exists, **[EXT]** extend existing, **[NEW]** net-new,
**[BLOCKED]** needs missing data (honest fallback noted). Sizes S/M/L.

- **Stage 2 — Labor cost model & shared-route allocation.** **[DONE]** — do not rebuild.
  `attributeLabor` + `internalLabor` + `saveDerivedLabor` cover worker→route→stop→project,
  buckets, reconciliation, temp premium. Workstream here is only verification + minor display.
  Size: S (audit/tests), not a build.
- **Stage 3 — Revenue reconstruction.** **[EXT, M]** separate quoted/contracted/invoiced/
  collected + fees/discounts/refunds; pick `bookings` as SoT; retire/subordinate
  `event_financials`; capture-to-build the GS fee/discount/refund pull. Dependency: pull-script
  change.
- **Stage 4 — GPS visit + dispatch reconciliation.** Split:
  - 4a **[NEW, M]** `gps_positions` table + polling tick + geofence → `visit_events(source=gps)`.
    **[BLOCKED for historical]** — forward-only; fallback dispatch-only.
  - 4b **[EXT, S]** `visit_events(source=dispatch)` from existing `stops`/`events` (no new fetch).
  - 4c **[NEW, S]** two-source reconcile rule + discrepancy flag; feed L1 `ACTUAL_STOP` into the
    cascade. Dependency on 4a/4b; UNVERIFIED GPS-history gate.
- **Stage 5 — Cost families beyond labor.** **[EXT, M]** write `sub_rental` (G4), transport/fuel
  estimate (G6), overtime premium (G8), extra-trip cost from prep-opportunity + stop history
  (G7), and a **gated manual adjustment** endpoint (G9). All on the existing `cost_entries`
  schema. Fallbacks: `ESTIMATED`/`PROVISIONAL`.
- **Stage 6 — Per-project profitability snapshot + item intelligence.** **[EXT/NEW, M]**
  `project_financials` rollup (revenue − all cost families, margin, status); item-level
  intelligence **[BLOCKED → PROVISIONAL]** inferred from line-item titles only (no price/qty).
- **Stage 7 — Reconciliation lifecycle + dashboard + learning.**
  - 7a **[NEW, M]** `reconciliation_runs` + variance-vs-prior for late timesheets/invoices/refunds.
  - 7b **[NEW, S/M]** advanced date filtering + **saved views** on `/finance` (does not exist).
  - 7c **[EXT, M]** historical learning/recommendations over `event_snapshots`/`history_changes`
    + the new snapshots (RULES CALCULATE, AI INTERPRETS — reuse the dormant LLM review layer).
  - 7d tests throughout (the engine's pure-function + reconciliation test pattern is established).

### Recommended first PR (buildable now, unblocked, high value)
**"Project financial snapshot + cost-family rollup over the existing ledger"** (Stage 6 core +
a slice of Stage 3): introduce `project_financials` as a deterministic, recomputable rollup of
`cost_entries` (all buckets/types) against `bookings` revenue, with revenue state and an honest
overall `status` (`PROVISIONAL|ESTIMATED|RECONCILED`), surfaced as a **`/finance` → project
detail** view. It needs **no new integration and no missing data** — it reuses the labor ledger
already being written every scan, the `bookings` revenue SoT, and the existing period/variance
calc — so it delivers a real per-project profit number (honestly labeled estimated) on day one,
and establishes the snapshot entity that Stages 4/5/7 then enrich. Pair it with the **dispatch
`visit_events` (4b)** read, since that is also pure and unblocked, if a slightly larger first PR
is acceptable.

---

### Verification notes
- Confirmed by reading source: the entire `src/lib/finance/*` engine, `cost_entries` wiring
  (`risk/scan.ts`, `repo.ts:saveDerivedLabor`), schema (`db/index.ts`), Connecteam
  actual/planned/rate functions, GPS provider + Zonar client, dispatch action handler and stop
  timestamp writers, revenue ingest, and the line-item-titles pull.
- Marked **UNVERIFIED** and not asserted as fact: GS `contract_total` population vs
  `contract_subtotal`; whether `shift_assignments.clock_in/out` is populated today; whether the
  driver/kiosk client actually sends `gps` on actions; whether GPS TrackIt's API exposes/
  retains historical position tracks (must be checked against live credentials before Stage 4a).

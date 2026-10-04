# Cost-Aware Internal-First Staffing Optimization — Design & Analysis

**Status:** Design for review (ANALYSIS ONLY — no production code, schema, config, git, or flyctl changed by this task).
**Author:** Engineering analysis pass, 2026-10-04.
**Scope:** Fold a deterministic, cost-aware, internal-first staffing optimizer INTO the **staffing stage of the
Shift Lifecycle engine** (`docs/shift-lifecycle-engine-analysis.md`). This is NOT a second scheduler — it
extends the existing shift *builder* (`src/lib/scheduling/*`, `/scheduling`) and the lifecycle's proposed
`shift_assignments` entity.

**Cross-reference:** Read `docs/shift-lifecycle-engine-analysis.md` first — it is the parent design. This doc
reuses its `shift_assignments`, `shift_assignment_events`, `scheduling/readiness.ts`, `scheduling/exceptions.ts`,
the runtime `shift-lifecycle` job, and the audit discipline. Where this doc proposes a column or module, it is
an **addition to that design's staffing stage**, never a competing one.

**Governing design law (unchanged):** **RULES CALCULATE. AI INTERPRETS.** Every staffing fact — the internal
fill, the remaining gap, temp exposure, cost, every score, and the recommended plan — is a deterministic rule.
AI only *summarizes* the reasoning ("why temp", "why this route") from already-structured data. We never ask an
LLM for a staffing fact, and an unknown stays `null` (never fabricated — the house rule enforced across
`scheduling/*`, `connecteam.ts`, `instawork/*`, `risk/*`).

**The business objective is NOT lowest total cost.** It is: *minimize unnecessary temp-labor cost while
maintaining complete route coverage, operational readiness, and reasonable workload distribution.* Internal-first
is a strong **preference**, not a hard rule — and we stress-test it below (the "dangerous optimization").

---

## Table of contents

- A. Current implementation (the 13 grounding questions, with file refs)
- B. Optimization gap — what must change
- C. Proposed staffing algorithm (deterministic)
- D. Data-model changes (minimal, additive)
- E. UI changes (dispatcher-facing)
- F. Exception handling (mid-day cancellation, availability/route changes)
- G. Implementation plan (phased, mapped onto the lifecycle phases)
- H. TEMP EXPOSURE metric + staffing metrics (for the dashboard)
- I. Explainability model
- J. Risks + unresolved questions
- K. The explicit "smallest changes first / build first / why" call

---

## A. Current implementation — where staffing reality lives today

Answers to the grounding questions, each with the real file/function/table. **Honest bottom line up front:**
the builder computes demand, nets internal coverage, ranks free internal crew, and surfaces the Instawork gap.
It does **not** compute cost, does **not** optimize across routes, and does **not** persist a temp assignment as
a first-class row — the temp "assignment" today is a *recorded note + two counters* on the demand line.

### A.1 — Where is staffing demand calculated?

`src/lib/scheduling/demand.ts` → `buildDemand(routes, cfg)`. Deterministic, reusing the Event-Risk primitives:
- **DRIVER:** one shift per active route, window = `routeWindow()` (`src/lib/risk/engine.ts:45`, first stop −
  load buffer … last stop + return buffer), `headcount = 1`.
- **FIELD:** `crewForRoute(items).crew − 1` (tent rules in `src/lib/crewRules.ts` — base 1, tent → 2, ≥40×60
  tent → 3), same window as the route.
- **PREP:** one per delivery route, day-level (no `routeId`), `windowKnown = false` (clock time unknown, never
  fabricated).

### A.2 — Where is coverage / the Instawork gap computed?

`src/lib/scheduling/coverage.ts` → `computeCoverage(shifts, scheduledCrew)` returns `DayCoverage` with
`byShift[id].gap`, `internalTotal`, `gapTotal`. It credits explicit app assignees first, then Connecteam-scheduled
crew of the matching role (`CREW_ROLE` map), capped at headcount. **Field is never auto-credited** (Connecteam's
"other" bucket contains office/admin — `coverage.ts:57`). The per-shift `gap` is *the* definition of the Instawork
top-up today.

### A.3 — Where is the existing scoring/ranking (the seed to extend)?

`src/lib/scheduling/availability.ts` → `recommendCrew(shift, dayShifts, roster, limit)`. This is the seed for the
Route Assignment Score (C.4). Today it:
- filters to role-matched crew via `candidateRoles(role)` (driver→`["driver"]`; prep & field→`["prep"]`; office
  "other" never recommended),
- excludes anyone on an **overlapping** Connecteam shift (`overlaps()` by window), and anyone already assigned,
- ranks **least-loaded first** (`bookedHoursByUser` → `bookedHours` ascending, then name).

It is an honest inference from the Connecteam schedule ("free at this window"), not a personal calendar. **It has
no cost term, no cross-route view, and no temp-vs-internal reasoning** — those are the extensions.

### A.4 — Where do workers / assignments live?

- **The shift (demand line):** `staff_shifts` table (`src/lib/db/index.ts:534`). A row is a *crew-demand line*
  (role × headcount × window × route), NOT a per-worker record. Types in `src/lib/scheduling/types.ts`
  (`StaffShift`, `shiftGap()`); CRUD in `src/lib/scheduling/store.ts`.
- **Internal assignees:** `staff_shifts.assignees` — a JSON `number[]` of Connecteam userIds (a *bag* on the
  demand line). Assigned in `AddWorkerPanel.assignConnecteam()` by set-union then `PATCH /api/scheduling/shift/[id]`.
- **Temp "assignment":** there is no per-temp row. `AddWorkerPanel.requestGig()` writes `instawork_headcount`,
  `pay_rate`, and a human-readable note onto the demand line — **recorded, not posted** ("write endpoint pending").
- **Keystone gap (shared with the lifecycle doc):** no per-(shift × worker) entity. The lifecycle design proposes
  `shift_assignments` (its §D.2) to fix exactly this — this optimizer builds on that row.

### A.5 — Where do worker RATES live? (the brief's premise, corrected)

**Both rate sources already exist in code — this is the most important correction to the brief's assumption.**

- **INTERNAL rate:** `getPayRates(start, end)` + `rateForUserOn(rates, userId, date)` in `src/lib/connecteam.ts:333/362`.
  Confirmed-live hourly rates per userId with effective dates. **Already consumed** by
  `src/lib/finance/service.ts:5,84` (labor cost = planned/actual hours × `rateForUserOn`) and tested in
  `src/lib/finance/rate.test.ts`. So internal hourly rate is a **present, proven capability** — it is simply
  **not wired into `scheduling/*` yet.** (The lifecycle doc's §13 matrix lists Connecteam as SoR for pay rate.)
- **TEMP rate:** `InstaworkShift.basePrice` (dollars) in `src/lib/instawork/types.ts:16`, parsed from
  `base_price` in `src/lib/instawork/parse.ts:28`. Also the human-entered `staff_shifts.pay_rate` on a recorded
  gig request.
- **Honest caveat on `basePrice`:** the type comment calls it "pay rate (dollars)" but does not state **per-hour
  vs per-gig**. The brief treats it as the per-gig rate. This must be confirmed against a real gig before any
  cost figure is shown as hourly (J, open question #2). Until confirmed, surface it as "Instawork base price"
  and derive per-hour only when the gig window is known.

### A.6 — Where do route/shift DURATIONS and windows live?

- **Route window:** `routeWindow()` (`src/lib/risk/engine.ts:45`) → `{startUnix, endUnix, known}`. Duration =
  `(endUnix − startUnix)/3600` hours. Used verbatim by `demand.ts` and `scheduling/page.tsx:routeOwnWindow`.
- **Shift window:** `staff_shifts.start_time`/`end_time` (ISO) + `window_known`. A shift with no known window is
  `windowKnown=false` and reads "Set time" in the UI — its duration is **UNKNOWN**, so any hours/cost figure that
  depends on it must stay `null` (never 0).
- **Instawork gig window:** `startsAt`/`endsAt` on `InstaworkShift`; `src/lib/connecteam.ts:440 shiftClock()`
  formats clock times.

### A.7 — How is "qualified" defined today?

Purely **role/title match**: `roleFromTitle()` (`connecteam.ts:142`, Title → `driver|prep|other`) +
`candidateRoles()` (`availability.ts:18`). There is **no skills/certification/truck-class/geography model**. A
"qualified internal employee" for a driver shift today = a Connecteam user whose Title contains "driver". This is
a real limitation to name (J, open question #3): e.g. box-truck vs CDL, tent-certified, is not modeled.

### A.8 — Where does Connecteam enter?

`src/lib/connecteam.ts`. Reads: `getUsersList` (roster+titles), `getCrewForDateSafe` (who's scheduled, with an
`ok` reachability flag), `getPayRates` (rates), `getActualHours`/`getPlannedHours`/`getTimeClocks` (timekeeping,
**day-grain** `dailyTotalHours`). Writes: `createPublishedShift`/`updatePublishedShift` (publish + notify). The
scheduling page pulls `getCrewForDateSafe` + `getUsersList` (`page.tsx:116`) and feeds `recommendCrew`.

### A.9 — Where does Instawork enter?

`src/lib/instawork/*` — **read-only browser-pull snapshot** (the server can't call Instawork; Cloudflare blocks
it). `client.getInstaworkShifts()` reads the snapshot; `reconcile.ts` matches gigs to routes
(`instaworkGigsForRoute`, `summarizeInstaworkByRole`) by day + position→role + window overlap; `monitor.ts`
infers drop-offs. Captured per gig group: `id, name, startsAt, endsAt, position, basePrice, filled, total,
locationName, workers: string[] (NAMES ONLY), interestedPending`. **Not captured:** worker phone, worker id,
clock codes, messaging, and the gig-post *write* (lifecycle doc §E.2).

### A.10 — Where could the optimizer safely live?

As a **new pure module `src/lib/scheduling/optimize.ts`**, a sibling of `coverage.ts`/`availability.ts`, consumed
by the staffing stage of the lifecycle engine and by `scheduling/page.tsx`. It takes the same already-computed
inputs the page already assembles (shifts, coverage, roster, Connecteam day-shifts, Instawork snapshot, rates)
and returns a deterministic `StaffingPlan`. **No new workflow, no new page.** It plugs into the exact seam where
`recommendCrew` is called today (`page.tsx:151,209`).

### A.11 — How do assignments persist and change today?

API: `POST /api/scheduling/shift` (create), `PATCH /api/scheduling/shift/[id]` (assignees/headcount/status/
instaworkHeadcount/payRate/notes), `POST /api/scheduling/shift/[id]/publish` (Connecteam). `store.updateShift`
writes the columns; `syncDemand` refreshes derived drafts but **skips any human-touched row** (`store.ts:243`:
`status !== 'draft' || assignees.length>0 || instaworkHeadcount>0`). An optimizer-applied plan must respect that
same "don't clobber human intent" guard.

### A.12 — How does readiness react today?

There is **no shift-level readiness yet** — it is *designed* in the lifecycle doc (§4 `scheduling/readiness.ts`,
five components STAFFING/LOGISTICS/COMMUNICATION/TIMEKEEPING/CONFIRMATION) but **not built**. The only live
readiness is *event*-level (`src/lib/risk/readiness.ts`, weighted-component model this optimizer's scoring mirrors
in shape). The optimizer must feed, and recompute against, the lifecycle's STAFFING component once that exists.

### A.13 — How does audit react today?

`src/lib/history/store.ts` → `logChange()` (append-only, idempotent by `change_key`) + `event_snapshots`/
`event_outcomes`; generic `audit_logs` table + `insertAudit()`. The lifecycle doc proposes the shift-level
`shift_assignment_events` log (its §D.3). Temp-assignment reasons + dispatcher overrides are recorded there
(D.3 below) using the exact `change_key` dedup discipline.

---

## B. Optimization gap — what must change

1. **No cost awareness anywhere in `scheduling/*`.** The board shows "Gap → Instawork: N" (a count) with no
   dollars, no internal-vs-temp premium, no temp hours. Rate data exists (A.5) but is not plumbed in.
2. **No global, whole-day optimization.** Assignment is route-by-route and manual: the dispatcher opens a route,
   picks from `recommendCrew`, repeats. Nothing reasons across routes, so the **dangerous optimization** (internal
   stuck on a 10h route while a temp takes a 2h route) is invisible and un-prevented.
3. **No explicit temp-exposure minimization.** "Internal first" is enforced only by UI ordering
   (`AddWorkerPanel` shows Connecteam before Instawork). There is no rule that *computes* the minimum temp
   footprint or prefers shorter routes for temps.
4. **`recommendCrew` ranks on load only.** It needs to be extended into a Route **Assignment Score** that also
   weighs qualification, internal preference, temp-hour minimization, and workload balance — without losing its
   honest, deterministic character.
5. **No temp assignment as a first-class fact.** Temp is a counter + a note; there's no row to carry "which temp,
   on which route, why temp, why this route, at what cost, approved by whom". The lifecycle's `shift_assignments`
   is the place for it.
6. **No preview / no "no better plan exists" honesty.** There is no staffing plan the dispatcher can see,
   compare, and apply — and crucially no way to say *"the current assignment is already optimal"* instead of
   manufacturing a fake saving.

---

## C. Proposed staffing algorithm (deterministic)

New pure module **`src/lib/scheduling/optimize.ts`**. Signature (all inputs already assembled by
`scheduling/page.tsx` today):

```ts
function optimizeStaffing(input: {
  date: string;
  shifts: StaffShift[];                       // the day's demand lines (driver/field/prep)
  coverage: DayCoverage;                      // from computeCoverage (the gap of record)
  roster: CrewMember[];                        // Connecteam users + titles (qualification)
  dayShifts: CrewShift[];                      // Connecteam schedule that day (availability/overlap/load)
  rates: Map<number, PayRate[]>;              // getPayRates → internal $/h (rateForUserOn)
  instawork: { ok: boolean; gigs: InstaworkShift[] }; // temp supply + basePrice (UNVERIFIED-aware)
  cfg: StaffingCostConfig;                     // temp premium fallback, weights, buffers (D.4)
  now: number;
}): StaffingPlan
```

`StaffingPlan` = the recommended assignment set + per-assignment reasons + the day's temp-exposure totals + a
`betterThanCurrent: boolean` (false → "already optimal", said plainly; never a manufactured saving).

### C.1 — Hard constraints vs preferences (kept strictly separate)

**HARD (a plan that violates any of these is invalid and is never proposed):**
- Worker **availability** — not on an overlapping Connecteam shift (`overlaps()`), honoring `ok`-reachability
  (an UNVERIFIED Connecteam/Instawork is UNKNOWN, never assumed free/booked).
- **Qualification** — role/title match (`candidateRoles`) (today's definition; A.7).
- **Max hours** — a per-worker daily cap (config, default e.g. 12h; no legal number hardcoded without Zoe's input).
- **No shift overlap** for the same worker across routes.
- **Required count & required roles** per shift (`headcount`, role).
- **Route timing** — the worker's assignment must fit the route window (`windowKnown` required to assert a fit;
  unknown window → cannot hard-assign, surfaced as a gap, never force-fit).
- **Already committed elsewhere** — explicit assignees / booked gigs are fixed points.
- **Company scheduling constraints** — e.g. prep is day-level, field never auto-credits office (existing rules).

**PREFERENCES (what we optimize, in priority order):**
internal utilization → minimize temp *usage* (count) → minimize temp *hours* → prefer **shorter** eligible
routes for temps → avoid idle time → workload balance → operational simplicity (fewer reassignments) → preserve
readiness. None of these is ever promoted to a hard constraint without a real operational reason.

### C.2 — The three-stage deterministic pipeline

**Stage 1 — Internal-first feasible fill (honoring all hard constraints).**
For every shift, build the eligible internal pool (`recommendCrew`-style filter). Compute the coverage gap exactly
as `computeCoverage` does today (reuse it — don't reinvent the gap). This establishes the *maximum feasible
internal coverage* and the *irreducible temp gap*.

**Stage 2 — Compute the remaining gap = the temp requirement.**
`gap = headcount − feasibleInternal`, per shift and summed per day. This is the number of temp seats that MUST be
filled regardless of optimization — the floor. Temp exposure can never go below it while keeping coverage
complete.

**Stage 3 — Global (whole-day) temp placement that minimizes exposure.**
This is the step the current builder lacks. Instead of filling each route's gap with a temp locally, we decide
**which routes the temps land on** across the whole day, so internal crew are steered onto the routes where they
displace the most temp *hours*. Tractable heuristic (stated explicitly, no solver needed):

> **Longest-route-internal-first assignment.** Sort all route-shifts by duration **descending**. Walk them,
> assigning the best-scoring *internal* candidates first (C.4 score). Because internal supply is finite, the
> routes that end up needing temps are the **remaining (shorter) ones** — which is exactly "prefer shorter routes
> for temps." Then, a bounded **improvement pass**: for each (internal-on-short, temp-on-long) pair, test a swap;
> if the swap is feasible (all hard constraints hold) and reduces total temp hours (or temp count), apply it.
> Repeat until no improving feasible swap remains (a local optimum; a day has ~5–15 route-shifts, so this is
> cheap and deterministic — ordering ties broken by name/id for stability).

This directly prevents the **dangerous optimization**: a temp on a 10h route while an internal sits on a 2h route
is precisely the pair the improvement pass detects and swaps, whenever the swap is feasible. The objective the
pass minimizes is **temp hours first, then temp count**, with internal-utilization as the tie-breaker — matching
the business objective (not lowest total cost).

**Why not a true cost minimizer?** Because the objective is *not* lowest total cost. A pure cost solver would, for
example, bench an internal worker (idle, still paid or under-utilized) to shave a marginal dollar — violating
"reasonable workload distribution" and "avoid idle time". We minimize **avoidable temp exposure** subject to full
coverage + readiness, which is both the stated goal and simpler to keep correct and explainable.

### C.3 — Where cost enters (and where it deliberately does NOT)

Cost is computed for **display, ranking tie-breaks, and the temp-exposure metric** — not as the primary
objective. Per assignment:
- internal cost = `rateForUserOn(rates, userId, date) × shiftHours` (null if rate or window unknown → shown
  "rate unknown", never 0).
- temp cost = `basePrice`-derived (per-gig or per-hour once confirmed; A.5 caveat) × seats, or
  `pay_rate × hours` for a recorded gig.
- **Incremental/premium** = `tempCost − equivalentInternalCost`. The **temp premium multiplier** is *measured
  from real data* (`avg temp $/h ÷ avg internal $/h`) when both exist, and only falls back to a **config value**
  (`cfg.tempPremiumFallback`) when one side is unknown — **never hardcoded to 2×** (the brief's ~2× is Zoe's
  anecdote, used only as the config default the user can set).

### C.4 — Route Assignment Score (extends `recommendCrew`, justified weights)

`recommendCrew` today returns candidates ranked by `bookedHours` ascending. We extend it into a score used **both**
to pick internal candidates per shift and to drive the Stage-3 swap decisions. The score is intentionally a small,
additive, explainable sum (same philosophy as `risk/readiness.ts` weighted components — not an opaque formula):

```
score(worker, shift) =
    FEASIBILITY_GATE           // 0/invalid if any HARD constraint fails (short-circuit — never scored past this)
  + W_qual   * qualification   // exact role/title match = 1; (future: skill/truck-class match)
  + W_intern * internalPref    // internal = 1, temp = 0  (internal-first PREFERENCE, not a gate)
  + W_tempHr * tempHourSaving   // normalized: temp hours this assignment AVOIDS (longer route → higher)
  + W_load   * loadBalance      // least-loaded-first, reusing bookedHoursByUser (inverse of booked hours)
  + W_simple * continuity       // small bonus to keep an existing feasible assignment (fewer reassignments)
```

**Weight justification (not arbitrary — derived from the stated priority order, to be tuned once Zoe reacts, the
same "documented so it's easy to tune" posture as `demand.ts`):**
- `W_qual` **dominant** (e.g. 100) — qualification is near-hard; a mis-qualified pick should never outrank a
  qualified one. (It's modeled as a huge weight rather than a pure gate only so "qualified but busy" degrades
  gracefully to the next candidate.)
- `W_intern` **high** (e.g. 40) — encodes internal-first as a strong preference *below* qualification.
- `W_tempHr` **high, and the lever that beats naive internal-first** (e.g. 35) — this is what makes
  internal→long-route / temp→short-route win: assigning an internal to a long route scores higher because it
  avoids more temp hours. Set close to `W_intern` so the two trade off (that trade-off IS the anti-dangerous-
  optimization behavior).
- `W_load` **medium** (e.g. 15) — preserves `recommendCrew`'s least-loaded fairness / workload balance.
- `W_simple` **low** (e.g. 5) — only breaks ties toward stability so the plan doesn't churn assignments for a
  negligible gain.

All weights live in `StaffingCostConfig` (D.4), defaulted here, overridable in `/admin` — no magic numbers buried
in code. The score is **pure and unit-testable** exactly like `coverage.ts`/`availability.ts`.

### C.5 — "Global, not route-by-route," stated precisely

The whole-day guarantee is delivered by (a) Stage-3's **duration-descending** internal assignment (so temps fall
to short routes by construction) and (b) the **bounded feasible-swap improvement pass** over cross-route
(internal, temp) pairs. It is a heuristic reaching a local optimum, not an ILP — deliberately, because the input
is tiny (a day of routes) and a transparent, deterministic heuristic is far easier to explain, test, and trust
than a solver (and never produces an un-explainable assignment). If Zoe ever needs provably-optimal plans at much
larger scale, the module boundary allows swapping the internals later without touching callers.

---

## D. Data-model changes (ONLY what's necessary; additive + nullable; reuse the lifecycle entity)

**Principle:** no new parallel tables where the lifecycle design already proposes one. Add temp-reasoning +
override + cost-cache fields to the **lifecycle's `shift_assignments`**, add a small **rate config** source, and
reuse `shift_assignment_events` for the audit.

### D.1 — Extend `shift_assignments` (the lifecycle's keystone entity) with staffing-economics fields

These are **additions to the lifecycle doc's §D.2 `shift_assignments`**, all nullable:

```sql
-- why a temp was used at all, and why THIS route (deterministic strings from optimize.ts, not free text)
ALTER TABLE shift_assignments ADD COLUMN temp_reason     TEXT;   -- e.g. 'no_internal_qualified' | 'internal_exhausted' | 'internal_cancellation' | 'dispatcher_override'
ALTER TABLE shift_assignments ADD COLUMN route_reason    TEXT;   -- e.g. 'shortest_eligible_route' | 'only_matching_window' | 'dispatcher_choice'
-- cost snapshot at assignment time (a MIRROR for display/audit; the rate SoR stays Connecteam/Instawork)
ALTER TABLE shift_assignments ADD COLUMN est_hours       REAL;   -- shift hours used for cost (null if window unknown)
ALTER TABLE shift_assignments ADD COLUMN est_rate        REAL;   -- $/h used (internal: rateForUserOn; temp: basePrice-derived); null = unknown
ALTER TABLE shift_assignments ADD COLUMN est_cost        REAL;   -- est_hours * est_rate (null if either unknown — never 0)
-- dispatcher override of the optimizer's recommendation
ALTER TABLE shift_assignments ADD COLUMN overridden      INTEGER DEFAULT 0;
ALTER TABLE shift_assignments ADD COLUMN override_reason TEXT;   -- required when overridden=1
```

If `shift_assignments` does not exist yet (lifecycle Phase 0 not built), these fields are specified here and
added **with** that table — this optimizer does not create a competing row.

### D.2 — Rate config (the one genuinely missing piece — small)

Internal rates come from Connecteam (`getPayRates`, A.5) — **no new per-worker rate column is needed.** What is
missing is a **small config** for the parameters the optimizer needs when live data is absent:

```
-- stored in the existing `settings` KV (src/lib/settings.ts) with env defaults, surfaced in /admin:
staffing.tempPremiumFallback   -- multiplier used ONLY when one side's rate is unknown (default from Zoe, e.g. 2.0)
staffing.maxWorkerHours        -- hard cap per worker per day (default TBD with Zoe)
staffing.loadBufferRespected   -- reuse risk cfg; no new value
staffing.weights.{qual,intern,tempHr,load,simple}  -- the C.4 weights, defaulted, tunable
```

No schema table for this — it's KV in `settings` (the pattern the app already uses for templates/PINs/provider
config). **Honest note:** if Zoe wants a *manual* internal rate for workers Connecteam has no rate for, add a
single nullable `settings`-backed default internal $/h — still no per-worker table.

### D.3 — Audit: reuse `shift_assignment_events` + `logChange`

Every optimizer apply, every temp assignment with its `temp_reason`/`route_reason`, and every dispatcher override
with `override_reason` is written to the lifecycle's `shift_assignment_events` (kind = `assigned` | `reassigned` |
`override`), `actor` = `currentActor` for a human apply/override or a named `system` actor for an auto-apply
(per the attribution memory rule), deduped by `change_key` (same discipline as `history/store.ts:logChange`). No
new audit table.

### D.4 — `StaffingCostConfig` (a type, not a table)

A plain config object (defaults in `optimize.ts`, overrides from `settings`): `{ tempPremiumFallback,
maxWorkerHours, weights:{qual,intern,tempHr,load,simple} }`. Keeps every tunable number out of the algorithm body.

---

## E. UI changes (extend `RouteStaffBoard`/`AddWorkerPanel` — do NOT replace)

All additive, within `(console)/scheduling` + the Nocturne primitives the board already uses (`FigureStrip`,
`SidePanelOverlay`, `surface`).

### E.1 — Day-level economics in the `FigureStrip` (`scheduling/page.tsx:229`)

Extend the existing four figures with temp-exposure figures (shown only when rates are known; "—" when unknown,
never 0):
- **Internal coverage** (people + % of labor hours internal),
- **Temp count** and **Temp hours**,
- **Temp cost** (and **incremental cost vs internal** = the premium),
- **Temp hours as % of total labor hours**.

### E.2 — Staffing Plan / optimization PREVIEW (the headline new surface)

A card above/beside the board: *"Optimized plan: ↓ X temp hours, ↓ $Y vs the current assignment"* with
**[Preview]** → shows the diff (which internal moves to which route, which temp seat is eliminated/shortened) and
**[Apply optimized plan]**. Apply calls a new `POST /api/scheduling/optimize/apply` that performs the same
`PATCH`es the dispatcher would do by hand (respecting the `syncDemand` "don't clobber human-touched" guard,
A.11), inside a transaction, logging to `shift_assignment_events`.

**Honesty rule (hard):** when `plan.betterThanCurrent === false`, the card says **"Current staffing is already
optimal — no temp hours can be avoided without breaking coverage or a constraint."** It **never** manufactures a
saving. If the gap is irreducible (not enough internal supply), it says so and shows the floor.

### E.3 — Per-assignment "WHY TEMP?" + "WHY THIS ROUTE?" (in `RouteStaffBoard` RouteCard + `AddWorkerPanel`)

Each temp line on a route card carries a short deterministic reason chip from `temp_reason`/`route_reason`
("No internal driver free this window", "Shortest eligible route"). `AddWorkerPanel`'s Instawork step shows the
same, so the dispatcher sees *why the optimizer reached for a temp here* before posting.

### E.4 — Dispatcher OVERRIDE flow

Any manual assignment that contradicts the optimizer is allowed (the dispatcher is in charge), but: it
**validates** against hard constraints first (reusing the same feasibility check), then **recomputes** readiness +
cost + temp exposure live, then **records the override + a required reason** to `shift_assignment_events`
(`overridden=1`, `override_reason`), then **continues the lifecycle** (re-enters the staffing stage so downstream
states/readiness reflect the override). A hard-constraint violation is refused with the specific reason (e.g.
"over max hours", "not qualified"), not silently applied.

### E.5 — Readiness/exception hooks

The optimizer feeds the lifecycle's STAFFING readiness component (its §4) and raises/clears the **Understaffed**
exception (lifecycle §H #1) deterministically — no separate scoring.

---

## F. Exception handling (fold into the lifecycle's exception queue — no new queue)

All of these are **detections added to `scanShiftExceptions`** (lifecycle doc §H) that call back into
`optimize.ts` for the replacement recommendation:

- **Internal cancellation mid-day** → detect the assignee is no longer available (removed assignee / Connecteam
  change) → `optimize.ts` identifies a replacement with the **priority: other qualified internal first, then
  Instawork** → recompute readiness + cost + temp exposure → surface **"TEMP REQUIRED: reason = internal
  cancellation, route = R, +N temp hours, est. additional cost $Z"** (RED if near/after start) → one-click
  reassign / post-gig. Logged with `temp_reason = 'internal_cancellation'`.
- **Availability change** (someone picked up another shift, now overlaps) → re-run feasibility → if the current
  plan is now invalid, propose the minimal feasible repair (smallest temp-exposure delta).
- **Route time / location change** (GS pull moves a window) → windows recompute (`routeWindow`), overlaps re-check,
  plan revalidated; a shift that loses its known window drops to "Set time" and its cost goes UNKNOWN (never 0).
- **Late staffing gap** (gap > 0 as start approaches) → severity escalates by proximity (YELLOW → RED), exactly
  the lifecycle's Understaffed rule; the optimizer always shows the cheapest feasible fill.

These reuse the lifecycle's runtime `shift-lifecycle` job (its §G) for recompute-on-tick — the optimizer is a pure
function the tick calls; it adds no new timer infrastructure.

---

## G. Implementation plan (smallest-safe-first; mapped onto the lifecycle phases)

The optimizer rides the lifecycle phases — it is the **staffing stage's brain**, so it builds *with* Phases 0–2,
not after.

- **Opt-Phase A — cost plumbing (pure, no behavior change). Smallest safe first.**
  Wire `getPayRates`/`rateForUserOn` + `basePrice` into a pure `src/lib/scheduling/cost.ts` (`shiftLaborCost`,
  `tempPremium`). Add the day-economics figures to the `FigureStrip` (read-only). **No assignment changes, no
  writes.** Unit tests mirroring `coverage.test.ts`. Ships value immediately (dispatcher finally sees temp $),
  zero risk. *Maps to lifecycle Phase 0/1.*
- **Opt-Phase B — the optimizer as a read-only recommendation.**
  `src/lib/scheduling/optimize.ts` (Stages 1–3 + the C.4 score) returning a `StaffingPlan`, surfaced as the
  **Preview** card (E.2) with the diff — but **no Apply yet**. Pure, deterministic, fully testable (including the
  anti-dangerous-optimization swap and the "already optimal" case). *Maps to lifecycle Phase 1 (readiness) — feeds
  STAFFING.*
- **Opt-Phase C — Apply + override + audit.**
  `POST /api/scheduling/optimize/apply` (transactional `PATCH`es, respects the human-touched guard); the override
  flow (E.4); writes to `shift_assignment_events`. Requires the lifecycle's `shift_assignments` (Phase 0) to exist.
  *Maps to lifecycle Phase 2.*
- **Opt-Phase D — exceptions + mid-day replacement.**
  The F detections inside `scanShiftExceptions` + the runtime tick recompute. *Maps to lifecycle Phase 2
  (exception queue).*
- **Opt-Phase E — temp provisioning economics.**
  Once the lifecycle captures the Instawork gig-post write (its Phase 5), the optimizer's recommended temp seats
  (with shortest-route placement + rate) become the actual posted gig. Until then, Apply only records the request
  (today's honest `AddWorkerPanel` posture). *Maps to lifecycle Phase 5.*

Each phase is independently shippable, test-covered, additive, and reversible. **Buildable now without the
lifecycle entity:** Opt-Phases A and B (cost display + read-only plan) — they only read existing data. **Depends
on `shift_assignments` existing:** Opt-Phases C–D (persisting temp reasons/overrides). **Depends on the Instawork
write capture:** Opt-Phase E.

---

## H. TEMP EXPOSURE metric + staffing metrics (deterministic; feed the dashboard)

**TEMP EXPOSURE (the headline metric), per day (and roll-up per week/month):**
- `tempCount` = temp seats filled,
- `tempHours` = Σ temp seat hours (null for any seat whose window is unknown — excluded, flagged, never 0),
- `tempCost` = Σ temp seat cost (basePrice-derived; null-aware),
- `tempHourShare` = tempHours ÷ totalLaborHours,
- `incrementalTempCost` = tempCost − (those same hours costed at internal rates) = the **premium paid** for using
  temps,
- `avoidableTempCost` = the portion of `incrementalTempCost` the optimizer's plan can remove while keeping full
  coverage (0 when "already optimal" — this is the number [Apply] reduces, and the ONLY "saving" ever shown).

**Supporting staffing metrics (each deterministic, UNKNOWN-honest):**
`internalUtilization` (internal hours ÷ internal capacity), `tempUtilization` (temp hours ÷ total),
`internalCoverage` (% of required seats filled internally), `tempPremium` (measured multiplier),
`workloadBalance` (spread of hours across internal crew — flags the idle/overloaded split).

**Where they feed:** the Scheduling `FigureStrip` (per day) and the **Command Center** (`commandCenter()`
aggregation, per the command-center memory) as a staffing-cost tile, and the Financial-Intelligence labor view
(which already costs Connecteam hours — `finance/service.ts`) so temp premium shows next to the existing labor
scorecard. No new dashboard framework.

---

## I. Explainability model (RULES CALCULATE, AI INTERPRETS)

- **Every fact is a rule:** the plan, each `temp_reason`/`route_reason`, each score term, each cost, the
  avoidable-cost number — all computed in `optimize.ts`/`cost.ts`, all reproducible, all unit-tested.
- **AI only summarizes:** an optional, dormant-by-default layer (like `src/lib/llm.ts`) turns the deterministic
  reason set into one dispatcher-readable sentence ("Used 2 temps today: no internal drivers were free for the
  10am–6pm routes; both placed on the shortest routes, +6 temp hours, +$130 vs internal"). It **never** sets an
  assignment, a score, a cost, or decides staffed/not. House comms style (no dashes/emoji) via `COMMS_STYLE`.
- **Honesty guarantees:** unknown rate/window → UNKNOWN (never 0); UNVERIFIED Connecteam/Instawork → the affected
  figures are UNKNOWN, not a fabricated gap or saving; "no better plan" is stated plainly.

---

## J. Risks + unresolved questions

**Risks**
- **`basePrice` semantics (per-gig vs per-hour) unconfirmed** — every temp $/h figure depends on resolving this;
  until confirmed, show "base price", not an hourly premium.
- **Qualification is only role/title today** — the optimizer can enforce no more than the data models. Treating
  "driver title = qualified" may over- or under-match (CDL/box-truck, tent certification not modeled).
- **Instawork is read-only, name-only, no write** — temp *placement* is a recommendation + recorded request until
  the gig-post write is captured (lifecycle Phase 5). Over-promising "the optimizer books temps" is the biggest
  honesty risk.
- **Internal rate coverage gaps** — a worker with no Connecteam rate yields UNKNOWN cost; the plan must still
  function on hours/count (don't let a missing rate block an assignment).
- **Day-grain timekeeping** — actual-hours are daily totals (`getActualHours`), so realized (vs planned) temp
  cost is day-grain, not punch-precise.
- **Heuristic local optimum** — the swap pass finds a good, explainable plan, not a proven global optimum; for
  Zoe's scale this is the right trade, but it should be labeled a recommendation, not "the optimum".

**Unresolved questions (need a user decision before implementation)**
1. **Internal rate source — confirm the policy:** use Connecteam `getPayRates` as the sole internal-rate SoR
   (already proven in finance), with a single `settings` default only for workers Connecteam has no rate for? Or
   does Zoe want to maintain internal rates in `/admin` independent of Connecteam?
2. **Is `basePrice` per-gig or per-hour**, and what is the real temp-vs-internal premium to seed
   `tempPremiumFallback` (the brief's ~2× is anecdotal — confirm the number, don't hardcode)?
3. **Qualification beyond role/title** — does Zoe need skills/certs/truck-class/geography in the match, or is
   title-match acceptable for v1? (Determines whether qualification stays a weight or needs a data model.)
4. **`maxWorkerHours` cap** — the real daily hour ceiling (and any overtime threshold) to use as the hard
   constraint.
5. **Auto-apply vs preview-only** — should the optimizer ever auto-apply its plan (e.g. on the runtime tick for
   far-out days), or always require a dispatcher [Apply]? (Recommend preview-only first, matching the existing
   "wired next" posture.)

---

## K. The explicit call — smallest changes required, what to build first, and why

**Smallest changes required to deliver the core value:** a pure `cost.ts` (wiring the *already-present*
`getPayRates`/`rateForUserOn` + `basePrice` into hours×rate) plus a pure `optimize.ts` (internal-first feasible
fill → gap → duration-descending placement + bounded feasible-swap), surfaced as **read-only** day-economics
figures and a Preview card. **No schema change, no writes, no new workflow** — it only reads what
`scheduling/page.tsx` already assembles and extends `recommendCrew`'s ranking.

**Build first (Opt-Phases A + B):** cost display + the read-only optimized-plan Preview. This is where the
objective lands — the dispatcher finally sees temp hours/cost and a concrete "↓ X temp hours ↓ $Y" (or an honest
"already optimal") — and it is **pure, deterministic, low-risk, fully testable, and needs no new capability**
(rates exist, the gap calculator exists, the score is an extension of a tested function). It prevents the
dangerous optimization in recommendation form immediately.

**Build next (Opt-Phase C):** Apply + override + audit — but only once the lifecycle's `shift_assignments` exists
(the keystone this optimizer persists temp reasons/overrides on; do not create a competing row).

**Wait (Opt-Phases D–E):** mid-day exception replacement (rides the lifecycle exception queue + runtime tick) and
real temp booking (depends on the Instawork gig-post write capture). Shipping "the optimizer books the cheapest
temp" before that write is captured would mean faking a capability — so recommend + record until it's proven,
exactly as the current `AddWorkerPanel` already does.

**Why this order:** it mirrors the lifecycle doc's own law — *make the facts visible and deterministic first
(cost + plan, now, read-only) → persist and act on them (apply/override) once the entity exists → book temps once
the API is captured* — delivering dispatcher value in the first phase while never fabricating a saving, a rate, or
a capability the code doesn't yet have.

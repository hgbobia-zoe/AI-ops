# Auto Staffing / Dispatch Planning Engine — Design & Analysis

**Status:** Design for review (ANALYSIS ONLY — no production code, schema, config, git, or flyctl changed by this task).
**Author:** Engineering analysis pass, 2026-10-04.
**Scope:** Refine the existing Scheduling blade into a one-click **AUTO STAFF** planning engine, and merge the
Scheduling + Staffing blades into one. This is a **refinement/consolidation of what already exists**, not a rebuild.

**Read alongside:**
- `docs/shift-lifecycle-engine-analysis.md` — the shift + per-worker lifecycle/readiness/exception engine (the "plan stays dynamic" machinery).
- `docs/shift-staffing-cost-optimization.md` — the deterministic internal-first optimizer (`optimize.ts`) this engine is built on.
- `docs/financial-intelligence-labor-attribution.md` — how committed assignments feed labor cost attribution downstream.

---

## 0. TL;DR — how much already exists

**~85% of the Auto Staff engine is already built and shipping.** The deterministic plan engine
(`optimize.ts`), the preview UI (`StaffingPlanPreview.tsx`), the live **Apply** write path
(`/api/scheduling/optimize/apply`), the override flow (`PATCH /shift/[id]` with `overrideReason`), the
dynamic lifecycle/readiness/exception tick (`lifecycleTick.ts`), the cost economics (`cost.ts`), the
Connecteam coverage netting (`coverage.ts`), the availability recommender (`availability.ts`), and the
route-centric board (`RouteStaffBoard.tsx`) all exist, are unit-tested, and are wired into `/scheduling`.

**What is genuinely new is thin orchestration + surfacing:**
1. One prominent **AUTO STAFF** button that runs generate → optimize → preview in a single action (today it is three separate affordances).
2. A **plan summary card** + richer route cards (stops/addresses/kind pulled from the Goodshuffle route that is already in hand).
3. Merging `/staffing` into `/scheduling` (the Staffing blade is a thin read-only Connecteam roster view that `/scheduling` already largely subsumes).
4. A few honesty-driven state labels (SCHEDULED / AVAILABLE / BLOCKED / UNKNOWN) — some of which the **current integration data cannot yet support** (see §7).

**Two capability gaps the user's brief assumes but the code does NOT have today** (design the honest path, do not pretend):
- **Instawork publish is NOT wired** — the integration *reads* a browser-pulled gig snapshot and *reconciles* fills; posting a gig is explicitly "a separate, paid action captured/built later" (`instawork/types.ts`). Auto Staff → gap → Instawork is **suggest + record + (manual publish)** today.
- **Connecteam exposes only SCHEDULED shifts, NOT time-off / blocked availability.** `recommendCrew` infers "free" as "not on an overlapping scheduled shift." True BLOCKED / PTO / unavailability is **not fetched by any code in the repo** and cannot be honestly shown until a time-off endpoint is wired.

---

## 1. Current state — exactly how Scheduling + Staffing work today

### 1.1 The two blades

| Blade | File | What it is today |
|---|---|---|
| **Scheduling** | `src/app/(console)/scheduling/page.tsx` (+ `RouteStaffBoard.tsx`, `AddWorkerPanel.tsx`, `ShiftEditor.tsx`, `StaffingPlanPreview.tsx`, `ShiftReadinessExceptions.tsx`) | The **app-owned shift builder** and the real engine. Derives demand from routes, nets Connecteam coverage, recommends free crew, shows the optimizer preview + Apply, readiness + exception queue, day economics (FigureStrip), per-route cards with Add-worker + Move-to-route. |
| **Staffing** | `src/app/(console)/staffing/page.tsx` (+ `OpenShiftsPanel.tsx`, `lib/staffing/openShifts.ts`) | A **thin read-only Connecteam roster view**: who is scheduled by role (Prep day-before / Drivers event-day / Unload after-pickup / Office), the Connecteam **open-shift** detector with free-crew suggestions, and a "Routes & crew needed" table (tent rules). No app-owned shifts, no writes. |

Both are registered in `ConsoleNav.tsx` (lines 87-88) under **Operations**, adjacent.

### 1.2 The deterministic pipeline (all in `src/lib/scheduling/*`)

```
Goodshuffle routes (getRoutesForDate)
  → demand.ts     buildDemand()      routes → DemandShift[] (driver 1/route, field = crewForRoute-1, prep = N delivery routes, day-level)
  → store.ts      syncDemand()       materialize idempotently into staff_shifts (never clobbers human-touched rows)
  → coverage.ts   computeCoverage()  net Connecteam scheduled crew against demand → per-shift {covered, gap}
  → availability.ts recommendCrew()  free, role-matched internal crew, least-loaded-first, office/admin excluded
  → optimize.ts   optimizeStaffing() DETERMINISTIC whole-day plan: internal-first, longest-routes-first + bounded anti-"dangerous" swap
  → cost.ts       computeTempExposure() hours × rate economics; unknown → null, never fabricated
  → readiness.ts  computeShiftReadiness() STAFFING/LOGISTICS/COMMUNICATION/TIMEKEEPING/CONFIRMATION → READY/BLOCKED/UNVERIFIED
  → exceptions.ts scanShiftExceptions() RED/YELLOW actionable queue
  → lifecycle.ts  deriveShiftLifecycle() DRAFT..COMPLETE state machine (deterministic roll-up)
  → lifecycleTick.ts runShiftLifecycleTick() runtime: reconcile IW fills, mirror CT clocks, recompute, persist exceptions, Slack REDs
```

Every module is **pure + unit-tested** (there is a `*.test.ts` beside each). The design law throughout is
**RULES CALCULATE, FACTS ONLY** — an unknown stays `null`/UNVERIFIED, never fabricated to 0 or RED. No LLM
is in this path anywhere, which matches the user's "RULES CALCULATE, AI INTERPRETS" requirement.

### 1.3 The data model (all tables already exist — `src/lib/db/index.ts`)

- **`staff_shifts`** (ln 576) — the app-owned crew-demand line. `assignees` (JSON `number[]` of Connecteam userIds) is the SoR the board reads. Lifecycle/logistics columns (`lifecycle_state`, `supervisor_user_id`, `report_location`, `report_time`, `equipment`, `instructions`, `readiness_json`) added by migration (ln 1666+).
- **`shift_assignments`** (ln 617) — the keystone **one row per (shift × worker)** entity. Carries state machine, packet/confirm/clock linkage, `no_show`, and the optimizer economics snapshot (`temp_reason`, `route_reason`, `est_hours/rate/cost`, `overridden`, `override_reason`). `UNIQUE(shift_id, worker_kind, connecteam_user_id, instawork_worker)` → idempotent.
- **`shift_packets`** (ln 650) — versioned structured packet (content-hash versioned).
- **`shift_assignment_events`** (ln 660) — append-only audit log, `change_key UNIQUE` dedup. Event kinds already include `assigned | override | reassigned | state_change | clock_in | …`.
- **`shift_exceptions`** (ln 678) — persisted RED/YELLOW queue, stable `signature`, idempotent reconcile.

### 1.4 Already-built vs missing — mapped to the user's asks

| # | User ask | Status | Where / what's needed |
|---|---|---|---|
| 1 | Pull routes | **Built** | `getRoutesForDate` + office Auto-Pull (`gsPull.ts`); routes already on the board. |
| 2 | Understand route requirements (crew/role) | **Built** | `demand.ts buildDemand` + `crewRules.crewForRoute` (tent rules); `routeWindow` for windows. |
| 3 | Analyze internal availability | **Built (inference only)** | `availability.ts recommendCrew` — free = not on an overlapping CT scheduled shift. **No true time-off data (§7).** |
| 4 | Automatically build best internal plan | **Built** | `optimize.ts optimizeStaffing` — deterministic internal-first, longest-routes-first + swap. |
| 5 | Identify gaps | **Built** | `coverage.ts` gap per shift; `optimize` temp seats; `exceptions.ts` understaffed. |
| 6 | Suggest Instawork | **Partial** | `reconcile.ts instaworkGigsForRoute/summarizeInstaworkByRole` suggest/show. **Publish not wired (§8).** |
| 7 | Dispatcher reviews | **Built** | `StaffingPlanPreview.tsx` (WHY-TEMP / WHY-THIS-ROUTE, temp saved, "already optimal"). |
| 8 | Approve / override | **Built** | `ApplyPlanButton` → `/optimize/apply`; override via `PATCH /shift/[id]` `overrideReason`. |
| 9 | System commits | **Built** | `/optimize/apply` dual-writes internal picks, records temp, logs events; server recomputes (manual wins). |
| 10 | Continue shift lifecycle | **Built** | `lifecycleTick.ts` recomputes readiness/exceptions, reconciles IW, raises `replacement_needed`. |
| 11 | ONE CLICK → best plan | **New (thin)** | Today = 3 affordances (Build from routes / preview renders / Apply). Needs one AUTO STAFF orchestrator. |
| 12 | Richer route cards (stops/projects/addresses/kind) | **New (surfacing)** | Route object already carries `stops[].custName/kind/plannedWindow/items`; card shows only count+window today. |
| 13 | Per-route "X/Y staffed" + proposed + status | **Mostly built** | `RouteCard` shows covered/gap + people; needs proposed-assignment overlay from the plan. |
| 14 | Plan SUMMARY card | **New (thin)** | `StaffingPlan` already carries note/tempSaved/counts; needs a dedicated summary header. |
| 15 | Per-worker WHY | **Built** | `scoreAssignment` reasons + `whyThisRoute`/`whyTemp`; add internal "why selected" phrasing. |
| 16 | First-class override | **Built (backend)** | `PATCH overrideReason` + audit; needs a prominent UI control (today it's implicit). |
| 17 | Smarter Move-to-route (eligible / good-fit / exceeds-availability / qualification-mismatch) | **Partial** | `WarehousePrepSection` moves prep→field by field-need; needs eligibility labels from `candidateRoles`/`feasible`. |
| 18 | Day-level Staffing Health state | **Partial** | Per-shift readiness exists; needs a day-level roll-up label. |
| 19 | Refined dashboard metrics | **Built** | `FigureStrip` (shifts/people/internal/gap/temp hrs/cost/premium/temp%). |
| 20 | Progressive disclosure, not a spreadsheet | **Partial** | Board is already card-based; merge adds roster/open-shift sections behind disclosure. |
| 21 | Data model | **Built** | All 5 tables exist; little-to-no change needed (§6). |
| 22 | Integration honesty (CT availability / IW publish) | **Gap to document** | §7, §8. |
| 23 | Override model | **Built** | §9 (validate→recalc→record→continue). |
| 24 | Exception model | **Built** | §10 (recompute on tick). |
| 25 | Audit | **Built + extend** | `shift_assignment_events`; add an AUTO STAFF run summary event (§11). |
| 26 | Merge blades | **New** | §5. |

---

## 2. AUTO STAFF algorithm (the deterministic process)

The algorithm **is `optimizeStaffing()`** — nothing new is needed in the core. The new work is a thin
orchestration that chains the steps that today are triggered separately.

### 2.1 What runs on one click (all reused)

1. **Build/refresh demand** — `buildDemand(routes)` → `syncDemand(date, …)` (today: the "Build / refresh from routes" button → `/api/scheduling/generate`). Idempotent; never clobbers human-touched shifts.
2. **Net coverage** — `computeCoverage(shifts, scheduledCrew)` against the Connecteam schedule.
3. **Optimize** — `optimizeStaffing({shifts, coverage, roster, dayShifts, rates, instawork})`:
   - Expands route-tied driver/field shifts with a KNOWN window into **seats**, seeded with committed assignees (fixed points).
   - **Stage 1+3 fill:** walk empty seats **longest-route-first**, assign the best free internal worker by `scoreAssignment` (qual gate → internal pref → temp-hours-avoided → least-loaded → continuity).
   - **Stage 3 swap:** bounded feasible-swap pass that fixes the "dangerous" case (a temp on a LONG route while an internal sits on a SHORT route). Strictly reduces total temp hours; `guard < 1000`.
   - Produces `PlannedAssignment[]` with `kind`, `whyThisRoute`, `whyTemp`, `moved/fromRouteId`, plus `currentTempHours/planTempHours`, `tempHoursSaved`, `betterThanCurrent`, `alreadyOptimal`, honest `note`.
4. **Preview** — render `StaffingPlanPreview` (already shows WHY + saved temp + "already optimal").
5. **Review → Approve** — `ApplyPlanButton` → `POST /optimize/apply` (server **recomputes** from live DB state, writes internal picks, records temp).

### 2.2 Honored invariants (already enforced in code)

- **Hard constraints never violated:** `feasible()` gates role qualification (`candidateRoles`) + no time-overlap with the worker's other plan seats or CT shifts. A disqualified worker scores `-Infinity`.
- **Cost influences, never overrides:** `scoreAssignment` weights put `qual` (100) above everything; `tempHr` (35) only re-orders *qualified* internal onto longer routes. Unknown rate → excluded from cost, never blocks an assignment. Matches "cost influences but never overrides hard constraints."
- **No max-hours constraint** — a confirmed decision in `optimize.ts` (hours are informational).
- **Never a manufactured saving** — equal plan → `alreadyOptimal` → Apply disabled.

### 2.3 New (thin) orchestration

- A `POST /api/scheduling/auto-staff` route (or extend `/generate`) that does step 1 then returns the recomputed plan, so the client makes **one** call. (Optional — the page already assembles all inputs server-side on render; the button can simply call `/generate` then `router.refresh()`, and the preview + Apply are already there.)
- **Recommended minimal path:** rename/retitle the existing "Build / refresh from routes" to **AUTO STAFF**, and after it completes, auto-scroll to the already-rendered `StaffingPlanPreview`. This is almost zero new backend.

---

## 3. Data flow (end-to-end)

```
Goodshuffle (office Auto-Pull, logged-in browser → /api/gs/projects, /api/route/import)
   │  routes + stops (custName, kind, plannedWindow, items, address) persisted locally
   ▼
staff_shifts  ← buildDemand + syncDemand (deterministic, idempotent)
   │
   ├── Connecteam  getCrewForDateSafe(date) → SCHEDULED shifts (ok flag = reachable)   [READ]
   │                getUsersList() → roster + Title→role                                [READ]
   │                getPayRates(date) → internal $/h                                     [READ]
   │                computeCoverage → covered/gap   recommendCrew → free crew
   │
   ├── Instawork   getInstaworkShifts() → browser-pull SNAPSHOT (never server-called)   [READ]
   │                reconcile → booked/pending per route+role (availability, not alloc)
   │
   ▼
optimizeStaffing → StaffingPlan (preview)
   │
   ▼  dispatcher Approve (owner/admin)
/api/scheduling/optimize/apply
   │  INTERNAL picks → staff_shifts.assignees (SoR) + shift_assignments (dual-write) + events
   │  TEMP seats     → instawork_headcount + a "temp_recommended" audit event (RECORD-ONLY, no post)
   ▼
runShiftLifecycleTick (runtime cadence)
   │  backfill rows · reconcile IW fills (fresh snapshot) · mirror CT clocks (read-only)
   │  recompute readiness · derive lifecycle_state · persist shift_exceptions · Slack REDs
   ▼
Connecteam PUBLISH (per shift, explicit) — createPublishedShift (notifies crew)         [WRITE, wired]
Instawork PUBLISH — NOT wired (record-only; needs a captured gig-post endpoint)         [WRITE, gap]
```

**The only writes that reach an external system today** are the Connecteam **publish** (`createPublishedShift` /
`updatePublishedShift` — real REST write, already wired via `/shift/[id]/publish`) and nothing to Instawork.
The lifecycle tick is deliberately **read-only against both integrations** — it reconciles our own derived
state so a missed signal self-heals next tick.

---

## 4. UI changes — the merged Scheduling blade

Keep the route-centric card board (`RouteStaffBoard`). Add/refine:

1. **Prominent AUTO STAFF button** (top toolbar, primary) → analyze (generate) → the existing
   `StaffingPlanPreview` renders the PROPOSED plan → **Approve & Commit** reuses `ApplyPlanButton` +
   `/optimize/apply`. This replaces the current trio ("Build from routes" / silent preview / "Apply plan")
   with one obvious flow. (Keep "Add shift" + manual Add-worker for hand edits.)
2. **Plan SUMMARY card** — a header above the route grid built from fields the plan already returns:
   `note`, `tempCountSaved`/`tempHoursSaved`, internal placed, temp seats remaining, "already optimal."
   `StaffingPlanPreview` already has a Figure strip with `now → then`; promote it to a summary card.
3. **Richer route cards** — the `Route` object on the page already carries `stops[]` with `custName`,
   `kind` (delivery/pickup), `plannedWindow`, `items`, and address. Surface: stop count by kind, first
   venue/address, event label (already shown), and the route window (already shown). No new data fetch.
4. **Per-route "X/Y staffed" + proposed overlay + status** — `RouteCard` already computes `covered/headcount`
   and `gap` per role. Overlay the plan's `PlannedAssignment`s for that route (internal vs temp, moved) and
   the shift `lifecycle_state`/readiness level as a small chip.
5. **Per-worker WHY** — reuse `whyThisRoute`/`whyTemp` (already rendered in the preview). Add an internal
   "why selected" line from `scoreAssignment` reasons (free this window, least-loaded, longest route).
6. **First-class override** — expose a visible "Override" affordance on a route/worker that posts
   `PATCH /shift/[id]` with `overrideReason` (backend + audit already exist). Today the override is implicit
   (any manual assignee change wins); make it an explicit, reason-captured action.
7. **Smarter Move-to-route** — extend `WarehousePrepSection`'s picker to label each candidate route using the
   SAME deterministic predicates the optimizer uses: **good-fit** (qualified + free window + has field gap),
   **exceeds-availability** (overlaps an existing CT/plan seat → `feasible()` false), **qualification-mismatch**
   (`candidateRoles(role)` excludes the worker's role). These are pure functions already in `availability.ts`/`optimize.ts`.
8. **Day-level Staffing Health** — a roll-up chip (e.g. worst-of the per-shift readiness levels + open RED
   exception count from `getActiveShiftExceptions`). Pure read over data already computed.
9. **Merged roster + open-shift sections (from /staffing)** behind progressive disclosure: the role-grouped
   "who's present" roster (`distinctByRole`), the day-before Prep / after-pickup Unload views, and the
   Connecteam `OpenShiftsPanel`. These are read-only context, shown below the plan, not competing with it.

Design-language note: the repo's comms house-rule (`comms-no-dashes`) is **UI-copy only**; existing files use
em-dashes in code comments freely. Keep new user-facing strings dash/emoji-free to match `StaffingPlanPreview`.

---

## 5. Merging the two blades

**Recommendation: fold `/staffing` into `/scheduling` as sections, and make `/staffing` a redirect.**

- `/scheduling` is the superset: it already reads the same Connecteam roster, routes, and tent-rule crew
  needs that `/staffing` shows, plus the entire app-owned shift model `/staffing` lacks.
- `/staffing`'s three unique pieces move into `/scheduling` as disclosed sections:
  - **Open shifts** (`OpenShiftsPanel` + `lib/staffing/openShifts.ts`) — Connecteam shifts with nobody assigned + free-crew suggestions.
  - **Role roster** ("Prep day-before / Drivers / Unload after-pickup / Office") — the `distinctByRole` views.
  - **Routes & crew needed** table — redundant with the route cards; drop or keep as a compact list.
- **Route-safety:** keep `src/app/(console)/staffing/page.tsx` as a thin server redirect to `/scheduling`
  (so bookmarks/nav/Slack deep-links don't 404), and remove the `/staffing` entry from `ConsoleNav.tsx`
  (ln 87) — or relabel the single remaining entry "Scheduling" → **"Staffing"** if the team prefers that
  name. `lib/staffing/openShifts.ts` is imported only by the staffing page + `OpenShiftsPanel`; moving the
  import to the scheduling page is a one-line change. `BladeAgents blade="staffing"` → `blade="scheduling"`
  (or keep both keys registered).
- **Decision needed:** which name survives in the nav (the brief calls the merged thing both "Scheduling"
  and "Staffing"). Recommend **Scheduling** (it owns the verb) with "Staffing" as the section header for the
  roster view — but confirm with the user.

---

## 6. Data model changes

**Essentially none required.** The five tables already carry everything:
- Internal picks → `staff_shifts.assignees` + `shift_assignments` (dual-write, done).
- Economics → `shift_assignments.est_*`, `temp_reason`, `route_reason` (done).
- Override → `overridden`, `override_reason` (done).
- Readiness/lifecycle → `readiness_json`, `lifecycle_state` (done).

**Optional, additive (only if desired):**
- An AUTO STAFF run audit row — can be expressed purely with **existing** `shift_assignment_events` (a
  run-summary event per shift, or one `kind="auto_staff_run"` event with the plan summary in `to_value`).
  No new table needed. If a first-class run record is wanted later, a small `auto_staff_runs` table
  (`id, date, actor, considered, assigned, temp_recorded, routes, overrides, plan_json, ts`) is the clean
  option — but start with events to stay within the existing migration discipline.

---

## 7. Integration honesty #1 — Connecteam availability (the biggest honesty question)

**Finding:** the Connecteam integration (`src/lib/connecteam.ts`) reads only **scheduled shifts**
(`GET /scheduler/v1/schedulers/{id}/shifts`), **users** (`/users/v1/users` → Title→role), **pay rates**,
and **timesheets**. There is **no time-off / unavailability / PTO / blocked-availability call anywhere in
the repo** (verified by searching `src/lib/` — the only `availability` hits are unrelated comms logistics).

**What "available" means today:** `recommendCrew` and `optimize.feasible()` treat a worker as **free** if they
are **not assigned to an overlapping Connecteam scheduled shift** that day. That is an **inference from the
schedule**, and the UI already says so ("Free this window", "INFERENCE ... not a personal calendar").

**Therefore the state model can honestly support only a subset of the user's requested states:**

| State | Supported today? | Source |
|---|---|---|
| **SCHEDULED** | Yes | CT shift the worker is on (`getCrewForDateSafe`). |
| **ALREADY-ASSIGNED** | Yes | On an app `staff_shifts` seat / `shift_assignments` row. |
| **AVAILABLE** (inferred) | Yes, as inference | Not on an overlapping CT/app seat; label it "free (inferred from schedule)". |
| **OUTSIDE-WINDOW** | Yes | Window overlap check in `overlaps()`. |
| **CONFLICT** | Yes | Overlaps another plan seat / CT shift (`feasible()` false). |
| **UNKNOWN / UNVERIFIED** | Yes | `getCrewForDateSafe.ok === false` (CT unreachable) → never "nobody scheduled." |
| **BLOCKED** (PTO/time-off/declared unavailable) | **NO** | No API wired. **Cannot be shown honestly today.** |
| **UNAVAILABLE** (hard personal) | **NO** | Same gap as BLOCKED. |

**Honest design:** label the inferred state **"Available (from schedule)"**, keep **UNKNOWN** when CT is
unreachable, and **do not render a BLOCKED/time-off state until a Connecteam time-off endpoint is wired**.
Connecteam does offer time-off features in its product; if the account exposes a time-off API, add a
`getTimeOffForDate(date)` reader (mirroring `getCrewForDateSafe`'s ok-flag discipline) and feed a `blocked`
set into `recommendCrew`/`feasible` as a hard gate. Until then, surfacing "blocked" would fabricate a fact —
forbidden by the house rule. **This is the #1 decision for the user (§13).**

---

## 8. Integration honesty #2 — Instawork publish

**Finding:** the server **never calls Instawork** (`instawork/client.ts`: Cloudflare/datacenter-IP block,
same as Goodshuffle). It reads a **browser-pulled snapshot** (`/api/instawork/import` → `store.ts`) and
reconciles fills. `types.ts` states plainly: "Posting a gig is a separate, paid action captured/built later."

**Therefore:**
- Auto Staff → gap → Instawork is **suggest + record + (manual publish elsewhere)** today, NOT auto-publish.
- `/optimize/apply` already does the honest thing: temp seats become `instawork_headcount` + a
  `temp_recommended` **audit event** — no booked row, no post. `AddWorkerPanel` proposes a gig **record-only**.
- The `replacement_needed` exception and the IW monitor explicitly say "re-post the gig" to a human.

**Honest design — suggest → approve → publish policy:**
1. **Today:** AUTO STAFF recommends the gig (role, headcount, window, est. temp cost from `cost.ts`); the
   dispatcher publishes it in Instawork directly (or via the browser-pull session). The app records the
   recommendation + reconciles the fill when the next snapshot arrives.
2. **When a gig-post write is captured** (same browser-replay technique as Goodshuffle writes): add a
   `postInstaworkGig()` behind an **explicit dispatcher action** with a confirm + idempotency key. **Never
   silent/auto-publish** — the user's rule, and consistent with the outbox/approval pattern in `aiorg/approvals.ts`.
3. **Configurable auto-publish** only *after* a safe, idempotent, test-first path exists (TEST gigs first,
   like the Goodshuffle TEST 1/2/3 discipline). Gate it OFF by default.

**Capture needed:** record one real "post a gig" interaction in a logged-in Instawork session (browser-level
network capture), codify endpoint + body, match by an idempotency key. Until then, document publish as manual.

---

## 9. Override model (mostly exists)

`PATCH /api/scheduling/shift/[id]` with `overrideReason`:
1. **Validate** — `updateShift` applies the patch; 404 if the shift is gone.
2. **Recalc staffing** — `syncInternalAssignments` reconciles `shift_assignments` to the new assignee set
   (drops → REPLACED, revives → ASSIGNED), keeping coverage/readiness correct on the next render/tick.
3. **Record** — every live internal row gets `overridden=1` + `override_reason`; an `override` audit event
   is logged. **Manual always wins** — the optimizer never auto-runs to fight a human change (comment in the route).
4. **Continue** — readiness + cost recompute on the next page render and lifecycle tick automatically.

**Gap to close:** make override a **first-class, reason-prompted UI action** (today the reason is optional and
the control is implicit). Backend is complete.

---

## 10. Exception model (exists — the tick)

`scanShiftExceptions` + `reconcileShiftExceptions` run each `runShiftLifecycleTick`:
- Codes: `understaffed, no_truck, no_window, not_published, supervisor_missing, packet_undelivered, unconfirmed, replacement_needed`.
- **Recompute on change** — the tick re-scans the look-ahead window, reconciles IW fills, mirrors clocks,
  raises `replacement_needed` on a no-show/drop (enriched with est. additional temp cost), and self-heals
  (a fixed gap resolves next tick). Idempotent by `signature`.
- **Honesty:** staffing-derived exceptions are **frozen (not resolved)** on dates where CT/IW was unreachable
  — absence on an unverified date is UNKNOWN, never a false recovery. Unverified integration → never a
  fabricated alert.

No change needed; the "plan stays dynamic / no stale READY" machinery the brief wants **already exists**.

---

## 11. Audit (extend `shift_assignment_events`)

Already logged: `assigned`, `override`, `reassigned`, `state_change`, `clock_in/out`, `temp_recommended`,
exception open/resolve. **Add one AUTO STAFF run summary**: in `/optimize/apply`, after the transaction,
log a single event (e.g. `kind="auto_staff_run"`, `to_value` = JSON `{considered, internalPlaced, tempRecorded,
routesTouched, overridesPreserved, tempHoursSaved}`) with a `change_key` of `${date}:auto_staff:${ts}`. This
gives the "considered / assigned / routes / overrides / final plan" trail the brief asks for, with **no schema
change** (the column widths already hold JSON blobs elsewhere in the app).

---

## 12. Implementation plan (smallest safe sequence)

**Phase A — pure surfacing (no backend, lowest risk):**
1. Relabel "Build / refresh from routes" → **AUTO STAFF** (primary button); after it runs, scroll to the existing preview.
2. Promote `StaffingPlanPreview`'s figures into a **Plan Summary card**.
3. Enrich route cards with stops-by-kind / first venue / address from the `Route` already in hand.
4. Overlay the plan's per-route proposed assignments + the shift `lifecycle_state`/readiness chip on each `RouteCard`.
5. Add the day-level **Staffing Health** chip (worst readiness + open RED count).

**Phase B — merge blades:**
6. Move `OpenShiftsPanel` + role-roster + day-before/after sections into `/scheduling` behind disclosure.
7. Turn `/staffing` into a redirect; drop/relabel the nav entry; repoint `BladeAgents`.

**Phase C — first-class override + eligibility labels (small backend reuse):**
8. Explicit "Override" UI → `PATCH overrideReason` (prompt for reason).
9. Move-to-route eligibility labels (good-fit / exceeds-availability / qualification-mismatch) from `feasible`/`candidateRoles`.

**Phase D — audit + honest integration paths:**
10. Add the `auto_staff_run` audit event in `/optimize/apply`.
11. **Connecteam time-off** reader IF the API is available (hard gate into availability) — otherwise ship the "Available (from schedule)" + UNKNOWN labels and defer BLOCKED.
12. **Instawork gig-post** capture (browser-replay) → explicit, confirmed, idempotent publish action; auto-publish OFF.

**Genuinely new code:** the AUTO STAFF button orchestration (tiny), the summary card, the route-card
enrichment overlay, the blade merge/redirect, the override UI control, the eligibility labels, the run audit
event. **Everything else is reuse-surfacing.** The optimizer, apply, override backend, cost, readiness,
exceptions, lifecycle tick, Connecteam/Instawork readers are done.

---

## 13. Decisions needed from the user

1. **Connecteam availability/time-off (highest priority).** Does the Connecteam account expose a time-off /
   unavailability API? If yes, we wire a hard-gate `blocked` set and can show a real BLOCKED state. If no,
   we ship "Available (inferred from schedule)" + UNKNOWN and **will not** render BLOCKED/time-off (doing so
   would fabricate a fact). **Which is it?**
2. **Instawork publish policy.** Confirm: today = suggest + record + manual publish. Do you want us to
   **capture** the gig-post endpoint (one real posting in a logged-in session) so a confirmed, idempotent
   in-app publish can be built? Auto-publish stays OFF until a TEST-first safe path exists — agreed?
3. **Merge direction + name.** Fold `/staffing` into `/scheduling` with `/staffing` as a redirect — confirmed?
   And which name wins in the nav: **"Scheduling"** (recommended) or **"Staffing"**?
4. **AUTO STAFF scope of auto-commit.** Should AUTO STAFF stop at **PROPOSE** (dispatcher always clicks
   Approve, as today) or ever auto-apply when the plan only *fills* empty seats with no moves/overrides?
   Recommendation: always PROPOSE → Approve (keeps the human in the loop, matches the override-wins rule).
5. **Override reason requirement.** Make `overrideReason` **mandatory** on an explicit override (today it's
   optional)? Recommended yes, for a clean audit trail.

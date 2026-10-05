# Work Schedule vs Route Assignment — Separating Two Conflated Concepts

**Status:** Design for review (ANALYSIS ONLY — no production code, schema, config, git, or flyctl changed by this task).
**Author:** Engineering analysis pass, 2026-10-04.
**Scope:** A **refinement** of the existing Scheduling / Auto-Staff engine. The machinery is built and shipping; this corrects one architectural conflation inside it — the system treats *"has a Connecteam work shift"* and *"is assigned to a Zoe route"* as the same state. They are not. **Do not rewrite working functionality.**

**Read alongside:**
- `docs/scheduling-auto-staff-engine.md` — the one-click AUTO STAFF engine (§0 "~85% already built"; §7 already flags the Connecteam time-off gap).
- `docs/shift-lifecycle-engine-analysis.md` — the per-worker lifecycle/readiness/exception machinery.
- `docs/shift-staffing-cost-optimization.md` — the deterministic internal-first optimizer this is built on.
- `docs/financial-intelligence-labor-attribution.md` — how committed assignments feed labor cost downstream.

---

## 0. TL;DR — how much already exists (this is a refinement, not a rebuild)

The whole pipeline is built, unit-tested, and wired into `/scheduling`: demand → coverage → availability → optimizer → cost → readiness → exceptions → lifecycle tick. The keystone per-worker entity (`shift_assignments`) already exists and already carries the fields a clean separation needs: `worker_kind`, `connecteam_user_id`, `state` (PROPOSED/ASSIGNED/…), `overridden`, `override_reason`, plus an append-only audit log (`shift_assignment_events`). The override flow, the dual-write that keeps `shift_assignments` in lock-step with `staff_shifts.assignees`, and the recompute-on-tick loop are all live.

**What is actually wrong is narrow and local:** three pure functions decide "is this worker free?" by asking "does this worker have *any* overlapping Connecteam shift?" — which conflates a WORK SCHEDULE window with a ROUTE ASSIGNMENT. The fix is to introduce one deterministic eligibility classifier that both engines read, and to feed it the one distinction that already exists in the data (is this worker in a Zoe route assignment for the window, or merely on the Connecteam schedule?). No schema rewrite is required to get the correct behavior; the per-worker row already exists.

**Two capability gaps the brief's state list assumes but the code does NOT have** (design the honest path, do not pretend):
- **Connecteam exposes only SCHEDULED shifts. There is NO time-off / blocked / availability API.** Verified: the only Connecteam endpoints in the repo are `/users`, `/scheduler/.../shifts`, `/pay-rates`, `/time-clock` (`src/lib/connecteam.ts:8-10, 226-232, 333-359, 420-437`). A repo-wide grep for `time.?off|availabilit|unavailab|blocked|pto|vacation|leave` finds only the derived `"exceeds-availability"` label (inferred from schedule overlap, not a feed) and `clock_source "unavailable"`. So **UNAVAILABLE / BLOCKED cannot be truly sourced today** — any such state is an inference or a manual flag, and must be labelled as such.
- **Instawork publish is NOT wired.** The gap → Instawork path is suggest + record + manual-post (`AddWorkerPanel.tsx:182-214`, "Posting is wired after the Instawork write capture").

---

## 1. CURRENT MODEL — how schedules + assignments are represented today

### 1.1 Two systems, two record types

| Concept | System of record | Where it lives in code | Shape |
|---|---|---|---|
| **WORK SCHEDULE** — does the worker have a scheduled work window that day? | **Connecteam** | `CrewShift` from `getCrewForDateSafe(date)` (`connecteam.ts:244-297`) | `{startUnix, endUnix, assignees: CrewMember[], isOpen, title, …}` — read-only. `ok:false` when unreachable (never mistaken for "nobody scheduled"). |
| **ROUTE ASSIGNMENT** — is the worker assigned to a specific Zoe route? | **Zoe (this app)** | `staff_shifts.assignees` (JSON `number[]` of Connecteam userIds, `db/index.ts:592`) + the keystone per-worker rows `shift_assignments` (`db/index.ts:617-645`) | `assignees` is the projection the board reads/writes; `shift_assignments` is one row per (shift × worker) carrying `state`, packet, clock, economics, override. |

### 1.2 The link between the two

- **Shift-level link:** `staff_shifts.connecteam_shift_id` (`db/index.ts:595`) is set when a Zoe shift is *published* into Connecteam (`publish/route.ts:69-75`). It says "this Zoe demand line has a published Connecteam mirror." It does **not** exist per worker.
- **Worker-level link:** there is **none stored**. `shift_assignments.connecteam_user_id` identifies the *person*, but there is no `connecteam_shift_id` on the per-worker row tying a worker to a specific Connecteam shift. The only way the code relates the two systems per worker is by **matching `userId`**: a Connecteam `CrewShift.assignees[].userId` against a Zoe `staff_shifts.assignees[]`.
- **Consequence:** "ASSIGNED" vs "SCHEDULED-UNASSIGNED" is **derivable today purely by set membership** — a userId that appears in a Zoe `staff_shifts.assignees` for the day/window is ASSIGNED; a userId that appears only in a Connecteam `CrewShift` is SCHEDULED-UNASSIGNED. The data to tell them apart exists; the engines just don't ask the question.

### 1.3 The deterministic pipeline (all `src/lib/scheduling/*`)

`demand.ts` → `store.ts syncDemand` → `coverage.ts computeCoverage` → `availability.ts recommendCrew` → `optimize.ts optimizeStaffing` → `cost.ts` → `readiness.ts` → `exceptions.ts` → `lifecycle.ts` / `lifecycleTick.ts`. The board (`scheduling/page.tsx` + `RouteStaffBoard` / `AddWorkerPanel` / `OverridePanel`) renders over these.

---

## 2. PROBLEM — exactly where schedule state is misread as route (un)availability

There are **two opposite misreadings of the same Connecteam schedule**, in different modules. Both stem from the same root: *no code distinguishes a work-schedule window from a route assignment.*

### 2.1 ROOT BUG — "scheduled in Connecteam" read as BUSY (worker excluded)

**`availability.ts recommendCrew` — lines 54-59, 64.**
```
const busy = new Set<number>();
if (start != null && end != null && ...) {
  for (const s of dayShifts) {
    if (overlaps(start, end, s.startUnix, s.endUnix)) for (const a of s.assignees) busy.add(a.userId);   // ← line 56-57
  }
}
...
return roster.filter((u) => roles.includes(u.role) && !busy.has(u.userId) && !already.has(u.userId))      // ← line 64
```
`dayShifts` are the **Connecteam scheduled shifts** (passed from the page as `coverage.shifts`, `page.tsx:182, 208`). Any worker on **any** overlapping Connecteam shift is dropped from the recommendations and labelled **"busy."** A warehouse associate scheduled 8am–5pm who is *not* assigned to any Zoe route is excluded from a 10am–2pm route — even though "already expected to work that day" is exactly what should make them the **top** candidate. This is the "BUSY" bug.

**`optimize.ts` — `busyWindows` (107-117), `feasible` (207-214), used in the fill loop (228) and swap pass (253).**
```
function busyWindows(dayShifts: CrewShift[]) { ... for (const a of s.assignees) list.push([s.startUnix*1000, s.endUnix*1000]); ... }   // ALL Connecteam shifts
...
function feasible(userId, seat) { ... for (const [ws,we] of workerBusyInPlan(userId, seat.seatId)) if (overlaps(seat..., ws, we)) return false; }   // line 210-212
```
`workerBusyInPlan` (196-203) unions the worker's plan seats **with their Connecteam busy windows** (line 201). So a scheduled-unassigned worker whose Connecteam window overlaps a route seat is deemed **infeasible** and never placed → the seat falls to a **temp (Instawork)** seat by construction (`emptySeats` loop 222-234; swap pass 240-263). **This is the line that makes Auto Staff buy Instawork instead of using a worker who is already on the clock.**

### 2.2 INVERSE BUG — "scheduled in Connecteam" read as already COVERING a route

**`coverage.ts computeCoverage` — lines 58-78.**
```
const pool = role === "field" ? [] : scheduled.filter((c) => c.role === CREW_ROLE[role] && !assignedIds.has(c.userId));   // line 58
...
while (residual > 0 && pi < pool.length) { names.push(pool[pi].name); ... residual -= 1; }   // 66-71
const covered = Math.min(s.headcount, assigned + scheduledCredit);   // 73
const gap = Math.max(0, s.headcount - covered);                      // 74
```
For **driver** and **prep** roles, a Connecteam-scheduled worker who has no explicit Zoe assignment is **credited as covering** a route seat, shrinking `gap` (and therefore the Instawork ask). This is the opposite error: a *work-schedule* worker is silently treated as *route-covered*. It is a reasonable "don't double-ask" heuristic, but it **hides the assignment decision** — no `shift_assignments` row is created, no packet, no publish, no readiness. The seat *looks* covered on the board but the worker was never actually assigned to that route. Field is (correctly) excluded (comment 54-57: the "other" bucket contains office/admin).

### 2.3 Where the two bugs collide (the incoherence)

For the **same** scheduled-unassigned driver on the **same** day:
- `coverage.ts` says **covered** (gap − 1, no Instawork needed).
- `availability.ts` / `optimize.ts` say **busy / infeasible** (not recommendable, not placeable).

So the board can simultaneously show a route as "internally covered" *and* refuse to let the dispatcher (or Auto Staff) actually put that person on it. The person is neither offered nor truly assigned.

### 2.4 Where it surfaces in the UI

- `page.tsx:151-152` — `busyUserIds = [...scheduledCrew.map(userId)]` — **every** Connecteam-scheduled person. Passed to the board and rendered as a **"busy"** badge in `AddWorkerPanel.tsx:321`.
- `page.tsx:162-173` — **the correct pattern already exists for prep:** `routeAssignedIds` (Zoe route assignees) are subtracted from `prepCrewToday`, so a warehouse person *moved onto a route* drops out of the "available to pull" list. This is precisely the SCHEDULED-vs-ASSIGNED distinction — but it is drawn **only here, for prep**, and not inside `recommendCrew` / `optimize`.

**Net:** the fix is to generalize the distinction that `page.tsx:162` already makes for prep into the shared eligibility classifier that `availability.ts` and `optimize.ts` consume, and to convert `coverage.ts`'s silent credit into an explicit *proposed* assignment.

---

## 3. PROPOSED MODEL — Work Schedule and Route Assignment as separate, synchronized concepts

Keep the two record types (they already exist). Add **one deterministic classifier** that every engine reads, so "free / busy / covered" is computed once, correctly, from both records.

```
Employee (Connecteam user; role from Title — connecteam.ts:142-147)
   │
   ├── WORK SCHEDULE            (Connecteam CrewShift[] for the day — SoR: Connecteam)
   │      "does a scheduled work window exist, and does it cover the route window?"
   │
   ├── AVAILABILITY / RESTRICTIONS
   │      derivable TODAY:  on-schedule window (overlap), already route-assigned elsewhere (overlap)
   │      NOT sourceable:   time-off / PTO / blocked  → inference or manual flag only (flag it)
   │
   └── ROUTE ASSIGNMENT        (Zoe staff_shifts.assignees + shift_assignments — SoR: Zoe)
          "has this worker been committed to THIS route+role?"
```

**The classifier (new, pure, deterministic) — `eligibilityFor(worker, routeWindow, role, ctx)`:**

Inputs it already has in hand on every call site: the worker's Connecteam shifts for the day (`coverage.shifts`), the worker's Zoe route assignments for the day (`staff_shifts.assignees` across the day's shifts), the route window, the role. It returns one `WorkerEligibility` state (§4) + a deterministic `reasons[]`. `availability.recommendCrew`, `optimize.feasible`, and the board labels all call it instead of their private `busy` sets. "Free" becomes "eligible and not already route-assigned in this window," **not** "has no Connecteam shift."

The rule that corrects the root bug:

> A Connecteam work shift makes a worker **BUSY only if that shift corresponds to an existing route assignment** (the worker is in a Zoe `staff_shifts.assignees` whose window overlaps). A Connecteam shift with **no** matching Zoe assignment means **SCHEDULED-UNASSIGNED → eligible, and preferred.**

---

## 4. STATE MACHINE — worker-eligibility states (deterministic; entry conditions + data-supportable today?)

Eligibility is a **per-(worker, candidate route+window)** classification, computed on demand (it is not a stored column — it changes per route being considered). It sits *above* the per-worker `shift_assignments.state` (PROPOSED/ASSIGNED/…), which **is** stored (`types.ts:108-118`).

| State | Entry condition (deterministic) | Supportable TODAY? |
|---|---|---|
| **AVAILABLE** | Qualified for the role (`candidateRoles`, `availability.ts:18-22`); **no** Connecteam shift that day; no Zoe assignment overlapping the window. | ✅ Yes (absence of a schedule window). |
| **SCHEDULED-UNASSIGNED** *(eligible, HIGH-PRIORITY)* | Qualified; **has** a Connecteam shift covering the route window; **not** in any Zoe `staff_shifts.assignees` overlapping that window. | ✅ Yes — userId ∈ Connecteam shift, ∉ Zoe assignees. This is the state the root bug mislabels BUSY. |
| **ASSIGNED** *(to a Zoe route; not offered elsewhere unless reassigned)* | userId ∈ a Zoe `staff_shifts.assignees` whose window overlaps the candidate window. | ✅ Yes — the Zoe route assignment is the SoR. |
| **SCHEDULE-CONFLICT** | Qualified and scheduled, but the Connecteam window **does not cover** the route window (starts late / ends early / disjoint). | ✅ Yes — window math on the Connecteam shift. (Today everything is coarse "overlap"; this needs *covers*, not just *overlaps*.) |
| **UNAVAILABLE** *(explicit block — PTO/time-off)* | An explicit time-off / blocked record exists. | ❌ **NOT sourceable** — no Connecteam time-off API (§0). Only honest paths: (a) a **manual** Zoe "unavailable" flag, or (b) treat as unknown. **Must be flagged as inferred/manual, never presented as fact.** |
| **OUTSIDE-AVAILABILITY** | Worker has a known availability pattern and the route falls outside it. | ❌ Not sourceable (same gap as UNAVAILABLE). Degrade to SCHEDULE-CONFLICT (which *is* sourceable) or manual. |
| **PENDING-ASSIGNMENT** | Appears in a current Auto Staff **proposal** but not committed. | ✅ Yes — `shift_assignments.state = "PROPOSED"` already exists (`types.ts:109`); the applied internal picks become real; temp seats are recorded not booked (`applyPlan.ts:6-9`). |
| **MANUAL-OVERRIDE** *(preserved + reason)* | A dispatcher action set `overridden=1` with a reason. | ✅ Yes — `shift_assignments.overridden` + `override_reason` (`types.ts:146-147`), set by `PATCH /shift/[id]` (`shift/[id]/route.ts:46-53`), audit event logged. Manual always wins. |

**Design law restated:** these states are a **deterministic function** of (Connecteam schedule, Zoe assignments, route window, role, manual flags). No LLM sets them. AI only *explains* a state after the fact (§8, §11).

---

## 5. SYNC MODEL — Connecteam ⇄ Zoe (one integration, no duplicate shifts)

### 5.1 Connecteam → Zoe (ingest; READ) — exists

`getCrewForDateSafe` (`connecteam.ts:257-297`) reads the day's shifts with an `ok` reachability flag. `page.tsx:146-151` and `lifecycleTick.ts:114-118` consume it. This is the WORK SCHEDULE feed. **No change needed** beyond passing it into the new classifier. The timesheet mirror (`getActualHours`, read-only clock-in, `lifecycleTick.ts:142-153`) stays as-is.

### 5.2 Zoe → Connecteam (publish; WRITE) — exists, with a duplicate-shift hazard to respect

The existing integration supports create **and** update of a published shift:
- `createPublishedShift` (`connecteam.ts:550-559`) — POST, first publish.
- `updatePublishedShift` (`connecteam.ts:567-576`) — PUT with `id` in the body, re-publish.
- The publish route **already prefers update when linked**: `isUpdate = Boolean(shift.connecteamShiftId)` and keeps the original id (`publish/route.ts:26, 61-63, 69-75`).

**The hazard the brief warns about is real:** publishing a Zoe route assignment **creates a new Connecteam shift** (when not yet linked). That new shift then re-ingests (§5.1) as *another* scheduled window for the worker — which, under today's logic, the engines read back as "busy." After the classifier (§4) this is handled correctly (that Connecteam shift now matches a Zoe assignment → ASSIGNED, legitimately busy for *other* routes). But the matching remains **by userId + window overlap**, because **there is no per-worker `connecteam_shift_id`** linking a Zoe assignment to the exact Connecteam shift it produced.

**Sync rules (honest, no second integration, no duplicate shifts):**
1. **Prefer linking/updating** an existing Connecteam shift via `connecteam_shift_id` (already done at the shift level). Do **not** create a second Connecteam shift for a Zoe shift that is already linked.
2. **Do not auto-publish.** Publish stays human-gated (confirmed + window + ≥1 assignee, owner/admin, `publish/route.ts:19-37`). SCHEDULED-UNASSIGNED → ASSIGNED is a Zoe-side state change; it only becomes a Connecteam write when the dispatcher publishes.
3. **Optional hardening (recommended):** store a worker-level `connecteam_shift_id` on `shift_assignments` when a publish returns an id, so ASSIGNED-vs-SCHEDULED matching becomes an exact link rather than a userId+overlap inference. This is additive and closes the one honest ambiguity (a worker on two legitimately-distinct Connecteam windows in overlapping times).

### 5.3 What the integration does NOT support

No time-off read (§0). No Instawork post (§0). No per-worker Connecteam shift write distinct from the whole-shift PUT. State UNAVAILABLE and any "auto-book the gap" are therefore **out of honest reach** until those endpoints are captured.

---

## 6. AUTO STAFF LOGIC — candidate hierarchy (so scheduled-unassigned beats Instawork)

The optimizer's objective is unchanged: **minimize unnecessary temp exposure while keeping full coverage** (`optimize.ts:6-8`). The scoring already encodes qualification ≫ internal-first ≫ temp-hours-avoided ≫ load ≫ continuity (`DEFAULT_STAFFING_CONFIG`, `optimize.ts:41-44`; `scoreAssignment`, 133-150). The **only** change is what `feasible` (and `recommendCrew`) count as eligible, plus one new preference tier.

**Candidate hierarchy (deterministic), highest first:**
1. **Qualified** for the role — `candidateRoles` gate (hard; `optimize.ts:139`, `availability.ts:18-22`). Unqualified = excluded.
2. **Not ASSIGNED** elsewhere in the window — a worker already on another Zoe route in the same window is not double-offered (unless a reassign/override).
3. **No hard SCHEDULE-CONFLICT** — their schedule (if any) covers the route window. (Replaces today's "any overlap = infeasible.")
4. **SCHEDULED-UNASSIGNED preferred over fully-unscheduled (AVAILABLE).** *New tier.* A worker already expected to work that day converts sunk schedule into coverage. Add a `scheduledUnassignedBonus` weight below `intern`, above `load`, so it breaks ties toward turning an existing commitment into a route — ahead of pulling in someone not scheduled at all, and far ahead of a temp.
5. **Covers the window** / longest-route-first steering — unchanged (`emptySeats` 220-234).
6. **Role fit / least-loaded / continuity** — unchanged (`scoreAssignment` 141-149).
7. **No existing Zoe assignment** (seat-dedup) — unchanged (`assignedSomewhere` 216).
8. **Best fit → temp only when internal is genuinely exhausted** — unchanged temp fallback (296-314), but it now fires far less because scheduled-unassigned workers are eligible.

**How this changes coverage/availability:** `coverage.computeCoverage` stops *silently crediting* scheduled driver/prep as covered (§2.2). Instead, a SCHEDULED-UNASSIGNED worker becomes a **high-priority candidate the optimizer actually places** (producing a real PROPOSED→ASSIGNED `shift_assignments` row, packet, publish, readiness). The gap the board shows is honest ("needs a decision"), and the plan fills it from the schedule before it ever reaches `tempSeat`. Concretely: the worker Auto Staff used to skip as "busy," and that coverage used to hide, is now the first pick for the open seat.

---

## 7. RECONCILIATION — Cases A–D (deterministic; no stale READY)

| Case | Condition | Correct handling |
|---|---|---|
| **A. Scheduled + unassigned** | userId ∈ Connecteam shift, ∉ Zoe assignees (window covered). | **NOT an error.** State SCHEDULED-UNASSIGNED; surface as a high-priority candidate. Never BUSY, never silently "covered." |
| **B. Scheduled + assigned** | userId ∈ Connecteam shift **and** ∈ a Zoe assignment overlapping the window. | **ASSIGNED.** Legitimately busy for *other* routes in the window. The healthy steady state after publish. |
| **C. Zoe-assigned but Connecteam missing / incompatible** | userId ∈ Zoe assignees but **no** Connecteam shift covers the window (or the window conflicts). | **RECONCILIATION WARNING** (new exception code, e.g. `schedule_missing` / `schedule_conflict`), honesty-gated: only when Connecteam is **reachable** (`coverage.ok`), never on an outage (same rule as `exceptions.ts:63` understaffed). "Assigned in Zoe but not on the Connecteam schedule — publish or adjust." |
| **D. Connecteam changes after assignment** | A worker's Connecteam shift is edited/removed after Zoe assigned+published. | The lifecycle tick already **re-reads Connecteam and recomputes readiness every run** (`lifecycleTick.ts:110-162`). Extend it to re-run the classifier so a now-conflicting schedule flips the shift off READY and raises Case C. **No stale READY:** readiness is recomputed from fresh facts each tick and persisted (`writeShiftLifecycle`, 161); it is never latched. |

All four are a function of two sets + window math — fully deterministic, computable on every tick and every render.

---

## 8. UI — replace the AVAILABLE/BUSY boolean with the real states

**Board worker labels (`AddWorkerPanel.tsx:321`, `page.tsx:151-152`):** drop the single `busyUserIds` boolean. Render the §4 state with a short deterministic *why*:
- AVAILABLE — "free, not scheduled today"
- **SCHEDULED-UNASSIGNED — "on the schedule {window}, not yet on a route" + a one-click "Assign to this route"** (the high-value affordance that turns schedule into coverage). This is what `prepCrewToday` (`page.tsx:162-173`) already does for prep — generalize it.
- ASSIGNED — "on {route} {window}" (and *why not here*)
- SCHEDULE-CONFLICT — "scheduled {window}, does not cover this route" (disabled, with reason)
- UNAVAILABLE — only if a **manual** flag exists; labelled "marked unavailable (manual)" — never fabricated.

**Add-Worker / Override drawer:** both already show deterministic eligibility (`moveEligibility` → good-fit / exceeds-availability / qualification-mismatch, `planView.ts:100-123`, used in `OverridePanel.tsx:255-270`). Extend the same explainable predicate set to the §4 states so each candidate shows WHY it is / isn't offered. Override stays mandatory-reason + audit (`OverridePanel.tsx:111-126`, `shift/[id]/route.ts:46-53`).

**Auto Staff internal-labor breakdown (new, on the plan summary `planView.ts:21-58`):** show the honest decomposition for the day —
`scheduled` · `already-assigned` · `scheduled + unassigned` (the reclaimable pool) · `available` · `unavailable (manual)` · **total eligible** — next to the existing `staffingGap / instaworkRequired`. This makes "we bought Instawork while N scheduled-unassigned were idle" impossible to miss.

---

## 9. MIGRATION — from the old workflow without breaking it

Transition is **behavioral, not destructive** — no backfill of bad state, because the conflation lives in *computation*, not storage.

1. **Treat every existing / manual Connecteam schedule as a WORKFORCE COMMITMENT** — never an auto-route-assignment (don't let `coverage.ts` keep inventing coverage), and **never** an auto-"unavailable" (there is no block feed). A legacy or hand-built Connecteam shift means "this person is expected to work," i.e. a candidate.
2. **Change the question** everywhere from *"is this person scheduled?"* to *"does this person's schedule CONFLICT with the proposed route?"* — i.e. route `busy` through the §4 classifier, not through raw overlap.
3. **Link where possible, infer where not.** Keep matching by userId today; add the optional per-worker `connecteam_shift_id` (§5.2) so new publishes carry an exact link. Old rows keep working via the inference.
4. **Dual-write already protects the board** (`assignments.ts:311-355`): `shift_assignments` stays in lock-step with `staff_shifts.assignees`, so the existing board/coverage code is unchanged while the classifier is introduced behind it. Ship the classifier read-only first (labels), then route the optimizer through it.
5. **No change to publish gating** — human-approved, idempotent, never auto-publishes a schedule into a route or a route into Connecteam twice.

---

## 10. DATA-OWNERSHIP MATRIX (validated against the real architecture)

| Data | Owner (SoR) | Zoe's posture | Evidence |
|---|---|---|---|
| Work **schedule** (shifts, windows, who's on) | **Connecteam** | Read (ingest); publish Zoe route shifts back as published shifts | `connecteam.ts:257-297` (read), `550-576` (write) |
| **Availability / time-off / blocked** | **Connecteam** (conceptually) | **No API** — not readable; UNAVAILABLE is manual/inferred only | §0, grep result |
| Pay **rates** / actual **hours** | **Connecteam** | Read-only (cost + clock mirror) | `connecteam.ts:333-367, 420-437` |
| **Route assignment** / plan / overrides / readiness | **Zoe (this app)** | Owns outright | `staff_shifts` + `shift_assignments` (`db/index.ts:576-645`), readiness/lifecycle engines |
| **Routes / stops / projects** | **Goodshuffle** | Read (drives demand) | `getRoutesForDate` → `demand.ts` |
| **Temp job status** (gig fills) | **Instawork** | Read (reconcile); **post not wired** | `instawork/*`, `AddWorkerPanel.tsx:182-214` |

The separation this doc designs is exactly the Connecteam-row-1 (schedule) vs Zoe-row (route assignment) boundary. Both already exist; the bug is that three functions read row-1 as if it were the Zoe row.

---

## 11. RULES CALCULATE, AI INTERPRETS

Every eligibility state, conflict, coverage number, and readiness level is a **deterministic function** of Connecteam shifts + Zoe assignments + route windows + roles + manual flags. No LLM participates in the decision. AI's only role is **after** the fact: turning the deterministic `reasons[]` into a sentence a dispatcher reads ("Used Maria — already scheduled 8–4, no route yet, covers this window; avoided a temp"). This matches the house law already in these files (`availability.ts:4-5`, `optimize.ts:17`, `planView.ts:4-5`, `types.ts:8`).

---

## 12. Risks + unresolved questions

**Risks**
- **Re-ingest feedback loop:** a published Zoe route becomes a Connecteam shift that re-reads as a schedule window. Correct under the classifier (→ ASSIGNED), but relies on userId+window matching until the per-worker link exists. A worker legitimately on two overlapping Connecteam windows is the one ambiguous case.
- **Removing `coverage.ts`'s silent credit will *raise* the visible gap** on day one (seats that *looked* covered now read "needs a decision"). That is correct and honest, but it is a visible change — pair it with the Auto Staff reclaim so the gap is immediately fillable from scheduled-unassigned, not alarming.
- **SCHEDULE-CONFLICT needs "covers," not "overlaps."** Today everything is coarse overlap (`availability.ts:32`, `optimize.ts:104`). Tightening to "window covered" is more correct but could newly exclude a partial-overlap worker — decide the policy (partial = conflict, or = eligible-for-the-covered-part).
- **UNAVAILABLE has no source.** If the UI shows the state at all, it must be unmistakably "manual/inferred," or it fabricates a fact (house-law violation).

**Unresolved questions (need the user)**
1. **Store a per-worker `connecteam_shift_id`** on `shift_assignments` for exact ASSIGNED matching, or stay on userId+overlap inference? (Additive; closes the one ambiguity.)
2. **Manual "unavailable" flag** — do we want a Zoe-side way to mark a worker off (since Connecteam can't tell us), or leave UNAVAILABLE unsupported and rely on SCHEDULE-CONFLICT + the dispatcher?
3. **SCHEDULE-CONFLICT policy:** does a Connecteam window have to fully *cover* the route window, or is partial overlap acceptable?
4. **Coverage semantics:** replace the auto-credit with explicit PROPOSED assignments (recommended), or keep a "soft coverage" preview number alongside the real gap?
5. **Prep auto-credit:** keep crediting day-level prep by schedule (it's genuinely day-level, not route-tied), or route prep through the same propose-don't-credit path?

---

## 13. Smallest safe changes first / build order / why

**Build first (read-only, reversible, no schema):**
1. **Add the pure classifier** `eligibilityFor(...)` + `WorkerEligibility` type and unit tests. Pure function, no caller yet. *Why first: it's the one new primitive; everything else just consumes it, and it's provably correct in isolation.*
2. **Surface it as labels only** — replace the `busyUserIds` boolean in `page.tsx` / `AddWorkerPanel` with the real states (no behavior change to the plan yet). *Why: makes the conflation visible to the dispatcher and lets the user validate the states against reality before any decision logic shifts.*

**Then (behavioral, still deterministic):**
3. **Route `availability.recommendCrew` and `optimize.feasible` through the classifier** so SCHEDULED-UNASSIGNED is eligible and the optimizer stops buying Instawork over idle scheduled crew. Add the `scheduledUnassignedBonus` tier. *Why: this is the actual bug fix; it's gated behind the now-validated classifier and covered by the existing optimizer tests.*
4. **Convert `coverage.ts`'s silent credit into explicit PROPOSED candidates** and add the Auto Staff internal-labor breakdown. *Why: removes the inverse bug and makes the gap honest; do it with (3) so the raised gap is immediately fillable.*

**Then (reconciliation + honesty):**
5. **Add Case C reconciliation warning** (honesty-gated) and extend the lifecycle tick to re-run the classifier so Case D never leaves a stale READY. *Why: closes the loop; reuses the existing tick + exception persistence.*

**Optional / later (additive schema + captures):**
6. Per-worker `connecteam_shift_id` for exact matching; a manual "unavailable" flag if the user wants one; Instawork post + Connecteam time-off read *if/when those endpoints are captured* — none are required for the core correction.

The entire core fix (steps 1–5) is **computation-only over records that already exist**, behind the dual-write that already keeps the board stable — a true refinement, not a rewrite.

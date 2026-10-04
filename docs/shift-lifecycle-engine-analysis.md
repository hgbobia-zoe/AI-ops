# Shift Lifecycle + Shift Readiness Engine — Architecture & Design

**Status:** Design for review (ANALYSIS ONLY — no production code changed by this task).
**Author:** Engineering analysis pass, 2026-10-04.
**Scope:** Evolve the current shift *builder* (`src/lib/scheduling/*`, `/scheduling`) into a full
**Shift Lifecycle + Readiness Engine** so a worker has *zero ambiguity at shift start* and the
dispatcher sees exceptions surfaced, not hunted.

**Governing design law (unchanged, holds throughout):** **RULES CALCULATE. AI INTERPRETS.**
Every deterministic fact — is a worker assigned, does a truck exist, is the shift staffed, readiness %,
state transitions, timers, scheduling — is a RULE. AI is used *only* to interpret risk, summarize
exceptions, explain *why* a shift isn't ready, and draft human-readable comms from already-structured
data. We never ask an LLM for a fact we can compute. We also never fabricate a fact: an unknown stays
`null` / `windowKnown=false`, never a guess (the house rule already enforced across `scheduling/*`,
`connecteam.ts`, `instawork/*`, `risk/*`).

---

## Table of contents

- A. Current-state architecture
- B. Gap analysis
- C. Proposed architecture
- D. Data-model changes (+ the state machine)
- E. Integration changes (honest captured-vs-needed surface)
- F. UI changes (dispatcher-centric)
- G. Automation / event model
- H. Exception model (RED/YELLOW/GREEN)
- 3–13. The specific models (lifecycle state machine, readiness, packet, comms timeline, idempotency, audit, ownership matrix)
- I. Migration strategy
- J. Implementation phases
- 17. Risks and unresolved questions
- **What should be built first, what should wait, and why**

---

## A. Current-state architecture

### A.1 The shift model that exists today (the thing we are evolving)

**`staff_shifts`** is the app-owned shift record and the right foundation to extend.
- Schema: `src/lib/db/index.ts` (the `CREATE TABLE staff_shifts` block, ~line 534). Columns:
  `id` (`SH-<uuid>`), `date`, `role` (`driver|field|prep`), `headcount`, `start_time`/`end_time`/`window_known`,
  `location`, `route_id`, `truck_id`, `event_label`, `reasons` (JSON), `notes`, `source` (`derived|manual`),
  `status` (`draft|confirmed|sent|cancelled`), `assignees` (JSON number[] of **Connecteam userIds**),
  `instawork_headcount`, `pay_rate`, `connecteam_shift_id`, `connecteam_scheduler_id`,
  `connecteam_published_at`, `instawork_gig_id`, `instawork_posted_at`, `created_at`, `updated_at`.
- Types: `src/lib/scheduling/types.ts` — `StaffShift`, `ShiftRole`, `ShiftStatus`, `ShiftSource`,
  `DemandShift`, and the pure helper `shiftGap()`.
- Store/CRUD: `src/lib/scheduling/store.ts` — `getShiftsForDate`, `getShiftById`, `createShift`,
  `updateShift`, `deleteShift`, and `syncDemand()` (idempotent demand→draft materialization keyed by
  `(date, role, routeId)`, which **skips any shift a human has touched**: `status !== 'draft' ||
  assignees.length>0 || instaworkHeadcount>0`).

**Key observation:** a `staff_shift` row today is a *crew-demand line* (role × headcount × window ×
route), NOT a per-worker operational assignment. `assignees` is a bag of userIds on the demand row.
There is no per-worker record, so there is nowhere to hang "what did *this worker* receive", "has
*this worker* confirmed", "did *this worker* clock in". This is the central structural gap for the
lifecycle engine (see D).

### A.2 Demand / coverage / availability (the deterministic calculators)

- `src/lib/scheduling/demand.ts` — `buildDemand(routes)`: deterministic. One **driver** shift per active
  route (window from `routeWindow()` in `risk/engine.ts`), **field** = `crewForRoute(items).crew − 1`
  (tent rules via `src/lib/crewRules.ts`), **prep** = one per delivery route, window left unknown
  (`windowKnown=false`) because clock time isn't known. Reuses the exact Event-Risk primitives, so the
  schedule matches what Risk says.
- `src/lib/scheduling/coverage.ts` — `computeCoverage(shifts, scheduledCrew)`: nets people already on
  the Connecteam schedule that day against demand so a covered shift doesn't read as an Instawork gap.
  Field is **never** auto-credited (Connecteam's "other" bucket contains office/admin).
- `src/lib/scheduling/availability.ts` — `recommendCrew(shift, dayShifts, roster)`: who is *free*
  (role-matched, not on an overlapping Connecteam shift, least-loaded first). Honest: it is an inference
  from the Connecteam schedule, not a personal calendar.

### A.3 The board + editors (the current UI)

- Page: `src/app/(console)/scheduling/page.tsx` (server component, `force-dynamic`). Pulls routes,
  shifts, Connecteam coverage + roster, Instawork snapshot; computes coverage + per-shift/per-route
  recommendations; renders a route-centric board. `FigureStrip`: Shifts / People needed / Internal /
  Gap→Instawork.
- `src/components/scheduling/RouteStaffBoard.tsx` — one card per route (people as one list: internal +
  Connecteam-scheduled + actual Instawork gig workers), "needs N more Driver", a Warehouse/Prep
  day-level section with "move to a route", and role chips opening the editor.
- `src/components/scheduling/ShiftEditor.tsx` — edit role/headcount/window/assignees/instawork/pay/status;
  **Publish to Connecteam** (confirm→publish). Idempotent re-publish via `connecteamShiftId`.
- `src/components/scheduling/AddWorkerPanel.tsx` — per-route "add worker": Connecteam (assign + publish)
  or Instawork (**records a gig request on the shift's notes; does NOT post** — "wired next").

### A.4 The existing formal lifecycle to mirror — the Stop/Route state machine

This is the single most important precedent for the design. `src/lib/stateMachine.ts` is a **declarative
transition table** (`TRANSITIONS: TransitionDef[]`) driving BOTH (1) which buttons the device renders
(`getAvailableActions`) and (2) server-side intake validation (`resolveTransition`). Guards:
`requiresApproval`, `requiresChecklist`, `lastStopOnly`, `notLastStop`. Side actions
(`NOTIFY_DISPATCH`, `GAS_LOG`) are not transitions. States: `Waiting → EnRoute → Arrived → Completed
→ … → Returned`, with `Exception` reachable from active states.

- Action intake: `src/app/api/action/route.ts` — validates the transition, records the event with an
  **idempotency key** (`insertEventIfNew` — `events.idempotency_key UNIQUE`; replays return
  `duplicate:true` with no re-send or re-fire), updates stop state, then fires fan-out fire-and-forget.
- Client machine: `src/lib/useRouteMachine.ts` (optimistic UI over the same table).
- Types: `src/lib/types.ts` (`StopState`, `ActionType`, `ActionRequest` carries `idempotencyKey`).

**The lifecycle engine should copy this shape exactly:** a declarative transition table, server-side
validated, idempotent intake, with a client helper for buttons. Do not invent a new pattern.

### A.5 Integrations (read the real surface — documented honestly in E)

- **Connecteam** (`src/lib/connecteam.ts`): real REST API, `X-API-KEY`. Reads users
  (`/users/v1/users`, Title→role), schedulers, shifts (`getCrewForDateSafe` with an `ok` reachability
  flag), pay rates, time-clock timesheets (**timekeeping lives here**). Writes:
  `createPublishedShift` / `updatePublishedShift` (POST/PUT `/scheduler/v1/schedulers/{id}/shifts?notifyUsers=true`),
  `getDefaultScheduler`. TTL-cached single-flight health probe (`refreshConnecteamHealth`).
- **Instawork** (`src/lib/instawork/*`): **browser-pull only** — the server never calls Instawork
  (Cloudflare/datacenter-IP block). The Auto-Pull extension fetches `GET /api/partner/gigs/groups/`
  same-origin in a logged-in tab and POSTs to `/api/instawork/import`; `store.ts` snapshots it; `client.ts`
  reads the snapshot; `reconcile.ts` matches gigs to routes; `monitor.ts` infers drop-offs/no-shows by a
  booked worker disappearing (`checkInstaworkChanges`). `parse.ts`/`types.ts` define exactly what is
  captured (see E — notably **no worker phone, no worker id, no clock-in codes, no messaging**).
- **Comms**: `src/lib/notify/sms.ts` (provider-abstracted via `src/lib/providers.ts`, OpenPhone/Quo
  active), `slack.ts` (two webhooks: delivery + customer-alerts), `fanout.ts` (the per-action customer
  SMS + Slack + tracking), `alert.ts` (throttled ops-failure alerts), `routeRisk.ts`. Message rows:
  `messages` table, `status ∈ {sent, skipped, failed}` set **at send time only** (no delivery callback
  wired for outbound SMS). Inbound/opens are tracked elsewhere (`comms_events`, GS `messageOpenedDate`
  for the quote-open alert).
- **Goodshuffle write-back**: `gs_outbox` table + `enqueueGsOp()` (`repo.ts` ~line 1498); the extension
  drains it (`src/lib/gsPull.ts`) replaying ops in a logged-in session. Live ops today:
  `remove_waypoint`, `photo_upload`, `add_team_member`, `email_send`, `create_project`. This is the
  proven pattern for any write our server can't make directly.

### A.6 Runtime / jobs / audit / health / readiness precedents

- **Runtime**: `src/lib/runtime/jobs.ts` (`RUNTIME_JOBS`, `runServerJobs`, `computeJobStatus`) + the
  token-gated tick `src/app/api/runtime/tick/route.ts`, driven by a GitHub Actions off-machine clock.
  Jobs declare a `bucket` (`server` the runtime runs; `browser` it only surfaces freshness for). Results
  land in the import ledger (`logImport`), reused by health. **This is where lifecycle timers belong.**
- **Audit / history**: `src/lib/history/store.ts` — `event_snapshots` (point-in-time, dedup by sig),
  `history_changes` (append-only, idempotent by `change_key`), `event_outcomes`. Plus the generic
  `audit_logs` table + `insertAudit()`.
- **Health / readiness precedents**: `src/lib/health/connections.ts` (OK / ATTENTION / OFF + a
  `fixHref`/`fixLabel` prompt per integration — the exact shape the exception queue should take);
  `src/lib/risk/readiness.ts` + `event_readiness` table (deterministic weighted 0–100 score, docked by
  the worst finding per component, CRITICAL zeroes a component — the exact shape the shift-readiness
  score should take).
- **Shift Passes**: `shift_passes` table + `src/app/pass/[token]/route.ts` + `src/lib/auth/pass.ts` —
  a time-limited, revocable, scoped per-shift guest link. This is the precedent for giving a *worker*
  (especially a temp) a per-shift view without an account.
- **Auth**: `src/lib/auth/roles.ts` — Owner/Admin/Member/guest; `canManageSettings` gates publishing.

---

## B. Gap analysis — what's missing for the full lifecycle

Ranked by how much they block "zero ambiguity at shift start."

1. **No per-worker assignment entity.** `staff_shifts.assignees` is a bag of userIds. There is no row
   per (shift × worker) to carry acceptance, packet-received, confirmation, clock-in/out linkage, or
   per-worker exceptions. *This is the keystone gap.* Everything else hangs off it.
2. **No lifecycle state machine for a shift.** `ShiftStatus` is a flat 4-value enum
   (`draft|confirmed|sent|cancelled`) with no transition table, no guards, no entry/exit conditions, no
   terminal detection, no "staffed / ready / in-progress / complete" distinction. The Stop machine
   (A.4) is the template; the shift has nothing equivalent.
3. **No readiness computation for a shift.** Readiness today is *event*-level (`risk/readiness.ts`),
   not *shift/worker*-level. There is no STAFFING / LOGISTICS / COMMUNICATION / TIMEKEEPING /
   CONFIRMATION roll-up telling a dispatcher "this shift is GREEN/ready" or "RED because the driver
   hasn't confirmed and no truck is assigned."
4. **No shift packet.** Nothing assembles "everything the worker needs" (report time/place, route,
   truck, supervisor, role, equipment, event instructions, clock-in/out) into one structured artifact,
   and nothing versions "what did this worker actually receive."
5. **No worker-facing delivery of the packet.** Internal crew get a Connecteam published shift (title +
   window only — no report location/truck/supervisor/equipment). Temp workers get *nothing* from Zoe
   (we only read their gig). No SMS of a packet, no scoped link.
6. **No confirmation loop.** Nothing records "worker acknowledged." A published Connecteam shift ≠ a
   confirmation. Instawork "accepted" is inferred from the browser snapshot, not an explicit signal.
7. **No shift-level exception queue.** `monitor.ts` Slack-alerts Instawork drop-offs (good, but fire-and-
   forget to Slack, not a tracked queue). There is no RED/YELLOW/GREEN actionable queue with
   detection→severity→action→resolution for *shifts* (truck missing, unconfirmed, understaffed,
   no-show, late clock-in).
8. **No timers for the shift lifecycle.** The runtime runs integration pulls; nothing schedules
   "day-before packet at T−1d", "refresher at T−45m", "escalate if unconfirmed by T−12h."
9. **Instawork write + worker comms are not captured.** Posting a gig is recorded-only (AddWorkerPanel).
   There is no captured API for worker phone, clock-in codes, or worker messaging (E).
10. **Truck/supervisor are implicit.** `truck_id` is on the shift, but there is no explicit supervisor
    assignment, and equipment/load-list exists only as GS line items on stops — not surfaced to a shift.

What is *already present and must be reused, not rebuilt*: the demand/coverage/availability calculators
(A.2), the Connecteam publish path (A.3/A.5), the Instawork read+monitor (A.5), the `gs_outbox` write
pattern, the runtime job runner, the history/audit stores, the readiness/connections *shapes*, and the
Shift Pass mechanism.

---

## C. Proposed architecture — built ON the existing abstractions

The engine is **three new deterministic modules + one new per-worker entity + a thin set of UI/API
surfaces**, all reusing existing infrastructure. No parallel workflow.

```
                         ┌──────────────────────────────────────────┐
  routes + crew rules →  │  scheduling/demand.ts  (EXISTS)           │  shifts (staff_shifts, EXISTS)
  Connecteam coverage →  │  scheduling/coverage.ts (EXISTS)          │
                         └──────────────────────────────────────────┘
                                        │  (one staff_shift = crew-demand line)
                                        ▼
                         ┌──────────────────────────────────────────┐
   NEW per-worker row →  │  shift_assignments  (NEW TABLE)           │  one row per (shift × worker)
                         │  worker_kind, worker_ref, lifecycle state │
                         └──────────────────────────────────────────┘
          ┌──────────────────────┬───────────────────────┬────────────────────────┐
          ▼                      ▼                       ▼                        ▼
 scheduling/lifecycle.ts  scheduling/readiness.ts  scheduling/packet.ts    scheduling/exceptions.ts
 (NEW: transition table,  (NEW: STAFFING/LOGISTICS/ (NEW: assemble + version  (NEW: RED/YELLOW/GREEN
  mirrors stateMachine)    COMMS/TIMEKEEPING/CONF)   the SHIFT PACKET)         deterministic queue)
          │                      │                       │                        │
          └──────────────────────┴───────────────────────┴────────────────────────┘
                                        │ reuse EXISTING infra:
            runtime/jobs.ts (timers) · notify/* + gs_outbox (comms) · history/store.ts (audit)
            · connecteam.ts (publish + timekeeping LINK) · instawork/* (read) · auth/pass.ts (worker link)
```

New pure modules (all deterministic, all unit-testable like `coverage.ts`/`readiness.ts`):

- `src/lib/scheduling/lifecycle.ts` — the **shift + assignment state machines** (transition tables,
  guards, `resolveTransition`, `getAvailableActions`), modeled 1:1 on `src/lib/stateMachine.ts`.
- `src/lib/scheduling/readiness.ts` — `computeShiftReadiness(shift, assignments, context)` →
  component scores + `ShiftReadinessLevel` (modeled on `risk/readiness.ts`).
- `src/lib/scheduling/packet.ts` — `buildShiftPacket(shift, assignment, route, truck, supervisor, event)`
  → a structured `ShiftPacket` + a `packetVersion` hash (so "what did this worker receive" is answerable).
- `src/lib/scheduling/exceptions.ts` — `scanShiftExceptions(day)` → `ShiftException[]`
  (modeled on `health/connections.ts` shape + `risk/scan.ts` scan loop).
- `src/lib/scheduling/comms/templates.ts` — structured-data-driven packet/refresher templates (not
  hardcoded strings), feeding `notify/sms.ts` for temp workers and Connecteam for internal.

New persistence: `shift_assignments`, `shift_packets` (versioned), `shift_assignment_events`
(append-only), plus a few columns on `staff_shifts` (D).

AI layer (optional, dormant-by-default like `src/lib/llm.ts`/`risk` LLM): interprets the deterministic
exception set into one dispatcher-readable summary and drafts the packet/refresher prose from the
structured packet. **Never** sets a state, computes readiness, or decides staffed/not.

---

## D. Data-model changes (+ the state machine)

**Principle:** extend `staff_shifts`; add a per-worker child; do not build a parallel system.

### D.1 `staff_shifts` — add lifecycle + logistics columns (additive, nullable)

```sql
ALTER TABLE staff_shifts ADD COLUMN lifecycle_state TEXT;      -- the new state machine (D.4); null → derive from legacy status on read
ALTER TABLE staff_shifts ADD COLUMN supervisor_user_id INTEGER;-- Connecteam userId of the on-shift lead (nullable = unknown, surfaced as a gap)
ALTER TABLE staff_shifts ADD COLUMN report_location TEXT;      -- explicit report-to (defaults to location; venue vs warehouse)
ALTER TABLE staff_shifts ADD COLUMN report_time TEXT;          -- ISO report/arrival time (may precede start_time, e.g. load buffer)
ALTER TABLE staff_shifts ADD COLUMN equipment TEXT;            -- JSON string[] derived from route items / crew rules (load list)
ALTER TABLE staff_shifts ADD COLUMN instructions TEXT;         -- free-text event instructions for the crew
ALTER TABLE staff_shifts ADD COLUMN readiness_json TEXT;       -- cached last computed readiness (derived; never a source of truth)
```

`lifecycle_state` is the authoritative field going forward; the legacy `status`
(`draft|confirmed|sent|cancelled`) is kept and derived both ways during migration (I).

### D.2 `shift_assignments` — the keystone new entity (one row per worker on a shift)

```sql
CREATE TABLE IF NOT EXISTS shift_assignments (
  id                 TEXT PRIMARY KEY,        -- "SA-"+uuid
  shift_id           TEXT NOT NULL,           -- → staff_shifts.id
  worker_kind        TEXT NOT NULL,           -- 'internal' | 'instawork'
  -- Identity is a LINK, never a duplicate of the system of record:
  connecteam_user_id INTEGER,                 -- internal: Connecteam userId (SoR for the person + timekeeping)
  instawork_worker   TEXT,                    -- instawork: the only stable handle captured today = worker NAME (honest; see E)
  instawork_gig_id   TEXT,                    -- the matched gig group id (reconcile)
  display_name       TEXT,                    -- cached for display/audit (name at time of assignment)
  role               TEXT NOT NULL,           -- driver | field | prep (copied from the shift at assign time)
  state              TEXT NOT NULL,           -- assignment lifecycle (D.5)
  -- Operational provisioning (facts, each nullable with an explicit *_at):
  packet_version     TEXT,                    -- the shift_packets.version this worker last received (null = none sent)
  packet_sent_at     TEXT,
  confirmed_at       TEXT,                    -- explicit worker acknowledgement (null = not confirmed)
  confirm_method     TEXT,                    -- 'sms_reply' | 'link_open' | 'dispatcher' | 'connecteam' (how we know)
  clock_in_at        TEXT,                    -- internal: MIRRORED from Connecteam timesheet (read-only cache); instawork: unknown today
  clock_out_at       TEXT,
  clock_source       TEXT,                    -- 'connecteam' | 'unavailable' (NEVER our own timekeeping for internal)
  no_show            INTEGER DEFAULT 0,       -- deterministic flag set by the exception scan
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE(shift_id, worker_kind, connecteam_user_id, instawork_worker)  -- idempotent assignment (dup prevention)
);
CREATE INDEX IF NOT EXISTS idx_shift_assignments_shift ON shift_assignments(shift_id);
```

Notes:
- **Internal vs Instawork are genuinely different rows** (`worker_kind`), with different identity
  handles and different timekeeping semantics — exactly as the brief requires. For internal,
  `clock_*` is a **read-only mirror** of Connecteam's timesheet (Connecteam OWNS it). For Instawork,
  `clock_*` is `unavailable` today (no captured API — E), surfaced honestly, never faked.
- `assignees` on `staff_shifts` stays during migration as the derived "internal userIds" projection;
  the lifecycle engine reads/writes `shift_assignments` and keeps `assignees` in sync (I).

### D.3 `shift_packets` (versioned) + `shift_assignment_events` (append-only audit)

```sql
CREATE TABLE IF NOT EXISTS shift_packets (
  id            TEXT PRIMARY KEY,   -- "SP-"+uuid
  shift_id      TEXT NOT NULL,
  version       TEXT NOT NULL,      -- content hash of the structured packet (so a resend with no change = same version)
  packet_json   TEXT NOT NULL,      -- the full structured ShiftPacket (schema in §9)
  created_at    TEXT NOT NULL,
  UNIQUE(shift_id, version)
);

-- Immutable operational history for a shift/assignment (mirrors history_changes + its change_key dedup).
CREATE TABLE IF NOT EXISTS shift_assignment_events (
  id            TEXT PRIMARY KEY,   -- "SE-"+uuid
  ts            TEXT NOT NULL,
  shift_id      TEXT,
  assignment_id TEXT,
  actor         TEXT,               -- currentActor (human) OR 'system' (named, per the attribution memory rule)
  kind          TEXT NOT NULL,      -- assigned | packet_sent | confirmed | clock_in | clock_out | reassigned | cancelled | exception_opened | exception_resolved | state_change
  field         TEXT,
  from_value    TEXT,
  to_value      TEXT,
  change_key    TEXT UNIQUE         -- idempotency: same transition logged once (same discipline as history_changes)
);
CREATE INDEX IF NOT EXISTS idx_shift_assignment_events_shift ON shift_assignment_events(shift_id, ts DESC);
```

These reuse the `history/store.ts` discipline exactly (dedup by `change_key`, append-only). The existing
`event_snapshots`/`history_changes` remain the *event*-level history; this is the *shift*-level history.

### D.4 SHIFT lifecycle state machine (shift-level) — refined from the brief's conceptual states

Modeled on `src/lib/stateMachine.ts` (declarative `TRANSITIONS`, server-validated). Refined states
(the brief's "SHIFT CREATED → … → SHIFT COMPLETE" collapsed to what the data actually supports):

| State | Meaning | Entry condition | Exit → |
|---|---|---|---|
| `DRAFT` | demand line exists (derived or manual) | `createShift`/`syncDemand` | `STAFFED`, `CANCELLED` |
| `STAFFED` | headcount met by internal + Instawork (gap=0) and window known | coverage gap == 0 AND `windowKnown` | `PROVISIONED`, `DRAFT` (if gap reopens), `CANCELLED` |
| `PROVISIONED` | published to Connecteam and/or gig posted; packets built | Connecteam publish ok AND/OR gig posted | `NOTIFIED`, `CANCELLED` |
| `NOTIFIED` | packet delivered to every assignment | every assignment `packet_sent_at != null` | `CONFIRMED`, `PROVISIONED` (re-notify on change) |
| `CONFIRMED` | every assignment acknowledged (or dispatcher-confirmed) | every assignment `confirmed_at != null` | `READY`, `NOTIFIED` |
| `READY` | readiness == GREEN (D/§8): staffed+logistics+comms+timekeeping-linked+confirmed | `computeShiftReadiness == READY` | `IN_PROGRESS`, back-transitions on any regression |
| `IN_PROGRESS` | first clock-in (internal mirror) or shift start time passed | `clock_in_at` seen OR now ≥ `start_time` | `COMPLETE`, `EXCEPTION` |
| `COMPLETE` | shift end passed and (internal) clock-outs mirrored / route closed | now ≥ `end_time` AND no open blocking exception | terminal |
| `EXCEPTION` | a RED exception is open against the shift | exception scan opens one | returns to prior on resolve |
| `CANCELLED` | shift called off | dispatcher action | terminal |

Per-state detail (entry/exit, data required, automated actions, timers, failure conditions, human
intervention, next states) is specified in §3. Guards reuse the `TransitionDef` shape:
`requiresApproval` (cancel a sent shift, reopen a complete one), plus new guards `requiresStaffed`,
`requiresWindow`, `requiresConfirmations`.

### D.5 ASSIGNMENT lifecycle (per-worker) — the inner machine

`PROPOSED → ASSIGNED → NOTIFIED → CONFIRMED → CLOCKED_IN → CLOCKED_OUT`, plus `DECLINED`, `NO_SHOW`,
`CANCELLED`, `REPLACED`. The shift state is a deterministic roll-up of its assignments' states (a shift
is `CONFIRMED` only when all assignments are ≥ `CONFIRMED`; `IN_PROGRESS` when any is `CLOCKED_IN`).
For internal workers `CLOCKED_IN/OUT` are set **only** from Connecteam's timesheet mirror; for Instawork
they stay unknown unless a future capture provides them (E).

---

## E. Integration changes — honest captured-vs-needed surface

> The brief insists: *do not assume API capabilities.* Below is exactly what the code supports today.

### E.1 Connecteam — **owns internal timekeeping; Zoe links, never duplicates**

- **Have (reads):** users + Title→role (`getUsers`), schedulers, day shifts with reachability flag
  (`getCrewForDateSafe.ok`), **pay rates** (`getPayRates`), **actual paid hours / timesheets**
  (`getActualHours`, `getTimeClocks`), planned hours (`getPlannedHours`). `connecteam.ts` lines ~300–437.
- **Have (writes):** `createPublishedShift` / `updatePublishedShift` (POST/PUT
  `/scheduler/v1/schedulers/{id}/shifts?notifyUsers=true`, `notifyUsers=true` pushes the Connecteam
  notification), `getDefaultScheduler`. Honest `ok` only on a real 2xx; idempotent re-publish via
  `connecteam_shift_id`.
- **Design decision:** Connecteam is the **System of Record for the internal person and their
  clock-in/out**. Zoe ASSIGNS (publishes the shift), INFORMS (the packet), TRACKS readiness, MONITORS
  exceptions, and **LINKS** to the Connecteam userId (`shift_assignments.connecteam_user_id`). Zoe does
  **not** build its own clock-in/out for internal crew. `clock_in_at/out_at` on the assignment are a
  **read-only mirror** refreshed from `getActualHours` (daily-record grain) — enough to light
  TIMEKEEPING green and to detect a late/absent clock-in as an exception, without owning the data.
- **Gap/needed:** the timesheet endpoint is **daily-record grain** (`dailyTotalHours`), not a precise
  punch instant. For a T−0 "did they clock in on time" signal we either (a) accept day-grain (know *that*
  they clocked in, not the exact minute) or (b) confirm whether Connecteam exposes a punch/attendance
  webhook or time-activities endpoint (not currently in `connecteam.ts`). **Document as: present at
  day-grain; precise punch time = NEEDED, to be confirmed against Connecteam's time-activities API.**
- **Needed capability check:** whether `assignedUserIds` on publish triggers the worker's Connecteam
  push/SMS reliably enough to count as "NOTIFIED" (today we assume yes because `notifyUsers=true`). The
  confirmation signal (did they *see* it) is **not** returned — so CONFIRMED for internal workers needs
  either a dispatcher confirm, a Connecteam read of shift acknowledgement (confirm availability in
  `getShifts` response — to be verified), or a Zoe-side SMS+reply confirm (E.3).

### E.2 Instawork — read-only snapshot; **write + worker comms + clock codes NOT captured**

What `parse.ts`/`types.ts` actually capture from `GET /api/partner/gigs/groups/` per gig group:
`id, name, startsAt, endsAt, timezone, position, basePrice, filled, total, locationName,
workers: string[] (NAMES only), interestedPending`.

Therefore, **honestly**:
- **Worker phone:** NOT captured. We have a worker's *name* only. Zoe cannot text an Instawork worker
  directly from captured data.
- **Acceptance status (per worker):** NOT explicit. "Booked" is inferred from `filled`/`workers[]`
  presence in the snapshot; a drop is inferred by a name disappearing (`monitor.ts`). An Instawork
  **timeout/stale snapshot must NEVER be read as "accepted"** — `getInstaworkShifts` returns
  `ok:false/not_configured` and the board already refuses to treat empty as "nothing booked."
- **Clock-in/out codes:** NOT captured. Instawork has worker check-in in its own app; our surface has
  no clock codes or punch data. **TIMEKEEPING for Instawork workers = `unavailable` (honest), never
  faked.**
- **Worker messaging:** NOT captured. No message endpoint in the surface.
- **Posting a gig (write):** NOT captured. `AddWorkerPanel` records the request on the shift notes only.

How the missing pieces would be obtained (proposals, each explicit):
1. **Gig-post write:** capture the real `POST` once in the logged-in Instawork dashboard (same
   capture discipline used for GS write-backs), then enqueue it through a new **`instawork_outbox`**
   drained by the Auto-Pull extension same-origin — mirroring `gs_outbox`/`gsPull.ts`. Until captured,
   keep the record-only behavior and flag the shift's gap as "post on Instawork (manual)".
2. **Worker phone / clock codes / messaging:** confirm whether the Instawork **business API** (not the
   dashboard internal endpoint) exposes worker contact/attendance. If it does not, the honest design is:
   Instawork workers are informed **through Instawork's own app** (the gig description carries report
   location/time/instructions — so we push that into the gig text when we post it), and Zoe's packet to
   an Instawork worker is **the gig itself**; their clock-in is owned by Instawork and surfaced as
   `unavailable` on our side. A Zoe scoped **Shift Pass link** (A.6) printed in the gig description is
   the fallback to give them the operational packet view without their phone number.

### E.3 Quo / OpenPhone (SMS) — real message lifecycle states

- `sendSms()` (`notify/sms.ts`) → provider abstraction (`providers.ts`), OpenPhone active. `messages`
  row `status ∈ {sent, skipped, failed}` set **at send time**. There is **no delivered/confirmed
  callback wired for outbound SMS** today (inbound + call events + GS email opens are tracked separately
  in `comms_events`/`call_events`).
- **Real states the code supports now:** `skipped` (provider unconfigured), `sent` (API accepted),
  `failed` (API error). Nothing beyond `sent`.
- **Needed for the comms-reliability model (§10):** to light COMMUNICATION green honestly we need
  `queued → sent → delivered → failed`. OpenPhone *does* emit message status webhooks; wire an
  OpenPhone delivery webhook into a `comms_delivery` status on the `messages`/assignment, and derive
  **CONFIRMED** from an inbound reply (`message.received` → match to the assignment's phone) — the
  quote-open-alert path already proves inbound matching. Until wired, COMMUNICATION can only assert
  "sent", and CONFIRMED for a texted worker must come from an explicit reply or dispatcher confirm —
  never assumed from `sent`.
- **House style:** all worker comms go through `src/lib/llm.ts` `COMMS_STYLE` + `humanize()` — no
  dashes/emoji, short, natural (the comms-no-dashes memory rule). Packets are structured data rendered
  through templates, so the deterministic floor needs no LLM at all.

### E.4 Goodshuffle — source of event facts; write-back via outbox

- **Read (facts into the packet):** event label, stop window, venue address, line items (equipment),
  day-of coordinator — already on `Stop`/`Route` (`types.ts`) from the pull.
- **Write (optional):** if we ever want the shift/crew reflected on the GS project, enqueue a new
  `gs_outbox` op (same pattern). Not required for v1 — Goodshuffle is upstream of staffing.

---

## F. UI changes — dispatcher-centric

All additive within the existing `(console)` route group + console-primitives + Nocturne tokens
(the board already uses `FigureStrip`, `SidePanelOverlay`, `surface`, etc.).

1. **Scheduling board → add a readiness column/badge per route card** (`RouteStaffBoard.tsx`
   `RouteCard`): a GREEN/YELLOW/RED dot + "Ready" / "3 blockers" from `computeShiftReadiness`, reusing
   the connections OK/ATTENTION/OFF visual language. The existing per-role "needs N more" stays.
2. **Shift Readiness summary card** (new component `ShiftReadinessCard.tsx`): STAFFING / LOGISTICS /
   COMMUNICATION / TIMEKEEPING / CONFIRMATION sub-bars (like `risk/readiness` components) with the one
   missing fact per red sub-bar ("No truck assigned", "Driver unconfirmed", "Report time not set").
3. **Exception queue** (new blade or a panel on `/scheduling` and `/dashboard`): a sorted
   RED→YELLOW→GREEN list from `scanShiftExceptions`, each row = detection + one-click action (reassign,
   re-send packet, mark confirmed, post gig) + `fixHref` — the exact `connections.ts` shape. Surfaced
   on the Command Center (`commandCenter()` aggregation) so it's on the dashboard too.
4. **Shift packet preview + "Send packet"** in `ShiftEditor` / `AddWorkerPanel`: render the structured
   packet, show packet version + "sent to N, confirmed by M", and a Send/Resend button (internal →
   Connecteam + optional SMS; temp → gig text / pass link). Replaces the current "wired next" dead
   buttons.
5. **Worker packet view** (new `src/app/shift/[token]/route.ts` + page): a scoped, Shift-Pass-style
   read-only packet link a worker opens — report time/place, map, truck, supervisor, role, equipment,
   instructions, and clock-in/out *instructions* (not a Zoe clock for internal — a deep link / reminder).
6. **Timeline** on the shift detail: the `shift_assignment_events` log ("assigned 3d out → packet sent
   T−1d → confirmed T−20h → clocked in 7:58a") — reusing the history timeline rendering.

---

## G. Automation / event model — mapped onto runtime/jobs + outbox

**Events** (what moves the machine): human actions (assign, confirm, publish, cancel), integration
signals (Connecteam publish ok, Instawork snapshot diff, Connecteam timesheet mirror, inbound SMS
reply/OpenPhone delivery webhook), and **timers**.

**Timers** live as a new **server-bucket runtime job** `shift-lifecycle` in `RUNTIME_JOBS`
(`src/lib/runtime/jobs.ts`), run by the existing token-gated tick (`/api/runtime/tick`, GitHub-Actions
clock). Each tick, for the look-ahead window of days:
1. recompute coverage + readiness for every shift (deterministic),
2. advance lifecycle states whose entry conditions are now met (and record `state_change` events),
3. mirror Connecteam timesheets for internal assignments (clock-in/out cache),
4. diff the Instawork snapshot (reuse `monitor.ts`) and update assignment states / no-show flags,
5. run `scanShiftExceptions` and open/resolve exceptions idempotently,
6. fire **due** scheduled comms (on-assignment / day-before / refresher — §10) via the outbox,
7. record everything to `shift_assignment_events` + the import ledger.

**Triggers/retries:** comms + gig posts go through outboxes (`gs_outbox` today; a new
`instawork_outbox` later) and inherit the proven retry/ack discipline (`ackGsOp`, `attempts`,
`last_error`). A failed send is retried and, crucially, **does not advance the shift to a state it
hasn't earned** (a failed packet send leaves `packet_sent_at` null, so the shift can't reach NOTIFIED —
see §11). The runtime is idempotent: `computeJobStatus`-style status, dedup by `change_key`, so replays
are safe (exactly like the existing jobs).

**Scheduled comms timing** is computed from the shift window (deterministic), not a wall clock the user
sets: on-assignment = immediately on reaching PROVISIONED; day-before = `start_time − ~16h`
(dispatcher-tunable); refresher = `start_time − 45m` (tunable). The tick fires anything now-due and not
yet sent (idempotent).

---

## H. Exception model — RED / YELLOW / GREEN, actionable only

Pure function `scanShiftExceptions(shifts, assignments, context, now)` → `ShiftException[]`, persisted
idempotently by a stable `signature` (same discipline as `risk_items`), lifecycle
OPEN→ACKNOWLEDGED→RESOLVED. **Only actionable alerts** — an UNVERIFIED integration (Connecteam
unreachable, Instawork stale) is an UNKNOWN, never a fabricated exception (same rule as
`readiness.ts` `!f.unverified`).

Each exception specifies: detection → severity → automated action → notification → human action →
resolution.

| # | Exception | Detect (rule) | Severity | Automated action | Notify | Human action | Resolves when |
|---|---|---|---|---|---|---|---|
| 1 | **Understaffed** | coverage gap > 0 at T−Nd | YELLOW (→RED < T−1d) | surface recommendations; keep gig record | Slack ops on RED | assign / post gig | gap == 0 |
| 2 | **No truck assigned** | shift has route but `truck_id` null | RED | — | board badge | set truck | truck set |
| 3 | **No window / report time** | `windowKnown=false` or `report_time` null near T | YELLOW | — | badge | set time | time set |
| 4 | **Not published** | STAFFED but no `connecteam_shift_id` and gap internal | YELLOW | — | badge | publish | published |
| 5 | **Packet not delivered** | NOTIFIED-expected but an assignment `packet_sent_at` null | YELLOW | retry send (outbox) | badge | resend / check phone | all sent |
| 6 | **Unconfirmed near start** | `confirmed_at` null at T−12h | YELLOW (→RED at T−2h) | send refresher | Slack on RED | call / dispatcher-confirm | confirmed |
| 7 | **Instawork drop-off / no-show** | worker left `workers[]` near/after start (`monitor.ts`) | RED | mark `no_show`; reopen gap | Slack (exists) | reassign / re-post | backfilled or waived |
| 8 | **Late / missing clock-in (internal)** | now ≥ start+grace and no Connecteam mirror | YELLOW (→RED) | — | Slack | call worker | mirror shows clock-in |
| 9 | **Comms failed** | message `status=failed` for an assignment | YELLOW | retry (outbox) | Slack ops (exists via `alertOps`) | alt contact | delivered/confirmed |
| 10 | **Supervisor missing** | multi-person shift, `supervisor_user_id` null | YELLOW | — | badge | assign lead | set |

GREEN = no open exceptions and readiness READY. The queue sorts RED→YELLOW→GREEN (the
`connections.ts` `rank` pattern). AI (optional) writes the one-line human summary of the open set; it
does not detect or rank.

---

## 3. SHIFT LIFECYCLE STATE MACHINE (full specification)

Declarative table in `src/lib/scheduling/lifecycle.ts`, same shape as `stateMachine.ts`. Per state:

- **DRAFT** — *entry:* `createShift`/`syncDemand`. *data:* date, role, headcount. *automated:* demand
  refresh (existing `syncDemand`, skips human-touched). *timers:* none. *failure:* none. *human:* edit,
  assign. *next:* STAFFED (gap 0 + window), CANCELLED.
- **STAFFED** — *entry:* `coverageGap==0 && windowKnown`. *data:* assignments covering headcount.
  *automated:* compute readiness. *timers:* if still DRAFT at T−2d → exception #1. *failure:* gap reopens
  (drop-off) → back to DRAFT + exception #7. *human:* publish. *next:* PROVISIONED, DRAFT, CANCELLED.
- **PROVISIONED** — *entry:* Connecteam publish `ok` for internal AND/OR gig posted/recorded. *data:*
  `connecteam_shift_id` and/or `instawork_gig_id`. *automated:* build packet (version), queue
  on-assignment comms. *timers:* day-before send at `start−16h`. *failure:* publish fails → stay STAFFED
  + exception #4. *human:* none. *next:* NOTIFIED, CANCELLED.
- **NOTIFIED** — *entry:* every assignment `packet_sent_at != null`. *automated:* await confirms.
  *timers:* refresher at `start−45m`; unconfirmed escalation at `start−12h` → exception #6. *failure:*
  send fails → stay PROVISIONED + exception #5 (retry via outbox). *next:* CONFIRMED, PROVISIONED.
- **CONFIRMED** — *entry:* every assignment `confirmed_at != null`. *next:* READY, NOTIFIED (regression).
- **READY** — *entry:* `computeShiftReadiness == READY` (all five components green). *next:* IN_PROGRESS,
  regress on any component dropping.
- **IN_PROGRESS** — *entry:* a clock-in mirror OR `now ≥ start_time`. *automated:* mirror Connecteam
  clocks; Instawork drop monitor. *timers:* clock-in grace → exception #8. *next:* COMPLETE, EXCEPTION.
- **COMPLETE** — *entry:* `now ≥ end_time` and no blocking exception (and, internal, clock-outs mirrored
  / route closed via existing `closeOneRoute`). *terminal* (reopen is `requiresApproval`).
- **EXCEPTION** — *entry:* a RED exception opens. *exit:* resolve → prior state.
- **CANCELLED** — *entry:* dispatcher cancel (`requiresApproval` if already PROVISIONED+; cancelling a
  published shift enqueues a Connecteam update + notifies). *terminal.*

Shift state is always a **deterministic roll-up** of assignment states (D.5) + the coverage/readiness
calculators — never set by an LLM, never hand-edited past the guards.

## 4. SHIFT READINESS model (measurable, rules-computed)

`computeShiftReadiness(shift, assignments, ctx)` in `src/lib/scheduling/readiness.ts`, modeled on
`risk/readiness.ts` (weighted components, worst-finding deduction, a level that can't be hidden by a
high number). Five components:

| Component | Weight | GREEN when (rule) |
|---|---|---|
| STAFFING | 30 | coverage gap == 0 (internal + booked Instawork ≥ headcount) |
| LOGISTICS | 25 | truck set (if route), `report_time` + `report_location` set, `windowKnown` |
| COMMUNICATION | 15 | every assignment packet `sent` (and, once wired, `delivered`) |
| TIMEKEEPING | 15 | internal: linked to a Connecteam userId on a published shift; Instawork: gig booked (clock is theirs). "linked", not "owned". |
| CONFIRMATION | 15 | every assignment `confirmed_at != null` |

`ready = (gap==0) && logistics_complete && all_sent && timekeeping_linked && all_confirmed`. Any
UNVERIFIED integration leaves its component **UNKNOWN** (not red), with a clear "couldn't verify" note —
never a fabricated deficiency (the `unverified` rule from `readiness.ts`). Output cached in
`staff_shifts.readiness_json`; recomputed each tick (derived, never a source of truth).

## 5. (covered in D.5 — assignment lifecycle)

## 9. SHIFT PACKET model (schema + versioning)

`buildShiftPacket()` in `src/lib/scheduling/packet.ts`, assembled **only from structured data** already
in the DB (route/stop/vehicle/Connecteam/shift) — no LLM to produce facts. Shape:

```ts
interface ShiftPacket {
  shiftId: string; version: string;            // content hash → "what did this worker receive"
  identity: { date: string; role: ShiftRole; eventLabel: string | null };
  reporting: { reportTime: string | null; reportLocation: string | null;   // nulls shown as "TBD", never guessed
               startTime: string | null; endTime: string | null; windowKnown: boolean; mapUrl: string | null };
  assignment: { workerKind: 'internal'|'instawork'; displayName: string;
                truck: { id: string; name: string } | null;
                supervisor: { name: string; phone?: string } | null;
                coworkers: string[] };
  operations: { route?: { stops: number; firstStop?: string };
                equipment: string[];            // from GS line items / crew rules
                instructions: string | null };
  timekeeping: WorkerTimekeeping;               // per worker-type (below)
  dispatch: { phone: string };                  // Zoe main line (301-291-5296) — never the customer's (memory rule)
}

type WorkerTimekeeping =
  | { kind: 'internal'; system: 'connecteam'; howTo: string; connecteamDeepLink?: string }  // Connecteam owns it
  | { kind: 'instawork'; system: 'instawork'; howTo: string }                               // Instawork owns it; Zoe can't clock
```

**Versioning:** `version = hash(packet_json)`. A new row in `shift_packets` is written only when the
hash changes (same dedup discipline as `event_snapshots.sig`). `shift_assignments.packet_version`
records what each worker last received, so "what did this worker get, and is it current?" is a pure
comparison — and a changed packet (e.g. truck swap) deterministically drops affected assignments out of
NOTIFIED/CONFIRMED and queues a re-send.

## 10. COMMUNICATION timeline (reusable template system + reliability states)

- **Three touches, all computed from the shift window (deterministic), not hardcoded copy:**
  (1) **on-assignment** — full packet, fired on reaching PROVISIONED; (2) **day-before** — full packet
  at `start−~16h`; (3) **refresher** — the essentials (report time/place/truck/supervisor) at `start−45m`.
- **Template system:** `src/lib/scheduling/comms/templates.ts` renders each touch from the structured
  `ShiftPacket` via the existing `renderTemplate`/settings pattern (`src/lib/settings.ts` already powers
  the customer SMS templates). Internal → Connecteam notification (publish) + optional Zoe SMS; temp →
  gig text / pass link. House style via `llm.ts` `COMMS_STYLE`/`humanize()` (no dashes/emoji).
- **Comm reliability states (honest, per E.3):** `queued → sent → failed` today; `delivered` and
  `confirmed` (inbound reply) become available once the OpenPhone delivery webhook + reply-match are
  wired. A touch is "done" only at `sent` (v1) / `delivered` (once wired) — a `queued`/`failed` touch
  does not count toward NOTIFIED (§11).

## 11. Idempotency / reliability strategy

- **Duplicate assignment:** `UNIQUE(shift_id, worker_kind, connecteam_user_id, instawork_worker)` — a
  re-assign is a no-op upsert (the existing `assignees` set-union pattern in `AddWorkerPanel` already
  avoids dup userIds; the table enforces it).
- **Duplicate message / contact:** comms go through an outbox with an idempotency key per
  `(assignment, touch, packet_version)`; a touch already `sent` for that version is never re-sent
  (mirrors `insertEventIfNew` + `change_key`).
- **Retries / partial failures:** outbox `attempts`/`last_error`/`ackGsOp` discipline. A partial batch
  (some assignments sent, some failed) leaves the failed ones un-`sent`, so the shift stays below
  NOTIFIED and exception #5 opens — **a failed Quo provision can NEVER let a shift become READY**
  (the readiness rule requires all `sent`/`confirmed`).
- **Instawork timeout ≠ accepted:** `getInstaworkShifts` returns `ok:false`/`not_configured` on a stale
  snapshot; the board + readiness treat it as UNVERIFIED, never "accepted"/"nothing booked" (the
  existing honest-empty rule). A worker only counts as booked when present in a *fresh* snapshot's
  `workers[]`.
- **Webhook replay:** OpenPhone/Connecteam webhooks dedup by `provider_id UNIQUE` (the existing
  `call_events`/`comms_events` pattern) and by `change_key` on the assignment event log.
- **Race conditions:** all shift+assignment mutations run inside `better-sqlite3` transactions (the
  `syncDemand` tx pattern); state transitions re-read and re-validate against the table server-side
  (`resolveTransition`), so two dispatchers can't push conflicting states.
- **State reconciliation:** the runtime tick is the single reconciler — it recomputes derived state from
  the sources of record each run, so a missed webhook self-heals on the next tick (same philosophy as
  the import ledger / health probes).

## 12. Audit trail (immutable operational history)

`shift_assignment_events` (D.3) answers every brief question as an append-only, dedup-by-`change_key`
log, reusing `history/store.ts` discipline: **assigned** (who/when), **accepted/confirmed** (when, by
what method), **received-what** (`packet_version` + `packet_sent_at`), **sent-when** (per touch),
**truck** (logistics change events), **changes** (reassign/replace/window/truck), **confirmed**,
**clock-in/out** (internal mirror, with `clock_source=connecteam`), **exceptions**
(opened/resolved), **who-changed-what** (`actor` = `currentActor` for humans, a named `system` actor for
automated ones — per the action-notifications-attribution memory rule). The shift detail renders this as
a timeline (F.6).

## 13. Data-ownership matrix (no competing sources of truth)

| Field | System of Record | Source | Cached in Zoe? | Mutable by Zoe? | Sync direction | Frequency |
|---|---|---|---|---|---|---|
| Event / booking facts (label, venue, date) | **Goodshuffle** | GS project/route pull | yes (`bookings`/`routes`/`stops`) | no | GS → Zoe | each pull (~10 min / daily) |
| Line items → equipment | **Goodshuffle** | GS items on stops | yes (`stops.items`) | no | GS → Zoe | each pull |
| Route window / stops | **Goodshuffle** (planned) | pull + `routeWindow()` | yes | no (we derive) | GS → Zoe | each pull |
| Internal person identity + role | **Connecteam** | `getUsers` (Title) | link only (`connecteam_user_id`) | no | CT → Zoe | per board load / tick |
| Internal schedule (is on today) | **Connecteam** | `getCrewForDateSafe` | read | via publish | CT → Zoe (read) / Zoe → CT (publish) | per load / on publish |
| Internal published shift | **Connecteam** (after publish) | `createPublishedShift` | `connecteam_shift_id` | yes (create/update) | Zoe → CT | on publish / edit |
| **Internal clock-in/out** | **Connecteam** | `getActualHours` timesheet | read-only mirror (`clock_*`, `clock_source=connecteam`) | **no** | CT → Zoe | each tick |
| Pay rate (internal) | **Connecteam** | `getPayRates` | read | no | CT → Zoe | as needed |
| Instawork gig (booked/pending/workers) | **Instawork** | browser snapshot | yes (snapshot) | no (post = future outbox) | IW → Zoe | each browser pull |
| Instawork worker phone / clock / messaging | **Instawork** | — (NOT captured) | no | no | — (unavailable) | — |
| **Shift demand line** (role/headcount/window) | **Zoe** | `demand.ts` + human | `staff_shifts` | yes | Zoe-owned | on build/edit |
| **Assignment + lifecycle + readiness** | **Zoe** | the engine | `shift_assignments` (+derived) | yes | Zoe-owned | each tick / action |
| **Shift packet + versions** | **Zoe** | `packet.ts` | `shift_packets` | yes | Zoe-owned | on change |
| Worker SMS send/status | **OpenPhone/Quo** | provider | `messages` | send only | Zoe → Quo (+ webhook back once wired) | on send |
| Truck roster | **Zoe/env** | `VEHICLES_JSON` / `vehicles` | yes | yes | Zoe-owned | static |

Rule: where a field has an external SoR, Zoe stores a **link or a read-only mirror** and never a second
writable copy. The only Zoe-owned writable entities are the demand line, the assignment/lifecycle, the
packet, and the send record.

---

## I. Migration strategy (do NOT break existing shift-building)

1. **Additive schema only.** New tables + nullable columns on `staff_shifts` (the DB auto-creates
   schema on import; no destructive migration). Existing `/scheduling` keeps working untouched.
2. **Dual-write / derive both ways.** The engine reads/writes `shift_assignments`, but keeps
   `staff_shifts.assignees` in sync (project assignments→userIds) so the current board/coverage code is
   unchanged. `lifecycle_state` is derived from legacy `status` when null, and vice-versa, so neither
   path breaks.
3. **Backfill on first tick.** For each existing `staff_shift`, create `shift_assignments` from
   `assignees` + any booked Instawork workers, set an initial `lifecycle_state` from `status`
   (`sent`→PROVISIONED, `confirmed`→STAFFED, `draft`→DRAFT, `cancelled`→CANCELLED), compute readiness.
   Idempotent (dedup by the assignment UNIQUE + `change_key`).
4. **Feature-flag the new surfaces.** Readiness badge / exception queue / packet send behind a settings
   flag (the app already has a `settings` KV + `/admin`), so they can ship dark and be enabled per-env.
5. **Comms off by default.** Packet sends start in **record/preview only** (exactly the proven
   `AddWorkerPanel` "wired next" posture) until the OpenPhone delivery webhook and the human-confirm step
   are verified — so no worker is texted before the loop is trusted. Flip on per-env.

## J. Implementation phases (safe, testable)

- **Phase 0 — Foundations (no behavior change).** Add tables + columns; `shift_assignments` store with
  dual-write to `assignees`; backfill job; unit tests mirroring `coverage.test.ts`/`readiness.test.ts`.
- **Phase 1 — Lifecycle + readiness (read-only surfacing).** `lifecycle.ts` (transition table + tests
  like `stateMachine`), `readiness.ts`, the readiness badge + summary card. Pure; no sends. Dispatcher
  sees state + why-not-ready. **Highest value, lowest risk.**
- **Phase 2 — Exception queue.** `exceptions.ts` + the queue UI (reuse `connections.ts` shape) + the
  `shift-lifecycle` runtime job doing recompute + Instawork diff + Connecteam clock mirror + Slack on RED
  (reusing `monitor.ts`/`alertOps`). Still no worker-facing sends.
- **Phase 3 — Packet + internal delivery.** `packet.ts` + versioning + the packet preview; internal
  delivery via the *existing* Connecteam publish, plus an optional internal SMS; confirmation via
  dispatcher-confirm + (if available) a reply match. Audit timeline.
- **Phase 4 — Comms reliability + confirmation loop.** Wire the OpenPhone delivery webhook + inbound
  reply→CONFIRMED; the 3-touch scheduled template system; COMMUNICATION component goes from "sent" to
  "delivered/confirmed."
- **Phase 5 — Instawork write + temp-worker provisioning.** Capture the gig-post request, add
  `instawork_outbox` + extension drainer (mirror `gs_outbox`); push report info into the gig text; a
  Shift-Pass-style packet link for temp workers; honest `unavailable` timekeeping.

Each phase is independently shippable, test-covered, and reversible (additive + flagged).

---

## 17. Risks and unresolved questions

**Risks**
- **Connecteam clock precision.** The captured timesheet is day-grain (`dailyTotalHours`), so a precise
  "clocked in at 7:58" and a tight late-clock-in exception may not be possible without a punch/attendance
  endpoint we haven't verified. v1 TIMEKEEPING should assert "linked + clocked today", not a minute.
- **Instawork is read-only and name-only.** No worker phone, clock codes, or messaging in the captured
  surface, and no captured write. Temp-worker "zero ambiguity at shift start" partly depends on
  Instawork's own app + the gig text until a write/contact capture exists. Over-promising here is the
  biggest honesty risk.
- **Outbound SMS has no delivery/confirm signal yet.** Until the OpenPhone webhook is wired,
  COMMUNICATION can only prove "sent" and CONFIRMED must be explicit (reply or dispatcher) — the engine
  must not quietly treat "sent" as "confirmed."
- **Connecteam publish notification ≠ confirmation.** `notifyUsers=true` pushes, but acknowledgement
  isn't returned; don't equate NOTIFIED with CONFIRMED.
- **Browser-pull dependency.** Readiness/exceptions that depend on the Instawork snapshot inherit its
  staleness; must stay UNVERIFIED (not red/green) when stale.
- **Scope creep vs the event-readiness engine.** Shift readiness and `risk/readiness.ts` are different
  grains (shift/worker vs event); keep them distinct to avoid two competing scores.

**Unresolved questions (need a user decision before implementation)**
1. **Connecteam timekeeping precision:** is there a punch/attendance/time-activities endpoint (or
   webhook) beyond the day-grain timesheet? This decides how sharp TIMEKEEPING + late-clock-in can be.
2. **Instawork worker contact + gig-post write:** is there a sanctioned business API for worker phone /
   messaging / clock, or do we commit to "inform via the gig text + a Shift-Pass link" and capture only
   the gig-post write? This is the single biggest determinant of the temp-worker experience.
3. **Confirmation source of truth:** acceptable to rely on dispatcher-confirm + inbound SMS reply for
   CONFIRMED in v1, or must it be an automated signal from Connecteam/Instawork?
4. **Who sends internal packets:** is the Connecteam published shift sufficient notification for internal
   crew (so Zoe only *adds* report-location/truck/supervisor via an optional SMS), or should every
   internal worker always get a Zoe SMS/link too (cost + double-notification tradeoff)?
5. **Do worker-facing comms go live now or stay preview-only** until Phase 4's reliability loop is
   proven? (Recommend preview-only first, matching the existing "wired next" posture.)

---

## What should be built first, what should wait, and why

**Build first (Phases 0–2): the per-worker entity, the lifecycle + readiness engine, and the exception
queue — all read-only / dispatcher-facing.**

- This is where the brief's core promise ("the dispatcher sees exceptions surfaced rather than hunting
  for them") is delivered, and it is **pure, deterministic, and low-risk**: no new external capability is
  required, nothing is sent to a worker, and it reuses calculators and shapes that already exist and are
  tested (`demand`/`coverage`/`availability`, `readiness`, `connections`, `stateMachine`, the runtime
  job runner, the history store). It turns the flat `status` enum into a real lifecycle and gives the
  board a GREEN/YELLOW/RED readiness signal plus an actionable queue — immediate value with the smallest
  blast radius. The keystone is `shift_assignments`; everything else hangs off it, so it must come first.

**Build next (Phase 3): the shift packet + internal delivery** over the *existing* Connecteam publish —
because internal crew (Connecteam owns them, we can already publish + read timekeeping) is the half we
can provision honestly today, without any new capture.

**Wait (Phases 4–5): worker-facing comms reliability and Instawork write/provisioning.** These depend on
capabilities **not present in the captured surface** — an OpenPhone delivery/reply webhook, and
Instawork worker phone / clock codes / messaging / gig-post write. Shipping "zero ambiguity for the temp
worker" before those are captured would mean either faking a signal (violates the house law) or
over-promising. Capture them first (same discipline as the GS write-backs), then light up the full
confirmation + temp-provisioning loop. Until then, keep temp provisioning record/preview-only and surface
Instawork timekeeping as the honest `unavailable`.

The ordering is deliberately: **make the facts visible and the states real (deterministic, now) →
provision the half we fully control (internal) → earn the worker-facing sends once the APIs are
captured.** That delivers dispatcher value in Phase 1 while never fabricating a capability the code
doesn't yet have.

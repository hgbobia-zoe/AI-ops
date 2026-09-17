# Event Radar — early-demand intelligence

> **Event Radar detects future demand. Sales OS converts that demand into revenue.**
>
> **Design law: RULES CALCULATE. AI INTERPRETS.** Deterministic logic scores and times every
> opportunity; AI is only ever allowed to *interpret* messy inputs (extract fields, summarize), never
> to fabricate a fact or assign a score.

Event Radar is a first-class Tower blade that discovers future events in the DMV that could create
rental demand, identifies the organization/planner behind them, decides how commercially relevant
they are to Zoe, detects recurring events, and hands qualified opportunities to Sales OS *early* —
before the planner is actively shopping vendors.

It answers: **"What events are coming into our market, which ones matter to Zoe, who is behind them,
and which ones should sales act on now?"**

This is Phase 1 (MVP): it proves the intelligence **workflow** end-to-end. It deliberately does **not**
try to solve internet-scale event discovery yet — the ingestion architecture is built correctly so
real sources plug in later without touching anything downstream.

---

## Where it lives (reuses existing Tower architecture)

Nothing new was introduced — Event Radar is built on Tower's existing patterns:

- **DB**: the same `better-sqlite3` singleton and schema block in `src/lib/db/index.ts`.
- **Engine shape**: a pure, deterministic core + a store + a service, exactly like the Event Risk
  engine (`src/lib/risk/*`) and Sales OS (`src/lib/salesos/*`). Scores are **derived at read time**,
  never persisted — same pattern as Sales OS's `LeadView`.
- **UI**: server components under `src/app/(console)/`, the Nocturne primitives in
  `src/components/console-primitives.tsx`, the existing dark "airline-ops" visual language, and the
  `ConsoleNav` blade list.
- **Auth / API**: proxy-gated route handlers with `currentActor()` attribution, like every other
  write in the app.

Nav: added as a **standalone first-class blade** beside Command Center (it is its own module, not a
sub-item of Sales or Operations).

```
TOWER
├── Command Center
├── Event Radar        ← NEW (standalone)
├── Operations (Ops / Dispatch / Event Risk / Staffing / Financial)
├── Sales (Sales / Sales OS / Coaching / Customers)
└── Company (History / Automation)
```

---

## Data model

All tables live in `src/lib/db/index.ts` (prefixed `radar_`). **They store FACTS only** — scores,
tiers, timing and opportunity value are computed deterministically at read time and are never written
back, so they can never go stale and are always explainable.

| Table | Purpose |
|---|---|
| `radar_sources` | The source registry (venue calendars, convention centers, hotels, universities, associations, government, nonprofits, directories, public web, search). `adapter` = which ingestion adapter is wired (`null` = stub, not yet implemented). |
| `radar_organizations` | The org behind an event, with `verification_status` (VERIFIED / INFERRED / UNKNOWN). |
| `radar_series` | A recurring event series (e.g. "CHD Conference"), with cadence + recurrence confidence. |
| `radar_events` | A detected event. `dedupe_key` is the stable identity (re-pulls update in place). `attributes_json` holds rental-signal facts as `{signal: PRESENT\|ABSENT\|UNKNOWN}`. Carries provenance (`verification_status`, `attendance_confidence`, `planner_status`) and `is_seed`. |
| `radar_planners` | A planner / contact at the org or event grain. A row exists **only** when a real name is known — never invented. `contact_status` separates verified from inferred. |
| `radar_opportunities` | The Sales OS handoff bridge (one per event). The event stays the source record; this links to a real Goodshuffle `booking_id` once one materializes. |

The `Event` fields requested in the brief map directly onto `radar_events` + the derived view
(`rentalFitScore`, `commercialOpportunityScore`, `outreachPriority`, `estimatedOpportunityValue` are
all **derived**, see below).

**Geography** is modelled for expansion in `src/lib/radar/geo.ts`: each region is a named area with the
city/keyword patterns that map to it. Adding a market later = one entry. Initial areas: Washington DC,
Montgomery County MD, Prince George's County MD, Northern Virginia, Baltimore, Howard County MD.

---

## Ingestion architecture

`src/lib/radar/ingest.ts` defines the pluggable pipeline. Each stage is independently replaceable:

```
EventSource.discover() → normalize() → deduplicate() → verify() → store()
```

- **`EventSource`** is a tiny interface: `id, name, kind, region, adapter, discover()`. `discover()`
  returns loose `RawEventRecord`s.
- **normalize()** maps free-form category text to a canonical `EventCategory`, computes the
  `dedupe_key`, and classifies the region.
- **deduplicate()** collapses records by `dedupe_key` within a batch; the store upserts by the same key
  across runs, so a re-pull never duplicates.
- **verify()** is a pass-through hook in the MVP (records keep their source-declared
  `verificationStatus`); a real implementation re-fetches and promotes `NOT_YET_VERIFIED → VERIFIED`.
- **store()** upserts org → series → event → planners.

**Scoring is NOT done here** — it's derived at read time (see below), so ingestion stays a pure
data-plane concern.

### How a future source gets added

1. Implement an `EventSource` whose `discover()` fetches + parses that source (a venue calendar, a
   directory, a search result page — AI may *interpret* a messy page here, but must not fabricate).
2. Register it in `radar_sources` with a real `adapter` key.
3. Call `runSource(mySource)` from the pull path (e.g. the office bookmarklet / a scheduled job).

Nothing downstream changes — normalization, dedup, storage, scoring, timing and the UI all keep
working. The `SOURCE_STUBS` in `src/lib/radar/seed.ts` show six real DMV sources pre-registered as
disabled stubs (adapter = null) ready to be wired.

---

## Qualification engine (deterministic)

`src/lib/radar/qualify.ts` is **pure** — given an event's facts + `RadarConfig`, it returns a 0–100
rental-fit score, a commercial-opportunity score, a tier, and a **transparent explanation**. No AI, no
DB, no network. The whole point is that a manager can read *why* an event scored the way it did, and
the same facts always produce the same score.

**Weights and thresholds are all configurable** in `src/lib/radar/config.ts` (never hard-coded in the
UI or engine body). Signals:

- **Positive**: category relevance, attendance band, multi-day, recurring, in-service-area, and the
  present rental attributes (reception, exhibitors, networking, gala, outdoor, hospitality, VIP,
  sponsor activation).
- **Negative**: fully virtual, out of service area, very small known attendance.
- **Unknown**: any signal we don't have evidence for is listed as `?` and contributes **0 points** —
  it is never treated as "absent".

The **commercial-opportunity score** is the rental fit tempered by how much we actually *know* (each
unknown shaves confidence), so a high-fit-but-unverified event ranks below an equally-fit fully-verified
one. It never exceeds rental fit.

**Opportunity tiers** are deterministic categories from the score (`HIGH ≥ 70`, `MEDIUM ≥ 45`,
`LOW ≥ 20`, else `UNQUALIFIED`) — thresholds configurable. They are qualification categories based on
documented signals, **not** revenue predictions.

**Estimated value** is a coarse *indicative* rental-spend range (attendance × per-attendee rate by
category), shown **only** when attendance is known and in-area, and clearly labelled indicative — never
a revenue prediction, `null` when we can't responsibly estimate.

---

## Recurrence engine (deterministic)

`src/lib/radar/recurrence.ts` derives, from the historical instances we actually hold:

- **confidence**: HIGH (≥3 years, consistent gap) / MEDIUM (2 years) / LOW.
- **predictedNext**: a **PREDICTED / UNANNOUNCED** next occurrence — **only** when the most recent
  known instance has already passed and none is announced. If a future instance already exists, we
  point at the real one and predict nothing. A predicted year is always labelled and carries its
  supporting evidence; **no future event is ever fabricated**.

---

## Timing engine (deterministic)

`src/lib/radar/timing.ts` answers "when should Zoe engage?" from the event date, size, category and
recurrence — **not** from a procurement deadline we don't have. Phases: `TOO_EARLY → PLANNING_WINDOW →
OUTREACH_WINDOW → ACTIVELY_SHOPPING → IMMINENT → PAST` (windows configurable). Every recommendation
carries `inferredFromDateOnly` = true in the MVP, so the UI is honest that it rests on the calendar,
not a verified deadline.

---

## Sales OS integration (the handoff)

`POST /api/radar/opportunity` → `createOpportunity(eventId)`:

```
Event discovered → qualified → (planner identified) → CREATE SALES OPPORTUNITY → Sales OS
```

Creating an opportunity **does not duplicate the event** — the `radar_event` stays the source record.
It writes the `radar_opportunities` bridge, advances the event to `HANDED_OFF`, and links to a real
Goodshuffle `booking_id` once the client actually enters the pipeline (until then it stands alone as an
*early* opportunity awaiting a real quote). The detail page and dashboard then deep-link into Sales OS.

This is honest by construction: Sales OS today is built on the `bookings` table (real Goodshuffle
projects). An Event Radar signal is *pre-pipeline* demand, so the bridge record is the correct MVP
handoff — it becomes a linked booking only when a real one exists.

---

## Screens

- **`/radar`** — dashboard: operational figures (New 7d, High-fit, Planners ID'd, Entering outreach,
  Recurring, Opportunities) + a ranked events table (Event / Date / Venue / Fit / Planner / Timing /
  Next action). Filters (tier chips, search, category, area, verification) are plain GET params so the
  page stays a server component.
- **`/radar/[id]`** — event intelligence detail: Event facts (with provenance), **Why this matters**
  (the transparent score breakdown), Rental signals, Organization, Planner intelligence, Recurrence
  (incl. any predicted/unannounced next), Timing, Sales handoff, and a Timeline.

---

## What is real vs seeded

- **Real, working now**: the entire workflow — the data model, ingestion pipeline, qualification /
  recurrence / timing engines, the Sales OS handoff, and both screens. All deterministic logic is
  production code with unit tests.
- **Seeded (DEMO)**: the *events themselves*. There is no live external event source connected yet, so
  `src/lib/radar/seed.ts` provides a small, realistic DMV dataset run through the **real** pipeline
  (discover → normalize → dedup → verify → store). Every seeded row is `is_seed = 1` and badged
  **SEED** everywhere in the UI, and the dashboard shows a banner — it can never be mistaken for
  verified production data. All names/contacts in the seed are plainly fictional (`example-demo.org`).

The seed loads automatically when Event Radar is empty (idempotent, upserts by `dedupe_key`).
Settings-managers can reload it with the "Reload demo data" button (`POST /api/radar/seed`).

---

## Honesty guarantees (never fabricates)

- No invented planners — if none is known, planner = **UNKNOWN** and the action is **"research
  organizer"**.
- No invented attendance, dates, contacts, recurrence or rental requirements — absent = **UNKNOWN**.
- No unexplained scores — every point traces to a documented signal.
- Nothing is claimed "verified" unless the source is.
- Every fact shows its provenance: **VERIFIED / INFERRED / UNKNOWN / NOT YET VERIFIED**.

---

## Files

**Engine / data (`src/lib/radar/`)**: `types.ts`, `config.ts`, `geo.ts`, `qualify.ts`,
`recurrence.ts`, `timing.ts`, `store.ts`, `service.ts`, `ingest.ts`, `seed.ts` (+ `*.test.ts`).
**Schema**: `radar_*` tables in `src/lib/db/index.ts`.
**UI**: `src/app/(console)/radar/page.tsx`, `src/app/(console)/radar/[id]/page.tsx`,
`src/components/radar-badges.tsx`, `RadarOpportunityButton.tsx`, `RadarSeedButton.tsx`, nav entry in
`ConsoleNav.tsx`.
**API**: `src/app/api/radar/opportunity/route.ts`, `src/app/api/radar/seed/route.ts`.

---

## Phase 2 (what remains)

1. **Real ingestion adapters** for the registered source stubs (convention-center + hotel group
   calendars, university/association/nonprofit sites, a directory, and an AI page-extractor for
   search-discovered pages) — each an `EventSource`, wired into the office pull path.
2. **A real `verify()`** that re-fetches and promotes `NOT_YET_VERIFIED → VERIFIED/INFERRED`.
3. **Planner enrichment** (an AI-assisted "research organizer" that proposes, never asserts, a
   contact — always landing as INFERRED with evidence for a human to confirm).
4. **Deeper Sales OS linkage**: auto-match a radar event to an inbound Goodshuffle lead by
   org/venue/date to flip an opportunity `CREATED → LINKED` automatically.
5. **Config from settings** so Zoe can tune weights/thresholds without a deploy.
6. **Outreach drafting** (AI interprets; a human sends) reusing the Sales OS outreach path.
7. **Alerting** when a HIGH-fit event enters the outreach window (reuse the Slack fanout).

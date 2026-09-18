# Opportunity Radar — opportunity intelligence engine

> Event Radar, broadened into an early-warning system that finds revenue opportunities for Zoe before
> competitors — across **events, government procurement, and facility/construction signals** — figures
> out **who to contact**, and hands qualified opportunities to Sales OS.
>
> **Design law: RULES CALCULATE. AI INTERPRETS.** All scoring, timing, jurisdiction, dedup and
> lifecycle are deterministic; AI is reserved for interpretation and never fabricates or scores.

This is **Phase 1 (the shell)**: the unified intelligence layer, the connector architecture, the
scoring/timing/lifecycle engines, the relationship graph, relationship memory, and the reframed UI —
all working, validated with SEED data. Live feeds are wired but **dormant** until configured (no keys
required to run).

---

## The one idea: a unified opportunity spine

Events and procurement are **not** two systems. Every discovery — an event, a solicitation, a facility
signal — normalizes into one row in the **`opportunities`** table. Domain-specific raw facts live in
satellites (`radar_events` for events, `radar_procurements` for solicitations). Scores, signal
maturity, lifecycle stage, the recommended target and relationship memory are **derived at read time**
(never stored → never stale, always explainable).

```
Source → acquire() → normalize → classify → deduplicate → detect-change → store (opportunities)
                                                                              ↓ derived at read time
                              score (§12) · maturity (§5) · lifecycle (§6) · who-to-contact · relationship memory
```

## What was reused (this is an extension, not a rewrite)

- The Event Radar module (`radar_events`, `geo`, provenance, `radar-badges`, the `/radar` route) —
  events now **bridge** into the spine (`eventBridge.ts`).
- The discovery-pipeline shape and the transparent `ScoreSignal` explanation model.
- **`aggregateCustomers` + `outcomeOf`** for relationship memory (§17) — no new customer store.
- The **Goodshuffle Auto-Pull pattern** (CORS-locked, token-gated ingest) for the browser agent.
- `console-primitives`, the Nocturne dark UI, and the nav (relabelled **Opportunity Radar**).

## Data model (all additive; `src/lib/db/index.ts`)

| Table | Role |
|---|---|
| `opportunities` | The unified Opportunity Intelligence Record (§4). `kind` = EVENT / PROCUREMENT / FACILITY_SIGNAL / WEB_SIGNAL; `dedupe_key` is the stable identity; links to satellites via `event_id` / `procurement_id`; carries jurisdiction, dates, deadline, stage, sales handoff, `is_seed`. |
| `radar_procurements` | Solicitation/award facts (notice type, agency, NAICS/PSC, deadline, award). |
| `radar_entities` | Relationship-graph nodes: companies/agencies/contacts (§8). `matched_customer_key` links to Zoe history. |
| `opportunity_entities` | Graph edges: which entity plays which **role** on an opportunity, and the recommended **primary target** (§7). |
| `radar_campaigns` | Named opportunity groupings (§11); membership via `opportunities.campaign_id`. |
| `radar_sources` (extended) | Source registry (§14): `acquisition_method`, `auth_status`, `frequency`, `parser_version`, `records_discovered`, `last_failure_at`. |
| `history_changes` (reused) | Change detection log (§16) — new deadlines, status changes, awards. |

## Scoring (`score.ts`, deterministic + transparent — §12)

Relevance (0–100) from configurable weights (`config.ts`): in-service-area, government involvement,
size band, Zoe-category fit (per matched category, capped), known contractor / planner / **existing
Zoe relationship**, actionable deadline; negatives for out-of-area, expired deadline, fully virtual.
Unknowns count 0 and are shown as `?`. **Opportunity score** = relevance tempered by detection
confidence + how much is known (never exceeds relevance). Tiers HIGH/MEDIUM/LOW/UNQUALIFIED. Every
point is explained on the detail page.

## Timing (`maturity.ts` — §5) & Lifecycle (`lifecycle.ts` — §6)

- **Maturity** ladder from the nearer of event date / deadline: EARLY_SIGNAL → PLANNING →
  PROCUREMENT_WINDOW → OPERATIONALLY_ACTIVE → IMMEDIATE (windows configurable), honestly flagged
  "inferred from date only" when there's no verified procurement deadline.
- **Lifecycle**: DISCOVERED → VALIDATED → RELEVANT → RESEARCHING → TARGET_IDENTIFIED → OUTREACH_READY →
  CONTACTED → ENGAGED → OPPORTUNITY → QUOTED → WON/LOST. Auto-advances up to OUTREACH_READY from facts;
  a human manual override wins (same pattern as Sales OS `lead_status`).

## Who to contact (§7/§8) & Relationship memory (§17)

The entity graph classifies each company's **role**; the primary-target picker prefers the commercial
path (event-mgmt / planner / prime) over the government buyer. If an entity matches Zoe's existing
customer/quote history (by the reused email→name identity key), the detail page surfaces it —
"3 bookings, $X won, last quote lost → win-back" — instead of a cold contact.

## Connector architecture (§2/§14/§15)

`OpportunitySource` = `{ id, acquisitionMethod: API | BROWSER | MANUAL, adapter, acquire() }`. Adding a
portal = a registry row + an adapter; nothing downstream changes.

- **API** — `sources/samgov.ts` (federal solicitations). **Dormant** until `SAM_API_KEY` is set
  (acquire → [] with no key; never throws). Free key: sam.gov → Account Details → API Key.
- **BROWSER** — portals with no API are pulled by the **local browser agent**, which runs a defined
  per-source **workflow** (`sources/browser.ts`: search terms + geographic filters — no blind crawl),
  extracts rows, and POSTs them to **`POST /api/radar/ingest`** (CORS-locked, token-gated by
  `RADAR_INGEST_TOKEN`, fail-open until set). One worked example: **Montgomery County**. eMMA /
  Rockville / Gaithersburg / DC are registered as disabled stubs for Phase 2.
- **MANUAL** — human upload to the same endpoint.

### Adding a source later
1. Implement an `OpportunitySource` (API client, or a browser workflow in `BROWSER_WORKFLOWS`).
2. Register it in `radar_sources` (see `seed.ts:registerSources`).
3. Call `runOpportunitySource(...)` from the pull path (or POST to `/api/radar/ingest`). Normalization,
   dedup, change detection, scoring and the UI all work unchanged.

## Change detection & alerts (§16/§18)

A re-pull that changes a watched field (deadline, status) or adds an **awardee** appends an idempotent
`history_changes` row (shown on the detail page). Alert wiring reuses `slackNotifyAlert` + the
`alertOps` throttle-map so only meaningful signals fire (kept minimal in Phase 1).

## UI

- **`/radar`** — dashboard with the four lanes (§13): Outreach Ready / New Signals / Early Signals /
  Active, metrics, and filters (type, jurisdiction, score, search). Each row shows WHY, WHO, and the
  next action.
- **`/radar/[id]`** — opportunity intelligence: Why-it-matters score breakdown, Who-to-contact (graph +
  primary target + relationship memory), Timing, Lifecycle progress, Change history, Sales OS handoff.
- **`/radar/events/[id]`** — the full event detail (recurrence, planners) for EVENT-kind opportunities.
- **`/radar/sources`** — the source registry + browser-agent workflow definitions.

## Real vs seeded

- **Real**: the whole engine — spine, satellites, pipeline, scoring/maturity/lifecycle, entity graph,
  relationship memory, change detection, the SAM.gov adapter, the browser-agent ingest endpoint + the
  Montgomery workflow, and all four screens. Deterministic logic is unit-tested.
- **Seeded**: the *opportunities themselves* — a small realistic DMV procurement/facility set + the
  bridged Event Radar events, all `is_seed=1`, badged **SEED**, run through the real pipeline. Live
  feeds are dormant until configured.

## Configuration (all optional)

| Env | Effect |
|---|---|
| `SAM_API_KEY` | Activates the live SAM.gov federal feed (dormant without it). |
| `RADAR_INGEST_TOKEN` | Locks the browser-agent ingest endpoint (fail-open until set). |
| `SLACK_ALERT_WEBHOOK_URL` / `alerts.slackWebhook` | Opportunity alerts (reuses the existing alerts channel). |

## Roadmap (§20)
**P1 Foundation (this).** P2 more procurement browser connectors + richer change alerts. P3 deeper
signal fusion (event + procurement + web → one high-confidence opportunity) + AI interpretation. P4
richer entity/relationship intelligence. P5 outreach drafting + campaigns wired to Sales OS sending.
P6 analytics (opportunity → revenue).

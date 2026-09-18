# Opportunity Radar — opportunity intelligence engine

> Event Radar, broadened into an early-warning system that finds revenue opportunities for Zoe before
> competitors — across **events, government procurement, and facility/construction signals** — figures
> out **who to contact**, and hands qualified opportunities to Sales OS.
>
> **Design law: RULES CALCULATE. AI INTERPRETS.** All scoring, timing, jurisdiction, dedup and
> lifecycle are deterministic; AI is reserved for interpretation and never fabricates or scores.

The unified intelligence layer, the connector architecture, the scoring/timing/lifecycle engines, the
relationship graph, relationship memory, **signal fusion, AI interpretation, meaningful-only alerts,
outreach drafting, campaigns and analytics** are all built and working, validated with SEED data. Live
feeds (SAM.gov, the browser agent, Slack alerts, the LLM) are wired but **dormant** until configured —
no keys required to run.

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

### Feeding REAL data (start here)
Three ways, in order of setup cost:
1. **Manual import** (`/radar/import`) — paste a CSV (from a spreadsheet, an Apify export, or your own
   research) and it lands as REAL opportunities (`is_seed=0`), scored and ready. Only `name` is
   required; add `contact_name`/`contact_email` to prospect immediately, and `attendance` to raise the
   size score. No key or scraper. A ready-made DMV starter CSV ships with the go-live runbook.
2. **SAM.gov** — set `SAM_API_KEY`, then **Run now** on `/radar/sources` (or it pulls on refresh).
   Real federal solicitations, server-side.
3. **Browser-agent portals** — the local extension runs a workflow and POSTs to `/api/radar/ingest`.

### Adding a source later
1. Implement an `OpportunitySource` (API client, or a browser workflow in `BROWSER_WORKFLOWS`).
2. Register it in `radar_sources` (see `seed.ts:registerSources`).
3. Call `runOpportunitySource(...)` from the pull path (or POST to `/api/radar/ingest`). Normalization,
   dedup, change detection, scoring and the UI all work unchanged.

## Change detection & alerts (§16/§18)

A re-pull that changes a watched field (deadline, status) or adds an **awardee** appends an idempotent
`history_changes` row (shown on the detail page). Alert wiring reuses `slackNotifyAlert` + the
`alertOps` throttle-map so only meaningful signals fire (kept minimal in Phase 1).

## Intelligence layers (Phases 2–6, built)

- **Signal fusion (§9, `fusion.ts`)** — deterministic detection of RELATED opportunities (same
  jurisdiction + shared contact / similar name / same organizer within a date window) so an event, a
  procurement and a web signal about one real opportunity surface together. Shown on the detail page.
- **AI interpretation (§3, `interpret.ts`)** — a plain-language summary, why it's relevant, and concrete
  research actions. Deterministic template floor always; the LLM only refines it, cached in
  `opportunity_ai`, labelled `method: llm | template`. Dormant (template-only) without `ANTHROPIC_API_KEY`.
- **Meaningful-only alerts (§18, `alerts.ts`)** — new high-value opportunity, new contractor/awardee,
  opportunity change, and existing-relationship signals. Idempotent per (opportunity, kind) via
  `opportunity_alerts`; posts to the alerts Slack channel when configured, records the dedup key either
  way so a later webhook never blasts the backlog.
- **Outreach (§10, `outreach.ts` + `opportunity_outreach`)** — DETECT → DRAFT → APPROVE → SEND → TRACK.
  Deterministic email + call script + follow-up cadence in the house voice, optional LLM refine; a human
  edits/approves; recording a send advances the opportunity to CONTACTED. Nothing sends automatically.
- **Entity/relationship intelligence (§8, `/radar/companies`, `/radar/entities/[id]`)** — every company
  across opportunities, its role on each, and its existing Zoe relationship (matched at ingest).
- **Campaigns (§11, `campaigns.ts`)** — named groupings with deterministic target criteria (auto-match),
  and derived metrics (opportunities, companies, contacted, conversion, indicative value).
- **Analytics (§19, `analytics.ts`, `/radar/analytics`)** — the signal→revenue funnel + breakdowns by
  source, jurisdiction and type. Pipeline figure is an indicative range sum, never booked revenue.

## Prospecting — cold outreach BEFORE Goodshuffle

Goodshuffle is reserved for **conversion**. A qualified, enriched opportunity is routed into a
**prospecting motion** (the SDR/BDR cadence model), and only reaches Goodshuffle once a prospect
responds. Everything is deterministic except the email/call copy (which the AI drafts).

- **Tiering** (`prospecting/tiering.ts`, config-driven) by the opportunity score already computed:
  **Tier A = call-first** (high score / already-awarded / existing Zoe relationship — a human beats a
  blast on big-ticket local B2B); **Tier B = email sequence** (qualified volume, from a separate warmed
  domain); **Tier C = monitor** (below the bar).
- **Cadences** (`prospecting/cadences.ts`) — multi-touch, multi-channel, ~2 weeks, ending in a breakup.
  Tier A is a 7-touch call/email/LinkedIn cadence; Tier B is email-led with one call. Enrolling
  materializes dated **tasks** into the rep worklist.
- **Enrichment** (`prospecting/enrich.ts`) — when the target company has no contact email, **Apify**
  finds one (dormant until `APIFY_TOKEN`; never fabricates an email). We target the **prime / event-
  management company, not the government buyer**.
- **Worklist** (`/radar/outreach`) — "what to do today": call tasks with a script, email tasks with the
  copy, one-click outcome logging. A **reply/meeting pauses the sequence** and moves the opportunity to
  ENGAGED for a human to convert in Goodshuffle.
- **Cold-email sequencer** (`prospecting/sequencer.ts`) — Tier B email steps **export to CSV** (imports
  into Instantly / Smartlead / Apollo / lemlist) and **push via API** when configured. We never send
  from here — the sequencer owns sending, warmup, throttling and unsubscribe.
- **Hygiene** — a do-not-contact **suppression list** (email/domain/company) and a CAN-SPAM footer
  (physical identity + opt-out) on cold emails.

## Lead intelligence on the detail page

Each opportunity leads with a **Lead intelligence** block: the source (with an **Open original** link),
the **awarding office / buyer**, whether it is **Open or Awarded** (with awardee, award amount and date),
and the procurement facts (solicitation number, notice type, posted date, response deadline, NAICS/PSC,
set-aside). When awarded, it flags the awardee as the likely partner to approach.

## UI

- **`/radar`** — dashboard with the four lanes (§13) + metrics + filters, and the in-page tab bar.
- **`/radar/[id]`** — opportunity intelligence: Lead intelligence (source/award/procurement), AI
  interpretation, Why-it-matters, Who-to-contact (graph + primary target + relationship memory), Timing,
  Lifecycle, Change history, Outreach, Related signals, Sales OS handoff.
- **`/radar/companies`** + **`/radar/entities/[id]`** — the relationship graph.
- **`/radar/campaigns`** + **`/radar/campaigns/[id]`** — campaigns + metrics.
- **`/radar/analytics`** — the funnel + breakdowns.
- **`/radar/events/[id]`** — full event detail (recurrence, planners) for EVENT-kind opportunities.
- **`/radar/sources`** — source registry + browser-agent workflow definitions.

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
| `ANTHROPIC_API_KEY` (or `LLM_BASE_URL`) | Turns on AI interpretation + outreach refinement; template-only fallback otherwise. |
| `APIFY_TOKEN` (+ `APIFY_CONTACT_ACTOR`) | Contact enrichment for prospecting (find a missing email). Dormant otherwise. |
| `SEQUENCER_API_KEY` (+ `SEQUENCER_PROVIDER` = instantly\|smartlead, `SEQUENCER_CAMPAIGN_ID`) | Push Tier-B email steps to the cold-email tool. CSV export works without it. |
| `ZOE_MAILING_ADDRESS` | Physical address for the CAN-SPAM footer on cold emails. |

## Roadmap (§20) — status
**P1 Foundation ✅. P2 connectors + alerts ✅** (Montgomery + eMMA/Rockville/Gaithersburg/DC browser
workflows; meaningful-only Slack alerts). **P3 fusion + AI interpretation ✅. P4 entity/relationship
intelligence ✅. P5 outreach + campaigns ✅** (drafting + approval; actual email transport to a
discovered contact — vs. an existing Goodshuffle booking — remains a deliberate manual/record step).
**P6 analytics ✅** (funnel + breakdowns). Next: real per-portal browser parsers, live SAM.gov/LLM
enablement, and closing the loop from a sent outreach to a booked Goodshuffle project for true
opportunity→revenue attribution.

# Opportunity Radar: Phase 0 audit and plan (2026-11-07)

Source of truth: the code on `main` (8c7b433), the production database (read only), Fly secret NAMES, and
read-only requests against https://zoe-dispatch.fly.dev. No secret values were read or recorded.

## 1. Where it really stands

**Production data (read only query, 2026-11-07):**

| Table | Rows | Notes |
|---|---|---|
| `opportunities` | 61 | 38 from one CSV import on 2026-09-18, 23 demo (`is_seed=1`). Nothing new since 2026-09-18. |
| `radar_events` | 17 | all demo |
| `radar_procurements` | 5 | all demo |
| `radar_entities` | 48 | 40 agencies from the import, 12 demo |
| `radar_campaigns`, `prospect_enrollments`, `prospect_tasks`, `prospect_suppression`, `opportunity_outreach` | 0 | never used |
| import ledger | none | no Radar discovery has ever run in production |

**Production config:** `SAM_API_KEY`, `RADAR_INGEST_TOKEN`, `RADAR_ICS_FEEDS`, `SEQUENCER_*`, `APIFY_TOKEN`,
`GS_INGEST_TOKEN`, `WIRE_WEBHOOK_TOKEN`, `COMMS_INGEST_TOKEN` are NOT set. Login (`APP_SESSION_TOKEN`),
`INTAKE_TOKEN`, `SLACK_SIGNING_SECRET`, `OPENPHONE_WEBHOOK_SECRET`, `RUNTIME_TOKEN`, `SEO_INGEST_TOKEN` are set.

**"Smartly"** is the Smartlead option of the cold email bridge (`src/lib/prospecting/sequencer.ts`). It has never
been active because no `SEQUENCER_*` variable was ever set, and it has defects that would make it fail even
when set (section 4).

## 2. Feature inventory

Status key: **W** working and production verified, **I** implemented not production verified, **P** partial,
**B** broken, **M** missing, **X** blocked by an external dependency.

| Capability | Status | Evidence / gap |
|---|---|---|
| Scoring, tiers, timing, lanes, recurrence prediction (pure engines) | I | Unit tested; only ever run on demo + imported rows |
| CSV import | W | 38 real rows in prod |
| SAM.gov federal feed | X → fixed in code, X on key | No key in prod. Old code: one query, no pagination, undocumented `q` param, read a URL as text, swallowed errors, ran on every page load (would burn a 10 calls/day key in minutes) |
| ICS event calendars | X | Works in tests; needs `RADAR_ICS_FEEDS` (public .ics URLs) |
| Browser portal capture (Montgomery, eMMA, Rockville, Gaithersburg, DC OCP) | P | Manual "capture this page" in the extension, heuristic table scrape |
| Venue / university / directory sources | M | Registered with `adapter=null` |
| Scheduler for discovery | M → fixed | Nothing called `/api/radar/cron` |
| Dedupe | P | Per source only; cross source "related" is a suggestion, no merge |
| Outreach plan, bid package | I | State lives in `settings` blobs, never feeds the stage or analytics |
| Prospecting tiers, cadences, enrollment, worklist | I | Code works; 0 rows in prod |
| Cold email send | M | App never sends; CSV export or dormant sequencer push |
| Sequencer push (Smartlead / Instantly) | B + X | See section 4 |
| Reply, bounce, unsubscribe ingestion | M | Only a human clicking "Replied" |
| Suppression list | P | Enforced at enroll/export, no UI, Radar only |
| One communication owner across Radar and Sales OS | M | Both can contact the same person |
| Radar → Goodshuffle project | M | "Convert to Goodshuffle" only flips a status; `booking_id` never set |
| Revenue attribution by source | M | Nowhere joins a source to a booking to revenue |
| Analytics | P → fixed for demo | Demo rows were counted; no revenue |
| Demo data hygiene | B → fixed | Demo procurement rows were injected into prod whenever no non-event rows existed |
| Radar endpoint auth | B → fixed | All fail open, accept `?token=`, reflect any CORS origin |
| Money redaction on Radar for Members | M | Dollar estimates shown to every role |
| Marketing role on prospecting APIs | B | Page allowed, `/api/prospecting` blocked by the proxy |

## 3. Lifecycle trace (discovery → revenue)

1. Discover: `samgov.ts`, `ics.ts`, `browser.ts` via `/api/radar/ingest`, `import.ts`. **Now scheduled** by job `opportunity-radar`.
2. Normalize + dedupe + store: `opportunity/ingest.ts:runOpportunitySource`, `radar/ingest.ts:runSource` → `eventBridge.ts`.
3. Score / tier / timing / lane: derived at read time, `opportunity/service.ts:viewFor`, `laneOf`.
4. Outreach plan / bid package: `outreachPlan.ts`, `pursuit/bidPackage.ts` (settings blobs).
5. Campaign: `campaigns.ts` (manual + criteria match).
6. Enroll + tasks: `prospecting/service.ts:enroll`. **Send: MISSING** (human or CSV).
7. Reply: **MISSING** (human click).
8. Goodshuffle project: **MISSING** (`createHandoff` flips `sales_status` only).
9. Booked revenue: **MISSING** (manual WON stage, no amount, no booking link).

## 4. Sequencer ("Smartly") defects

1. Provider defaults to Instantly; a Smartlead key without `SEQUENCER_PROVIDER=smartlead` calls Instantly and 401s.
2. No `SEQUENCER_CAMPAIGN_ID` guard (`/campaigns/undefined/leads`).
3. A failed push is swallowed and the tasks are still marked exported, so they are never retried.
4. Instantly path targets the deprecated v1 API.
5. Only email/first name/company are pushed; the drafted copy and compliance footer never reach the tool.
6. Each cadence STEP is exported as a row; a sequencer owns its own steps, so leads get re-added.
7. Internal coaching notes ("(Intro email: Concise, references the event...)") are appended to the email body.
8. Mailing address footer defaults to "Washington DC / Maryland / Virginia", not a postal address (CAN-SPAM).

## 5. Security findings (whole app, not only Radar)

Login is enforced, so app pages and session APIs are protected. Machine endpoints are the problem:

| Severity | Finding | Fix path |
|---|---|---|
| Critical | `GS_INGEST_TOKEN` unset → `/api/gs/{projects,notes,emails,outbox,intake-result}`, `/api/route/{import,prune}`, `/api/instawork/import`, Gusto result endpoints, `/api/etalink`, `/api/pull/heartbeat` accept anyone. Verified: `GET /api/gs/outbox` answers 200 with no token (lists queued Goodshuffle writes incl. customer names/phones when non-empty; POST can ack or claim them). `POST /api/gs/projects` can overwrite bookings. | The Auto-Pull extension sends no token today, so setting the secret would break it. Needs an extension release that carries the token, then the secret, then fail-closed code. **Needs owner approval.** |
| High | `WIRE_WEBHOOK_TOKEN` unset → fake "wire sent / received" posts to the payroll channel | Zapier header via an "API by Zapier" connection, then the secret. **Needs owner approval.** |
| High | Radar endpoints fail open, `?token=` accepted, CORS reflects any origin | **Fixed in this branch** (fail closed, header only, extension origin only, record cap) |
| Medium | No token compare is constant time | `src/lib/auth/machineToken.ts` added; migrate the other routes to it |
| Medium | OpenPhone webhook has no timestamp freshness check (replay) | add a ±5 min window |
| Medium | `GS_INGEST_TOKEN` is embedded in the office bookmarklet that runs inside pro.goodshuffle.com | move to the extension background script |
| Low | `/api/salesos/reanalyze-batch`, `/api/dispatch/route-health`, `/api/dispatch/close-past-routes`, `/api/instawork/contacts` are not in the proxy PUBLIC list, so their machine callers get 401 (the nightly reanalyze Action is broken) | add to PUBLIC behind their tokens |

## 6. Reuse map

- Scheduling: `src/lib/runtime/jobs.ts` (`RUNTIME_JOBS`, in-process 15 min clock, import ledger, `/automation`, `/admin`).
- Approvals: `ai_approvals` (`src/lib/aiorg/approvals.ts`), extend with a "push to sequencer" plan kind.
- Agent: `event-radar` already in the AI Org registry (marketing, `backing: "seed"`); Slack persona Data Bot.
- Secrets: `secrets` table + write-only provider route pattern (`/api/instawork/provider`) for SAM / sequencer keys.
- Goodshuffle create: the existing `create_project` outbox op used by web intake.
- Comms: Sales OS SMS/email senders, OpenPhone webhook, `comms_events`.

## 7. Plan (priority = revenue impact x risk)

| # | Work | Depends on | Approval |
|---|---|---|---|
| 1 | Radar endpoints fail closed, shared constant-time token helper | none | done in this branch |
| 2 | SAM.gov connector: per state, incremental, quota aware, errors surfaced | none | done in this branch |
| 3 | Discovery on the runtime clock (`opportunity-radar` job), off page loads | 2 | done in this branch |
| 4 | Demo data: never injected into real data, excluded from analytics | none | done in this branch |
| 5 | Owner gets a SAM.gov API key and adds `SAM_API_KEY` | owner | owner action |
| 6 | Event calendar list for `RADAR_ICS_FEEDS` (verified public .ics feeds) | research | owner OK on the list |
| 7 | GS ingest token rollout: extension sends token → set secret → fail closed | extension release | **owner approval** |
| 8 | Sequencer fixes (section 4) + Smartlead as a settings secret + approval card before push | 7 not needed | owner provides Smartlead key + campaign |
| 9 | One contact owner + shared suppression across Radar and Sales OS | none | product decision |
| 10 | "Convert to Goodshuffle" creates a real project via `create_project`, stores `booking_id`; WON derived from the signed booking | none | — |
| 11 | Attribution: source → opportunity → booking → revenue, estimates kept apart from signed and realized | 10 | — |
| 12 | Reply ingestion: Smartlead webhook (signed) → stop sequence, task for the owner | 8 | — |
| 13 | State/local procurement sources (eMMA, eVA, DC OCP, counties) via official feeds or monitored manual review | research | — |
| 14 | Bid / no bid scorecard, subcontracting workflow | 10 | — |
| 15 | UI: overview action queue, nav consolidation, money redaction, mobile pass at 360/390/430 | 10, 11 | — |

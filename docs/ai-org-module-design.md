# AI Org — Module Design & Scoping

**Status:** Design for review (ANALYSIS / SCOPING ONLY — this task changed no production code, schema, config, or git).
**Author:** Scoping pass, 2026-10-04.
**Scope:** Define **AI Org**, a new top-level **control-plane** module that sits *above* the existing blades and governs Zoe's small roster of AI employees. It does NOT duplicate any module — it surfaces, governs, and routes what those modules already compute.

**Governing law (unchanged, holds throughout):**
**SYSTEMS PROVIDE FACTS → RULES CALCULATE → AI INTERPRETS / RECOMMENDS / EXECUTES → HUMANS OWN JUDGMENT.**
Deterministic logic stays deterministic. AI never produces a fact we can compute, never fabricates one, and never executes a consequential action without the authority to do so. An unknown stays `null` / UNVERIFIED and the UI says so — the house rule already enforced across `risk/*`, `scheduling/*`, `command/*`, `ops/*`, `connecteam.ts`, `instawork/*`.

Zoe is a **small company**. This design describes the **real** humans (Hermann+Cindy, Jessie, a Sales Rep, Lisa, Princess) and a **small, justified** AI workforce mapped to modules that already exist. Where an agent has no real data backing today (hiring, owned inventory, weather), it is marked **FUTURE / placeholder** and must ship as "coming", never with fabricated metrics.

---

## Table of contents

1. Current state — what AI Org surfaces, not rebuilds
2. AI employee registry model (config-driven v1)
3. Per-agent spec table (all 19, honest backing)
4. AI Employee Tool Architecture & Permissions (toolbox, permission levels, approval shape)
5. Command-center IA (the AI Org screen + employee detail)
6. Navigation plan (minimal add vs. full reorg)
7. Approvals / Runs / Exceptions surfaces
8. Control-plane contract (how AI Org reads/links without duplicating)
9. Phased build plan
10. Risks + unresolved questions + build-first / wait / why

---

## 1. Current state — what the platform already provides

AI Org is a **thin governance layer over existing substrate**. Five substrate pieces already exist and should be *reused verbatim* — they are, in effect, the plumbing an "AI employee" model needs.

### 1.1 The "runs" substrate — already a registry + runner + status (reuse as the model template)
`src/lib/runtime/jobs.ts` is the closest thing to an AI-employee registry that already ships:
- `RUNTIME_JOBS: RuntimeJob[]` — a **static config array** of integration jobs, each with `key`, `label`, `bucket` (`server`|`browser`), `configured()`, optional `run()`, `note`.
- `runServerJobs()` runs every *configured* job once and writes each result to the import ledger via `logImport` (no new table).
- `computeJobStatus(ledger, now, jobs)` is a **pure** function deriving `ok|stale|error|not_configured|browser_pending|never` + `lastRunAt` + `lastDetail` from the ledger. `runtimeStatus()` is the live convenience.
- Triggered off-machine by a GitHub Actions clock hitting `src/app/api/runtime/tick/route.ts` (token-gated by `RUNTIME_TOKEN`), surfaced by `src/app/api/runtime/status/route.ts`.

**This is the exact shape AI Org's registry should take** (a config array + pure status derivation + ledger-backed last-run), so AI employees and runtime jobs feel like one system and `lastRun`/`status` are REAL, never faked.

### 1.2 The execution / approvals substrate — the Goodshuffle outbox (`gs_outbox`)
`enqueueGsOp()` / `listGsOps()` / `ackGsOp()` in `src/lib/db/repo.ts` (~L1498–1585) are an **append-only queue of writes awaiting a logged-in session to apply** — already a human/async-gated action channel. Proven ops in use today:
- `email_send` (`api/salesos/send-email/route.ts`, master-switch `EMAIL_SEND_ENABLED`, human drafts+confirms each)
- `note_append` (`api/salesos/send-sms`, `comms/service.ts`, `salesos/coach.ts`)
- `create_project` (`api/intake/[id]/create`)
- `set_delivery_fee` (`api/pricing/push`), `remove_waypoint` (`api/route/stop/remove`)
- `photo_upload` (`api/action/route.ts`), `create_gs_task`, `add_team_member` (`repo.ts`)

**The outbox IS the AI Org "Approvals + external-action" execution path.** An AI employee's EXECUTE / APPROVAL_REQUIRED action = "enqueue a gs_outbox op" (or an internal DB write), gated by a human OK, drained by the office session. No new execution machinery needed.

### 1.3 The audit substrate — generic `audit_logs`
`insertAudit()` / `getRecentAudit()` / `getAuditForEntity()` (`repo.ts`) with the attributed wrapper `logSalesEvent()` / `recentSalesActivity()` (`src/lib/salesos/audit.ts`). Actor comes from `currentActor()` (`src/lib/auth/getSession.ts`) — "Unattributed" while login is off, honest. **Every AI employee action records here** (who/what/when/evidence), reusing the same table — this gives the "AI activity today" and "DATA USED" fields for free.

### 1.4 The attention / priority substrate — `ops/manager.ts`
`buildAttention(OpsInputs)` ranks risk/sales/finance/customer signals into one deterministic feed with `priority` = `critical|high|medium|info` and a pure `score` (`SEV_BASE` + `urgencyBonus` + `financialBonus` + high-value nudge). `summarize()` + `opsBrief()` template a plain-language brief **from counts only, no LLM**. `commandCenter()` (`src/lib/command/service.ts`) already composes this with finance/sales/capacity/crew into one payload.

**This is the backbone for the Priority/Exception agent** — it is the final deterministic filter; AI Org extends its inputs, it does not replace the ranking.

### 1.5 Connections health + roles (surface + gating)
- `src/lib/health/connections.ts` `computeConnections()` → OK / ATTENTION / OFF per integration, never faked. **The "is this AI employee's data source actually live?" badge reuses this directly.**
- `src/lib/auth/roles.ts` — `owner|admin|member|guest`, `canSeeFinancials/Coaching/ManageSettings/ManageUsers`. **$-redaction and manage-gating of the AI Org screens reuse these same gates.**

### 1.6 Nav + design
`src/components/ConsoleNav.tsx`: a `HUB` (Command Center) pinned at top, then **expandable big-blade `GROUPS`** (Opportunity Radar, Operations, Marketing, SEO Growth, Communications, Sales, Post-Event, Company) + a role-built Admin group. Nocturne tokens (dark, gold-accented, tactical; `bg-sidebar`, `text-foreground`, `--row-hover`, `border-border`) and the `exact`/`manage`/`financial`/`coaching` blade flags. **AI Org is one more top-level group here.**

### 1.7 The "AI interprets" seam (dormant)
`src/lib/llm.ts` — key-gated (`ANTHROPIC_API_KEY` or `LLM_BASE_URL`), never throws, `llmConfigured()`. Used today by the quote-risk Tier-2 (`quoteReview.ts`), outreach drafting (`outreachService.ts`), state classify/reanalyze, and coaching recaps (`coach/recap.ts`). `COMMS_STYLE` house voice (no dashes/emoji) is prepended to prose calls. **The LLM layer is LIVE infrastructure, key-gated** (`llmConfigured()`): every consumer has a deterministic floor and degrades gracefully to it when no key/endpoint is set. So most "AI employees" today are deterministic rule engines with a **live-when-keyed** LLM refinement on top — AI Org must present each honestly as whichever it currently is (and several extra switches gate specific AI: `CALL_SENTIMENT_LLM`, `OUTREACH_LLM`, `COACH_API_TOKEN`).

---

## 2. AI employee registry model (config-driven v1)

**Recommendation: v1 is a structured TypeScript config file, NOT a DB-backed agent-builder UI.** It mirrors `RUNTIME_JOBS` exactly. Rationale: the roster is ~19 known agents for a small company, changes rarely, and must be reviewable in code (permissions/authority are safety-critical and belong in version control, not an editable table a Member could change). An editable DB registry is a clear **later** upgrade path (§9) once the roster and authority model stabilize.

**Lives at:** `src/lib/aiorg/registry.ts` (config) + `src/lib/aiorg/service.ts` (pure derivation, à la `computeJobStatus`) + `src/lib/aiorg/types.ts`.

```ts
// src/lib/aiorg/types.ts  (shape — illustrative, not final)
export type AiDept = "sales" | "backoffice" | "marketing" | "ops_exec";
export type AiStatus = "live" | "partial" | "coming"; // honest backing state (see §3)

export interface AIEmployee {
  id: string;                 // "lead-intelligence"
  name: string;               // "Lead Intelligence"
  department: AiDept;
  owner: string;              // human owner: "Jessie" | "Lisa" | "Princess" | "Hermann+Cindy"
  mission: string;            // one sentence
  responsibilities: string[];
  inputs: InputRef[];         // REAL module/function refs it consumes (file:function)
  toolbox: Tool[];            // §4 — the ONLY tools this employee may use
  escalationRules: EscalationRule[];
  status: AiStatus;           // "coming" => never shows fabricated metrics
  // Derived at runtime, never stored stale:
  //   lastRun  <- import ledger / audit_logs (computeJobStatus-style)
  //   metrics  <- live module counts (e.g. salesos worklist size, open approvals)
  //   health   <- computeConnections() for the employee's data source
}
```

**How status/metrics/lastRun are derived from REAL signals (never faked):**
- `lastRun` — from the import ledger (for employees wired to a runtime job) or from `audit_logs` (the most recent attributed action by that employee), computed the same way `computeJobStatus` reads the ledger.
- `metrics` ("today") — live counts from the backing module's existing read (e.g. Lead Intelligence = `salesos` worklist size; Event Risk = `getOpenExceptions().length` + risk feed; Staffing = optimizer `tempHoursSaved`). Null when the module can't resolve it.
- `health` — `computeConnections()` row for the employee's integration; an OFF/ATTENTION source means the employee is honestly shown degraded.
- `status: "coming"` for any agent whose backing doesn't exist yet (§3) — the detail page shows "Not wired yet — no data source", **no numbers**.

**Honest "not wired yet":** an employee may be in the registry with `status: "coming"` to show the intended org, but its metrics render as "—" and its tools are DRAFT/FORBIDDEN only until a real backing lands.

---

## 3. Per-agent spec table (all 19 — honest backing)

Legend — **Backing:** LIVE (real wired data today) · PARTIAL (real but manual-entry or dormant-LLM or UNVERIFIED gap) · COMING (no real data source yet, ship as placeholder).
Authority columns: **CAN** = analyze/score/recommend/draft/create-task (no external effect). **APPROVAL** = prepared then waits for a human. **Escalate** = condition that routes to the human owner / Priority filter.

### Jessie — Sales team

| Agent | Backing | Real source (file:function) | CAN (no approval) | APPROVAL-required | Escalate when | Value measured by |
|---|---|---|---|---|---|---|
| Lead Intelligence | **LIVE** | `salesos/state.ts`, `salesos/nba.ts` `nextBestAction()`, `salesos/commandCenter.ts`, `salesos/calc.ts`; worklist `/salesos/worklist` | Score + rank leads, compute next-best-action + priority, draft the "why now" | — (read/analyze only) | High-value lead (`≥$10k`) just replied & untouched | Worklist coverage, time-to-first-touch |
| Quote/Opportunity Analyst | **LIVE** (det.; LLM refine when keyed) | Bid "priced to win?" = pure stats, NO LLM: `salesos/bidReview.ts` `bidReview()`, `bidService.ts` `reviewBid()`. Quote event-risk: `quoteReview.ts` (Tier-1 crew/tent rules always; Tier-2 LLM via `llm.ts` when keyed) | Deterministic quote age/gap + bid-percentile analysis, recommend REVIEW_QUOTE | Any price/discount change → **APPROVAL** (money) | Quote stale past threshold on large deal | Quote-review turnaround, win-rate on reviewed quotes |
| Lost Quote | **LIVE** (det., no LLM) | `salesos/lost.ts` (`winLossStats`, `reasonBreakdown`, `lossInsights`), `lostService.ts`; `/salesos/lost`. Loss-reason tagging is manual (GS stores none) | Tag loss reason, cluster lost-deal patterns, surface win-back candidates | Win-back outreach send → **APPROVAL** (comms) | Pattern of same loss reason on high-value deals | Win-back contact rate, re-engaged revenue |
| Outreach | **LIVE** draft (send built, gated OFF) | `salesos/outreach.ts` (template), `outreachService.ts` `draftLeadOutreach()`/`llmDraft()` (AI when keyed, `OUTREACH_LLM`); send via `api/salesos/send-sms` (`SMS_SEND_ENABLED`, direct) + `send-email` (`EMAIL_SEND_ENABLED`, → `email_send` outbox) | Draft history-aware SMS/email/call strategy | **Every send → APPROVAL**; both send switches default OFF | Customer commitment implied in draft | Reply rate, drafts accepted vs edited |
| Sales Coach | **LIVE** (heuristic floor; LLM recap/bridge when keyed) | `comms/sentiment.ts` `heuristicSentiment()` (always) + `analyzeSentiment()` (`CALL_SENTIMENT_LLM`); `comms/service.ts` `ingestCallEvent()`; recap `coach/recap.ts` `generateRecap()` (LLM-only→`coaching_analyses`); bridge `salesos/coach.ts` (`COACH_API_TOKEN`, fail-closed); `/coaching` | Score call tone, draft coaching notes + debrief→state | Posting coaching note to GS (`note_append`) → **APPROVAL** | Negative-tone call on active deal | Coaching coverage, call-tone trend |

**Lead universe is the Goodshuffle `bookings` table, not Quo-born.** Inbound SMS/calls (OpenPhone webhook, `api/openphone/webhook` → `comms/service.ts` `ingestInboundSms`/`ingestCallEvent`) are **matched by phone to an existing booking**; an unmatched inbound creates no new lead. Comms **system-of-record is SQLite** — `comms_events` (unified timeline), `call_events`, `coaching_analyses`, `customer_state` — AND pushed back to GSPRO internal notes via the `note_append` outbox op + mirrored in `audit_logs` (`logSalesEvent`). Note: `salesos/service.ts` still hard-codes `hasCommsIntegration:false` in its Phase-1 overview — a stale honesty flag to clean up.

### Lisa — Back Office team

| Agent | Backing | Real source (file:function) | CAN | APPROVAL | Escalate when | Value measured by |
|---|---|---|---|---|---|---|
| Staffing | **PARTIAL** (new, record-only) | `scheduling/optimize.ts` `optimizeStaffing()`, `crewRules.ts`, `capacity/capacity.ts`, `connecteam.ts`, `instawork/*` | Recommend whole-day staffing plan, show temp-hours/cost saved, flag gaps | Apply plan / assign staff → **APPROVAL** (operational) | Coverage gap can't be filled internally | Temp hours avoided (`tempHoursSaved`), coverage % |
| Scheduling | **PARTIAL** (lifecycle WIP) | `scheduling/store.ts`, `coverage.ts`, `demand.ts`, `lifecycle.ts`, `assignments.ts`; Connecteam publish (`connecteam.ts`, LIVE) | Materialize demand→draft shifts, compute readiness/coverage | Publish to Connecteam / post Instawork gig → **APPROVAL** | Shift unready at start (RED) | Shift readiness %, open-shift count |
| Hiring | **COMING** | **No backing** — no hiring/HR/recruiting/applicant store exists in repo (confirmed). | — (placeholder) | — | — | — (ship as "coming") |
| Back Office | **PARTIAL** | `admin/*` (settings/users/health), `settings.ts`, `auth/users.ts` — config, not a workflow engine | Surface admin tasks / connection-attention items | Settings/user changes → **APPROVAL** (`canManageSettings`) | Integration OFF/ATTENTION (`computeConnections`) | Connections healthy %, setup completeness |

### Princess — Marketing team

| Agent | Backing | Real source (file:function) | CAN | APPROVAL | Escalate when | Value measured by |
|---|---|---|---|---|---|---|
| Event Radar | **PARTIAL** (LIVE workflow on SEED; real feeds gated) | `opportunity/*` — `service.ts` `opportunityBoard()`, `score.ts`, `classify.ts`, `maturity.ts`, `fusion.ts`, `store.ts`; `/radar`. Data by default = 6 `SEED_OPPS` (`seed.ts`, badged SEED). Real feeds dormant: SAM.gov (`sources/samgov.ts`, needs `SAM_API_KEY`), portal scraping (`sources/browser.ts`, needs external browser agent → `/api/radar/ingest`), CSV import (`import.ts`, live), event bridge (`eventBridge.ts`) | Detect + score future-demand opportunities, recommend pursue | Pursue/outreach send → **APPROVAL** (comms) | High-score opportunity near deadline | Opportunities surfaced→pursued, pipeline added |
| Content | **PARTIAL** (manual facts; gen mocked) | `marketing/store.ts` (`listContent`), `marketing/dashboard.ts` (calendar is **team-entered**, no auto feed); Creative Engine `creative/*` (`store.ts` `listJobs()`, real lifecycle/QA) — but image gen **defaults to `mockProvider`**; `fal`/`replicate`/`openai-image` are honest stubs | Flag overdue/upcoming content, draft copy (via Creative/LLM) | Publish content → **APPROVAL** (public) | Overdue content on a live campaign | Content cadence kept, overdue count |
| Campaign Analyst | **PARTIAL** (manual facts) | `marketing/store.ts` (`listCampaigns` w/ budget/spend/result_*), `marketing/dashboard.ts`. Metrics are **manually entered** — no HubSpot/ad-API ingestion. (Radar campaigns `opportunity/campaigns.ts` derive metrics from the opportunity pipeline, mostly seed) | Aggregate campaign spend vs result, flag underperformers | Budget/spend changes → **APPROVAL** (money) | Spend up with no result movement | Campaigns with recorded ROI, win-by-source |
| Competitive Intelligence | **COMING** (Phase-3 placeholder) | `seo/competitors` page is an explicit `<SeoPlaceholder>` stub. Only real signal = `SeoOpportunity.competitorRefs` scraped as a side-effect of `seo/discovery.ts`, gated behind the **unconfigured** Ubersuggest MCP (`seo/ubersuggest.ts`, wire protocol unverified). NOTE `radar/companies` is the relationship graph (buyers/partners), **not** competitors | — (read/analyze) | New competitor on a target keyword | Competitor coverage tracked |

Marketing module summary: `marketing/types.ts` (Campaign/ContentItem/Review/Prospect/ChannelLinks), `store.ts` (DB CRUD, all manual facts), `dashboard.ts` (`marketingDashboard()` deterministic aggregation). **No automated marketing-metric ingestion exists** — this is the honest ceiling for Campaign Analyst/Content. The real content *production* engine is `creative/*` (lifecycle live, pixel generation mocked by default).

### Hermann + Cindy — Ops / Exec team

| Agent | Backing | Real source (file:function) | CAN | APPROVAL | Escalate when | Value measured by |
|---|---|---|---|---|---|---|
| Executive Briefing | **LIVE** | `command/service.ts` `commandCenter()` (+ `command/calc.ts`), `sales/service.ts`, `finance/service.ts` | Compose the deterministic daily brief from existing aggregates | — (read/analyze) | Day status RED / critical count up | Brief accuracy, owner time saved |
| Event Risk | **LIVE** | `risk/engine.ts` `assessDay()`, `risk/readiness.ts` `computeReadiness()`, `risk/scan.ts` `runScan()` (14-day, Slacks only on change), `risk/store.ts` (`risk_items` lifecycle), `crewRules.ts`; `/risk`. (No weather feed — confirmed absent, notable for tent/outdoor risk) | Score readiness, list open risks + recommended action | — (analyze; feeds attention) | CRITICAL risk / capacity CONSTRAINED | Risks caught pre-event, readiness trend |
| Dispatch/Route | **LIVE** | `db/repo.ts` (routes/stops: `getRoutesForDate`, `getOpenExceptions`), `notify/routeRisk.ts`, `eta/*`, dispatch fan-out `notify/fanout.ts` | Monitor route progress, compute ETA/risk | Push stop/route status → **APPROVAL** (customer-facing; the proposed GS status-sync write) | Stop exception / route behind | On-time %, exceptions resolved |
| Inventory Exception | **PARTIAL (UNVERIFIED)** | `inventory/inventory.ts` `peakItemDemand()` — concurrent-demand ONLY; **no owned-inventory master**, so over-booking stays UNVERIFIED | Surface peak concurrent demand per item | — | Peak demand spikes on a date | Concurrency conflicts flagged (not over-booking) |
| Business Intelligence | **LIVE** (contribution partial) | `finance/service.ts` `financeForPeriod()`, `calc.ts`, `allocation.ts` `allocateDriverLabor()`, `laborHistory.ts`, `periods.ts`; `sales/calc.ts`, `sales/service.ts`; `history/store.ts` (snapshots/changes/outcomes). Real: GS revenue + Connecteam labor. **Only direct cost is driver labor**; fuel/vehicle/subrental enumerated but unpopulated → contribution UNAVAILABLE unless both resolve (never costs-zeroed) | Compute revenue/labor/contribution trends, outcomes | — (analyze; $-gated) | Labor over plan past alert threshold | Trend accuracy, variance caught |
| Priority/Exception | **LIVE** (as ranked feed) | `ops/manager.ts` `buildAttention()`/`summarize()`/`opsBrief()`, `ops/service.ts` `opsOverview()`, `getOpenExceptions()` (driver field exceptions), `notify/alert.ts`+`fanout.ts`. **No P0–P3 literal exists** (scales are `critical/high/medium/info` + `CRITICAL..LOW`); **no per-owner final filter today** (Slack is channel-wide, risk `owner` is manual) — the per-human routing is NEW | Rank ALL signals, dedupe, filter to the few that need an owner | Changing routing rules → **APPROVAL** | Critical/high after filtering | **Fewer, higher-signal interruptions** (noise reduction) |

**Agents that pass the "what job / what data / what decisions / what execution / when to ask a human / how to measure" test: all except Hiring (COMING — no data) and Inventory Exception (ships honestly as concurrent-demand only, labeled UNVERIFIED for over-booking).** No agent is fabricated.

---

## 4. AI Employee Tool Architecture & Permissions

**Core principle:** an AI employee has **no unrestricted platform access**. Each gets an explicit **TOOLBOX** — the only tools it may use. It chooses among *its* tools for the task; it must not invent tools, bypass permissions, or call anything outside its toolbox. The UI/runtime only ever exposes that employee's assigned tools, never the full registry. **Minimum tools necessary.** Order is always **READ → UNDERSTAND → ANALYZE → RECOMMEND → ACT** — never ACT then investigate.

### 4.1 Permission levels (per tool, per employee) — modeled in config
```ts
type PermLevel =
  | "READ"              // retrieve data
  | "ANALYZE"           // process + recommend (no external effect)
  | "DRAFT"             // prepare an artifact, cannot execute
  | "EXECUTE"           // perform without approval (rare; low-risk only)
  | "APPROVAL_REQUIRED" // prepare + wait for a human decision
  | "FORBIDDEN";        // tool not exposed at all
interface Tool { id: string; category: ToolCategory; perm: PermLevel; backing: string /*file:fn or "none"*/; }
```
A `FORBIDDEN` tool is simply **absent** from the toolbox (not merely hidden) — the employee cannot reference it.

### 4.2 Tool categories → REAL repo functions (honest backing)

| Category | Example tools | Real backing (file:function) | Backing state |
|---|---|---|---|
| **DATA (read)** | Goodshuffle project/history, events, sales history, staffing, fleet/ETA | `db/repo.ts` (`getBookingById`, `getRoutesForDate`, `getPipelineBookingsInRange`, `getOpenExceptions`), `salesos/*`, `connecteam.ts`, `instawork/*`, `eta/*`, `history/store.ts` | LIVE |
| DATA — inventory read | concurrent-demand only | `inventory/inventory.ts` `peakItemDemand()` | PARTIAL (no owned master) |
| **ANALYSIS** | quote age, days-to-event, risk score, opportunity score, staffing requirement, historical compare | `salesos/nba.ts`, `salesos/calc.ts`, `risk/readiness.ts`, `crewRules.ts`, `opportunity/score.ts`, `scheduling/optimize.ts`, `finance/calc.ts`, `ops/manager.ts` | LIVE (deterministic) |
| **COMMUNICATION — draft** | draft SMS/email/call-script | `salesos/service.ts`, `noteFormat.ts`, `llm.ts` (prose, `COMMS_STYLE`) | LIVE (LLM key-gated) |
| **COMMUNICATION — send** | send SMS, send email | `api/salesos/send-sms`, `send-email` → `enqueueGsOp('email_send'/'note_append')` | LIVE, **always APPROVAL + master-switch** |
| **WORKFLOW** | create/assign task, update status, create approval request, escalate exception | `enqueueGsOp('create_gs_task')`, `insertException()`, `audit_logs`, the outbox itself | LIVE |
| **EXTERNAL ACTION** | send customer comms, modify quote/pricing, schedule staff, change op assignments | `enqueueGsOp('set_delivery_fee'/'remove_waypoint'/'create_project')`, Connecteam publish | LIVE for the proven ops; **APPROVAL by default** |
| EXTERNAL — CRM write | update CRM | — | **COMING / none** (no CRM-write API beyond GS outbox ops) |

**Any category with no backing is marked COMING in the tool's `backing: "none"` and rendered as unavailable — never invented.**

### 4.3 Tool-selection flow (the 10 steps the runtime enforces)
1. Understand the objective → 2. Determine info required → 3. Identify the **minimum** tools → 4. Retrieve (DATA) → 5. Analyze (ANALYSIS) → 6. Determine the recommended action → 7. **Check if approval is required** → 8. Execute **only if authorized** (else enqueue an approval) → 9. Record the result (`audit_logs`) → 10. Escalate if an escalation condition is met (`insertException` / Priority filter).
Before any external action: verify the needed info exists **and** the action is within the employee's authority.

### 4.4 Human-approval defaults
Anything involving **money, discounts, refunds, customer commitments, operationally significant schedule changes, hiring, firing, high-value customer communication, contract changes, or permanent data deletion** defaults to **`APPROVAL_REQUIRED`** unless a config explicitly lowers it. (These line up with existing gates: `canSeeFinancials`, `EMAIL_SEND_ENABLED`, the outbox, and the Prohibited-action rules.)

Each approval request MUST show the six fields (this is also the Approvals-surface card contract, §7):
- **WHAT** the AI wants to do · **WHY** · **DATA USED** (traceable refs) · **EXPECTED OUTCOME** · **RISK** · **WHAT HAPPENS IF APPROVED**.
The human can **APPROVE / REJECT / EDIT / REQUEST MORE INFO**. APPROVE drains the queued `gs_outbox` op (or runs the internal write); EDIT changes the draft before queueing; REJECT discards + records the reason to `audit_logs`; REQUEST MORE INFO sends it back to the employee with a note.

---

## 5. Command-center IA

Two screens, both Nocturne dark/gold/tactical ("Bloomberg terminal meets command center"): dense rows, monospace-ish figures, status dots, no gradients, no chatbot bubbles, no robot clichés, no huge rounded cards. Reuse existing tokens (`bg-sidebar`, `border-border`, `text-foreground`, `text-meta`, `--row-hover`) and the status vocabulary from `connections.ts` (OK/ATTENTION/OFF) + `ops/manager.ts` (critical/high/medium/info).

### 5.1 `/ai-org` — the org command center
Vertical bands, top-down = **HUMANS → AI EMPLOYEES → ACTIVE WORK → EXCEPTIONS → OUTCOMES**:
- **Humans (manager cards)** — one card per real human (Hermann+Cindy, Jessie, Sales Rep, Lisa, Princess): role, the AI employees they manage (with live status dot), **open approvals** count, **open exceptions** count, **AI activity today** (from `audit_logs`). No fabricated humans/departments.
- **AI Employees** — compact grid grouped by human owner; each row: name, department, status (LIVE/PARTIAL/COMING), last-run, today's headline metric (or "—" when COMING / UNVERIFIED), data-source health dot (`computeConnections`).
- **Active Work** — what employees are doing now (recent + in-flight analyses/drafts, from the runs + audit feed).
- **Exceptions** — the Priority/Exception filtered feed (`buildAttention` output, critical/high first).
- **Outcomes** — measured value this week (e.g. temp hours avoided, drafts accepted, risks caught) — only where a real metric exists.

### 5.2 `/ai-org/[id]` — AI employee detail
Owner · mission · status · last-run · today's metrics (real or "—") · **inputs** (the real module/function refs, linking into the backing blade) · **authority** split into **CAN** vs **REQUIRES APPROVAL** (from the toolbox/permission levels) · **escalate-when** · **performance** (the value metric over time). COMING employees show "Not wired yet — no data source" and no numbers.

---

## 6. Navigation plan

**Recommendation: MINIMAL ADD. Add "AI Org" as one new top-level group in the existing `ConsoleNav` `GROUPS`; do NOT adopt the full COMMAND/REVENUE/OPERATIONS/MARKETING/INTELLIGENCE/AI reorg now.**

Why not the full reorg: the current nav (Radar / Operations / Marketing / SEO / Communications / Sales / Post-Event / Company + Admin) maps to live routes and working muscle memory. A top-to-bottom relabel touches every route group, risks breaking `isActive` highlighting and deep links, and delivers no new capability. AI Org is **additive governance** — it should slot in without disturbing what works. The brief's reorg can be revisited later as a pure presentation change once AI Org proves out.

**Exact nav edit the build will make** — add one `Group` to `GROUPS` in `src/components/ConsoleNav.tsx` (pick an existing lucide icon, e.g. `BrainCircuit`/`Bot`/`Cpu` already-imported-style):
```
{ label: "AI Org", icon: <icon>, blades: [
  { href: "/ai-org",            label: "AI Org",        icon: Gauge, exact: true },
  { href: "/ai-org/employees",  label: "AI Employees",  icon: UsersRound },
  { href: "/ai-org/approvals",  label: "Approvals",     icon: ClipboardCheck },
  { href: "/ai-org/runs",       label: "Runs",          icon: RefreshCw },
  { href: "/ai-org/exceptions", label: "Exceptions",    icon: AlertTriangle },
]}
```
Gating: the group is `manage`-gated (owner/admin) for v1 — AI governance + approvals are a leadership surface; `$`-bearing metrics reuse `canSeeFinancials`. No route renames, no deletions.

---

## 7. Approvals / Runs / Exceptions surfaces

All three reuse existing substrate — **no new engines**:

- **Approvals** (`/ai-org/approvals`) — the queue of AI-prepared actions awaiting a human OK. Backed by the **`gs_outbox`** (`listGsOps()`), filtered to AI-originated ops, plus any internal-write approvals. Each row renders the §4.4 six-field card (WHAT/WHY/DATA/OUTCOME/RISK/IF-APPROVED) with APPROVE/REJECT/EDIT/REQUEST-MORE-INFO. APPROVE lets the office session drain the op (`ackGsOp`); every decision writes `audit_logs`. This generalizes today's per-message "rep drafts + confirms each send" into a uniform approval surface.
- **Runs** (`/ai-org/runs`) — each AI employee's execution history + freshness, backed by the **runtime-jobs/import-ledger pattern** (`computeJobStatus`-style derivation) and `audit_logs`. An employee wired to a `RUNTIME_JOBS` entry shows its real last-run/state; others show last attributed action. Browser-bucket dependence (Goodshuffle) stays honestly `browser_pending`.
- **Exceptions** (`/ai-org/exceptions`) — the **Priority/Exception agent output**: `buildAttention()` ranked feed + `getOpenExceptions()`, deduped. **No P0–P3 literal exists in the code today** (the scales are `critical|high|medium|info` and `CRITICAL..LOW`); if the brief wants P0–P3 it is a **label mapping** over the existing scale, not new severity logic — and the per-human routing (to a named owner) is net-new (today Slack is channel-wide). The Priority/Exception agent is explicitly the **final filter to Hermann+Cindy — fewer interruptions, not more noise**: it collapses duplicate signals, suppresses already-acknowledged items, and only promotes P0/P1 to an owner push (`notify/alert.ts`). Zoe has Goodshuffle's stop-SMS off, so route-status writes are safe re: double-texting (per CLAUDE.md).

---

## 8. Control-plane contract

AI Org never stores module data or re-implements module logic. The one-way contract for every employee:

```
AI Org  →  AI Employee (registry config, toolbox)
        →  existing module/tool (DATA/ANALYSIS fn in repo)
        →  data (real; null/UNVERIFIED when unknown)
        →  AI interpretation / recommendation (deterministic rules; optional dormant LLM for prose)
        →  human decision (Approvals surface; APPROVE/REJECT/EDIT/MORE-INFO)
        →  execution (gs_outbox op / internal write)  →  audit_logs
```
Rules: (1) read before act; (2) only the employee's toolbox tools; (3) consequential actions are `APPROVAL_REQUIRED` by default; (4) every step recorded to `audit_logs`; (5) a dead/degraded data source (`computeConnections` OFF/ATTENTION) degrades the employee honestly — it does not fabricate. AI Org links *into* each backing blade (the detail page's `inputs` are deep links), it does not copy their screens.

---

## 9. Phased build plan (smallest safe first)

- **v1 (ship first):** registry config (`src/lib/aiorg/{types,registry,service}.ts`) + `/ai-org` command center + `/ai-org/[id]` detail + the minimal nav group (§6). Surface **REAL** signals where they exist (Lead Intelligence, Quote/Lost-Quote analysis, Outreach-draft, Sales Coach, Executive Briefing, Event Risk, Dispatch, BI, Staffing/Scheduling, Priority/Exception), **SEED-badged** where data is demo-only (Event Radar until SAM.gov/scraper feeds are keyed), and honest **"coming" / UNVERIFIED** where there is no source (Hiring, Inventory over-booking, Competitive Intelligence, Campaign/Content auto-metrics). Read-only + draft-only; no new execution path. This is low-risk: it composes existing pure functions, like `commandCenter()` did.
- **v2:** Approvals surface over `gs_outbox` with the six-field card; wire Outreach/Quote/Lost-Quote sends and Dispatch status-sync through it (all already approval-gated). Runs surface over the ledger/audit.
- **v3:** per-agent live EXECUTE actions as each proves out (Scheduling publish, Staffing apply), each behind its master switch + approval + idempotency.
- **Later:** editable DB-backed registry (upgrade from the config file) once roster/authority stabilize; optional LLM interpretation layer turned on (`ANTHROPIC_API_KEY`) for briefs/explanations over the same deterministic facts.

**Dependency:** the Staffing and (partly) Exec/BI agents depend on the **shift lifecycle + cost work now underway** (`docs/shift-lifecycle-engine-analysis.md`, `docs/shift-staffing-cost-optimization.md`, `scheduling/optimize.ts`, `scheduling/lifecycle.ts`). Those agents should stay `PARTIAL` until that lands; AI Org must read them through the scheduling services, not re-derive.

---

## 10. Risks + unresolved questions + build-first / wait / why

**Risks**
- **Fabrication risk** — the single biggest. Enforce `status: "coming"` ⇒ no metrics, and null/UNVERIFIED everywhere a source is missing (Hiring, owned inventory, marketing auto-metrics). v1 must never present a fabricated number as real.
- **Authority drift** — permissions in a config file are safe only if reviewed in PRs; an editable DB registry (later) must not let a non-owner widen authority. Keep money/comms/schedule defaults at APPROVAL_REQUIRED.
- **Noise** — the Priority/Exception agent must *reduce* interruptions; if it just re-lists `buildAttention`, it adds noise. Needs dedupe + acknowledge state.
- **Concurrent build** — a separate build is editing code now (notably `scheduling/*`, `salesos/*`); AI Org should consume their services, not fork logic, to avoid collisions.
- **LLM dormant** — most "AI employees" are deterministic today; presenting them as "AI" must stay honest (rules calculate; AI interprets only where `llmConfigured()`).

**Unresolved questions**
- Confirm the real human→agent ownership (brief groups 19 under 4 owners; validated against the stated structure, but the Sales Rep's direct agents vs Jessie's should be confirmed).
- Which v1 agents does the user want shown LIVE vs "coming"? (proposed LIVE set in §9).
- Is a Goodshuffle **status-sync** write (dispatch→GS stop/route) in scope for v2, and behind which switch?
- Owned-inventory master: any near-term source, or stays UNVERIFIED indefinitely?

**Build first / wait / why**
- **Build first:** the registry config + `/ai-org` command center + employee detail + minimal nav (v1). It is read-only, composes existing pure functions, disrupts no routes, and immediately gives Zoe the org view honestly. **Why:** highest value, lowest risk, no new execution surface.
- **Wait:** the Approvals *execution* wiring (v2) until the command center + registry shape are reviewed; the full nav reorg (likely never — keep minimal add); live EXECUTE actions until each agent's master-switch + idempotency are in place; the editable DB registry until the roster stabilizes.
- **Why:** authority and sends are consequential; the platform's whole trust model is "rules calculate, AI recommends, humans decide" — ship the surfacing layer first, gate every action behind a human, and never fabricate.

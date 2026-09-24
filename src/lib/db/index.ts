// SQLite database — the system of record (replaces Zapier Tables). One file on a
// persistent volume; zero external services. better-sqlite3 is synchronous, which
// is fine inside route handlers.
//
// The connection is a singleton stashed on globalThis so Next's dev HMR and the
// separate route-handler bundles all share one handle. Schema is created on first
// import (idempotent).

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DATABASE_PATH || "./data/dispatch.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS routes (
  route_id   TEXT PRIMARY KEY,
  truck_id   TEXT NOT NULL,
  date       TEXT NOT NULL,
  driver_id  TEXT,
  status     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routes_truck ON routes(truck_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS stops (
  stop_id        TEXT PRIMARY KEY,
  route_id       TEXT NOT NULL,
  customer_id    TEXT,
  sequence       INTEGER NOT NULL,
  state          TEXT NOT NULL,
  cust_name      TEXT,
  cust_first_name TEXT,
  kind           TEXT,
  cust_phone     TEXT,
  address        TEXT,
  day_of_name    TEXT,
  day_of_phone   TEXT,
  planned_window TEXT,
  eta            TEXT,
  items          TEXT,
  arrived_at     TEXT,
  completed_at   TEXT,
  tracking_token TEXT,
  photos_ref     TEXT,
  signature_ref  TEXT
);
CREATE INDEX IF NOT EXISTS idx_stops_route ON stops(route_id, sequence);

CREATE TABLE IF NOT EXISTS events (
  event_id        TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  stop_id         TEXT,
  route_id        TEXT,
  truck_id        TEXT,
  driver_id       TEXT,
  action          TEXT NOT NULL,
  from_state      TEXT,
  to_state        TEXT,
  ts              TEXT NOT NULL,
  gps             TEXT,
  payload         TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  message_id      TEXT PRIMARY KEY,
  stop_id         TEXT,
  channel         TEXT,
  provider        TEXT,
  to_phone        TEXT,
  body            TEXT,
  provider_msg_id TEXT,
  status          TEXT,
  error           TEXT,
  sent_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exceptions (
  exception_id TEXT PRIMARY KEY,
  stop_id      TEXT,
  type         TEXT,
  reason       TEXT,
  driver_id    TEXT,
  truck_id     TEXT,
  gps          TEXT,
  ts           TEXT NOT NULL,
  resolved     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id  TEXT PRIMARY KEY,
  actor     TEXT,
  action    TEXT,
  entity    TEXT,
  entity_id TEXT,
  before    TEXT,
  after     TEXT,
  ts        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Provider credentials (API keys/tokens + non-secret provider config like from-numbers).
-- Read only server-side; secret fields are never returned to the client in plaintext.
CREATE TABLE IF NOT EXISTS secrets (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracking_links (
  token      TEXT PRIMARY KEY,
  stop_id    TEXT,
  route_id   TEXT,
  url        TEXT,
  expires_at TEXT,
  active     INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Outbox for writes we need to push BACK to Goodshuffle. Our server can't reach
-- Goodshuffle (Cloudflare blocks server-side calls), so a logged-in session (the kiosk
-- WebView or the office bookmarklet) drains this and replays the write with its cookies.
-- First op: "remove_waypoint" — dispatch pulled a stop, so drop it from the GS route.
CREATE TABLE IF NOT EXISTS gs_outbox (
  id             TEXT PRIMARY KEY,
  op             TEXT NOT NULL,      -- "remove_waypoint"
  route_id       TEXT,              -- our route id
  stop_id        TEXT,              -- our stop id
  gs_route_id    TEXT,              -- Goodshuffle routeID
  transaction_id TEXT,              -- Goodshuffle waypoint transactionID (match key)
  label          TEXT,              -- human label for the dispatch/audit view
  payload        TEXT,              -- JSON extra
  status         TEXT NOT NULL,     -- "pending" | "done" | "failed"
  attempts       INTEGER DEFAULT 0,
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gs_outbox_status ON gs_outbox(status, created_at);

-- Event Risk Engine (MVP2). Persisted risks with a stable signature so re-scans update in
-- place (never duplicate); lifecycle OPEN→ACKNOWLEDGED→IN_PROGRESS→RESOLVED/DISMISSED.
CREATE TABLE IF NOT EXISTS risk_items (
  id                 TEXT PRIMARY KEY,
  signature          TEXT UNIQUE NOT NULL,
  risk_type          TEXT NOT NULL,
  category           TEXT NOT NULL,
  severity           TEXT NOT NULL,
  status             TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  date               TEXT,
  event_id           TEXT,
  route_id           TEXT,
  truck_id           TEXT,
  affected_entity    TEXT,
  recommended_action TEXT,
  action_target      TEXT,
  owner              TEXT,
  deadline           TEXT,
  metadata           TEXT,
  first_detected_at  TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  resolved_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_risk_status ON risk_items(status, date);

-- Financial Intelligence (MVP3). Per-event financial profile — revenue (from Goodshuffle),
-- planned/actual labor (from Connecteam pay rates × hours), contribution, margin. Each field
-- carries a *_status so the UI can distinguish a real value from "unavailable". Keyed by the
-- Goodshuffle transactionID so repeated imports update in place (no duplicate rows).
CREATE TABLE IF NOT EXISTS event_financials (
  event_id            TEXT PRIMARY KEY,
  date                TEXT,
  label               TEXT,
  route_id            TEXT,
  revenue             REAL,
  revenue_status      TEXT,   -- SIGNED | SCHEDULED | COLLECTED | UNAVAILABLE
  collected           REAL,
  planned_hours       REAL,
  actual_hours        REAL,
  rate_status         TEXT,   -- ACTUAL | UNAVAILABLE (whether pay rates were on file)
  planned_labor_cost  REAL,
  actual_labor_cost   REAL,
  other_direct_cost   REAL,
  contribution        REAL,
  margin_pct          REAL,
  calculated_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_financials_date ON event_financials(date);

-- Operational History (MVP4). Point-in-time SNAPSHOTS of an event's known plan state, captured
-- deterministically on each risk scan — but only when a meaningful field changed (dedup by sig).
-- Lets us answer "what did we know 14/7/3/1 days out?" Tied to the stable Goodshuffle event id.
CREATE TABLE IF NOT EXISTS event_snapshots (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL,
  event_date      TEXT,
  label           TEXT,
  route_id        TEXT,
  days_out        INTEGER,        -- calendar days from capture to the event
  driver_name     TEXT,
  risk_level      TEXT,
  readiness_score INTEGER,
  open_risks      INTEGER,
  revenue         REAL,
  sig             TEXT,           -- hash of the meaningful fields; a repeat sig is NOT re-snapshotted
  captured_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_snapshots_event ON event_snapshots(event_id, captured_at);

-- Append-only CHANGE LOG (MVP4). One row per meaningful state change (driver reassigned, risk
-- escalated/resolved, event rescheduled, plan changed, …). Never updated. Deduped by (change_key)
-- so repeated imports/scans don't log the same unchanged transition twice.
CREATE TABLE IF NOT EXISTS history_changes (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  source      TEXT,               -- dispatch | risk | goodshuffle | finance | connecteam
  event_id    TEXT,
  entity      TEXT,               -- route | stop | risk | event | financial
  entity_id   TEXT,
  kind        TEXT,               -- driver_assigned | risk_escalated | risk_resolved | ...
  field       TEXT,
  from_value  TEXT,
  to_value    TEXT,
  change_key  TEXT UNIQUE         -- idempotency: same transition logged once
);
CREATE INDEX IF NOT EXISTS idx_history_changes_ts ON history_changes(ts DESC);
CREATE INDEX IF NOT EXISTS idx_history_changes_event ON history_changes(event_id, ts DESC);

-- Controlled Automation (MVP8), OBSERVE MODE ONLY. Each row is an action the system WOULD
-- propose (derived deterministically from risks/gaps) — it is NEVER executed here. first_observed_at
-- lets the UI show "we've been recommending this for N days". Deduped by proposal_key (idempotent).
CREATE TABLE IF NOT EXISTS automation_proposals (
  proposal_key      TEXT PRIMARY KEY,
  tier              TEXT,            -- observe | recommend | prepare | approve | auto (intended handling)
  target            TEXT,            -- dispatch | connecteam | goodshuffle | slack | internal
  action_type       TEXT,
  title             TEXT,
  detail            TEXT,
  reversible        INTEGER,
  outward           INTEGER,         -- 1 = touches customers / external commercial system
  first_observed_at TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  status            TEXT DEFAULT 'observed'
);

-- Goodshuffle BOOKINGS (projects) — the commercial pipeline, distinct from routes (logistics).
-- Source: /app/project/searchProjects. This is the truth for Sales (forward pipeline), Finance
-- (revenue), and Customer (value/repeat). Amounts stored in DOLLARS (converted from GS cents on
-- ingest). Keyed by the Goodshuffle project id.
CREATE TABLE IF NOT EXISTS bookings (
  booking_id      TEXT PRIMARY KEY,   -- Goodshuffle project id
  event_name      TEXT,
  event_date      TEXT,               -- YYYY-MM-DD (from logistics_start_date); null if unscheduled
  status_label    TEXT,
  signed          INTEGER,            -- 1 = signed contract, 0 = quote/unsigned
  contract_total  REAL,               -- dollars
  grand_total     REAL,               -- dollars (revenue)
  amount_paid     REAL,               -- dollars
  amount_due      REAL,               -- dollars
  client_name     TEXT,
  client_email    TEXT,               -- stable-ish customer identity for MVP6
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(event_date);

-- Post-event outcomes (MVP4 Phase 3) — captured when a route is closed. How the event actually
-- went vs plan, the factual basis for postmortems. One row per (event, route).
CREATE TABLE IF NOT EXISTS event_outcomes (
  event_id        TEXT NOT NULL,
  route_id        TEXT NOT NULL,
  date            TEXT,
  total_stops     INTEGER,
  completed_stops INTEGER,
  all_completed   INTEGER,
  closed_at       TEXT NOT NULL,
  PRIMARY KEY (event_id, route_id)
);
CREATE INDEX IF NOT EXISTS idx_event_outcomes_closed ON event_outcomes(closed_at DESC);

-- Labor trajectory (MVP4 P3) — the planned→revised→actual labor plan for a week, captured over
-- time (deduped: only when the numbers change). Shows how a week's labor evolved from scheduled
-- plan toward actual timesheets. Dollars.
CREATE TABLE IF NOT EXISTS labor_snapshots (
  id            TEXT PRIMARY KEY,
  week_start    TEXT NOT NULL,      -- Sunday, YYYY-MM-DD
  planned_hours REAL,
  planned_cost  REAL,
  actual_hours  REAL,
  actual_cost   REAL,
  sig           TEXT,               -- hash of the four figures; a repeat is NOT re-snapshotted
  captured_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labor_snapshots_week ON labor_snapshots(week_start, captured_at);

-- Direct cost entries (event-level economics, NOT accounting). One row per cost, associable at the
-- finest grain known (event > route > day > company). Contribution = revenue − DIRECT costs. Absent
-- cost = UNAVAILABLE, never 0. Idempotent derived writes via source_ref.
CREATE TABLE IF NOT EXISTS cost_entries (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,   -- labor | vehicle | fuel | subcontractor | sub_rental | consumables | event_expense | other
  class         TEXT NOT NULL,   -- DIRECT | OVERHEAD
  event_id      TEXT,            -- Goodshuffle tx/booking id (most specific)
  route_id      TEXT,
  day           TEXT,            -- YYYY-MM-DD
  amount        REAL,            -- dollars
  amount_status TEXT NOT NULL,   -- ACTUAL | ESTIMATED | UNAVAILABLE
  hours         REAL,            -- labor rows: lets cost recompute if a rate is backfilled
  rate          REAL,
  source        TEXT,            -- connecteam | goodshuffle | manual | derived
  source_ref    TEXT UNIQUE,     -- idempotency key
  note          TEXT,
  captured_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_entries_event ON cost_entries(event_id);
CREATE INDEX IF NOT EXISTS idx_cost_entries_day ON cost_entries(day);

-- Per-day capacity verdict (can we execute the day?) — recomputed each scan.
CREATE TABLE IF NOT EXISTS day_capacity (
  date        TEXT PRIMARY KEY,
  verdict     TEXT NOT NULL,    -- AVAILABLE | TIGHT | CONSTRAINED | UNVERIFIED
  reasons     TEXT,             -- JSON string[]
  computed_at TEXT NOT NULL
);

-- Import ledger (Data Health keystone) — one row per pull/ingest attempt, so we can answer
-- "did last night's pull get everything?" and reconstruct STALE / RETRIEVAL-FAILED / INCOMPLETE.
CREATE TABLE IF NOT EXISTS import_log (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL,
  source       TEXT NOT NULL,        -- route:<truck> | bookings | revenue
  ok           INTEGER NOT NULL,     -- 1 = complete success, 0 = failed/partial
  rows_in      INTEGER,
  rows_written INTEGER,
  rows_skipped INTEGER,
  detail       TEXT                  -- error message / partial note
);
CREATE INDEX IF NOT EXISTS idx_import_log_ts ON import_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_import_log_source ON import_log(source, ts DESC);

-- Team members with roles (Owner / Admin / Member) — the access matrix. Passwords are scrypt
-- hashes (never plaintext). Role gates financials, settings, and user management.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT,
  role          TEXT NOT NULL,        -- owner | admin | member
  password_hash TEXT NOT NULL,        -- scrypt$<saltHex>$<hashHex>
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- One-time invite links. An owner/admin creates one with a role; the invitee opens /join?token=…,
-- picks a username + their OWN password, and the account is created with that role (owner never sets
-- a password). Single-use + time-limited. No email is stored — delivery is a copyable link.
CREATE TABLE IF NOT EXISTS invites (
  token            TEXT PRIMARY KEY,   -- the secret in the link (random, URL-safe)
  role             TEXT NOT NULL,      -- role the accepted account gets (admin | member)
  name             TEXT,               -- optional pre-filled display name
  invited_by       TEXT,              -- user id of the creator (attribution)
  invited_by_name  TEXT,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  accepted_at      TEXT,               -- set when redeemed (single-use)
  accepted_user_id TEXT
);

-- Per-event readiness score (0-100) + component breakdown, recomputed each scan.
CREATE TABLE IF NOT EXISTS event_readiness (
  event_id                   TEXT PRIMARY KEY,
  date                       TEXT,
  label                      TEXT,
  score                      INTEGER,
  staffing_score             INTEGER,
  driver_score               INTEGER,
  warehouse_score            INTEGER,
  schedule_score             INTEGER,
  information_score          INTEGER,
  communication_score        INTEGER,
  payment_score              INTEGER,
  special_requirements_score INTEGER,
  risk_level                 TEXT,
  calculated_at              TEXT
);

CREATE TABLE IF NOT EXISTS call_events (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT UNIQUE,   -- OpenPhone call/event id (idempotency)
  event_type    TEXT,          -- OpenPhone webhook type (call.completed, call.summary.completed, …)
  direction     TEXT,          -- incoming | outgoing
  from_phone    TEXT,
  to_phone      TEXT,
  contact_name  TEXT,          -- best-known caller name, if any
  duration_sec  INTEGER,
  transcript    TEXT,          -- full transcript text when available
  summary       TEXT,          -- OpenPhone AI summary when available
  sentiment     TEXT,          -- verdict: positive | neutral | negative
  score         REAL,          -- 0..1 negativity confidence
  method        TEXT,          -- llm | heuristic — HOW the verdict was reached (honesty)
  reasons       TEXT,          -- JSON string[] — why it was flagged
  llm_model     TEXT,          -- model id when method=llm
  alerted_at    TEXT,          -- when a Slack alert fired (null = not alerted)
  occurred_at   TEXT,          -- call time (from OpenPhone), if known
  ts            TEXT NOT NULL  -- when we recorded it
);
CREATE INDEX IF NOT EXISTS idx_call_events_ts ON call_events(ts DESC);

CREATE TABLE IF NOT EXISTS comms_events (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT UNIQUE,   -- OpenPhone message/call id (idempotency)
  lead_id      TEXT,          -- matched booking id (nullable)
  direction    TEXT,          -- inbound | outbound
  channel      TEXT,          -- sms | call
  from_phone   TEXT,
  to_phone     TEXT,
  body         TEXT,          -- message text (sms) or short descriptor (call)
  actor        TEXT,          -- who sent it (rep initials/name) for outbound; null for inbound
  occurred_at  TEXT,          -- provider timestamp
  ts           TEXT NOT NULL  -- when we recorded it
);
CREATE INDEX IF NOT EXISTS idx_comms_lead ON comms_events(lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_comms_ts ON comms_events(ts DESC);

CREATE TABLE IF NOT EXISTS customer_state (
  lead_id        TEXT PRIMARY KEY,
  state          TEXT NOT NULL,   -- NEW | CONTACTED | QUOTED | EVALUATING | PRICE_OBJECTION | ...
  confidence     REAL,            -- 0..1
  evidence       TEXT,            -- the fact/quote the state rests on (FACT vs INFERENCE labelled in reason)
  source         TEXT,            -- goodshuffle | inbound_reply | inactivity | derived
  previous_state TEXT,
  reason         TEXT,            -- why it transitioned
  ts             TEXT NOT NULL    -- when this state was set
);
CREATE INDEX IF NOT EXISTS idx_customer_state_ts ON customer_state(ts DESC);

-- Post-call coaching recaps (Custodian-in-Maestro). One recap per call, keyed by call_events.id;
-- re-analyzing overwrites. recap_json is the CallRecap shape from src/lib/coach/recap.ts. The recap
-- is INFERENCE over the transcript, generated on demand and cached here so we don't re-bill the LLM
-- on every view.
CREATE TABLE IF NOT EXISTS coaching_analyses (
  call_id    TEXT PRIMARY KEY,   -- call_events.id
  recap_json TEXT NOT NULL,      -- CallRecap JSON
  model      TEXT,               -- model that produced it
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lead_status (
  booking_id TEXT PRIMARY KEY,   -- bookings.booking_id
  status     TEXT NOT NULL,      -- Sales OS board column: new | quote_sent | follow_up | action_needed | signed | archived
  updated_at TEXT NOT NULL,
  updated_by TEXT                 -- actor who moved it (attribution)
);

-- Guided Sales Intake: one structured record per sales call. Deterministic capture (rules calculate,
-- no AI). Tri-state logistics preserved as text ('yes'|'no'|'not_sure'|'' unanswered) — UNKNOWN is never
-- collapsed to No. Goodshuffle result fields fill in only once the shell is actually created.
CREATE TABLE IF NOT EXISTS sales_intake (
  id                  TEXT PRIMARY KEY,     -- INTK-<uuid>
  status              TEXT NOT NULL,        -- draft | ready | creating | created | failed
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  created_by          TEXT,                 -- actor label (currentActor)
  source              TEXT,                 -- 'manual' | 'quo'
  call_id             TEXT,                 -- future: linked Quo call id
  first_name          TEXT,
  last_name           TEXT,
  phone               TEXT,
  email               TEXT,
  customer_type       TEXT,                 -- 'commercial' | 'residential'
  event_type          TEXT,                 -- reuse EventType: wedding | corporate | social | other
  event_type_other    TEXT,
  guest_count         INTEGER,              -- null when unknown or unanswered
  guest_count_unknown INTEGER DEFAULT 0,    -- 1 = customer doesn't know (distinct from unanswered)
  event_date          TEXT,                 -- YYYY-MM-DD
  event_start_time    TEXT,                 -- HH:MM
  event_end_time      TEXT,                 -- HH:MM
  venue_name          TEXT,
  street_address      TEXT,
  city                TEXT,
  state               TEXT,
  zip                 TEXT,
  location_type       TEXT,                 -- LEGACY (pre-2026-09-23 intakes): residential | venue | hotel | corporate | school | park | other
  location_class      TEXT,                 -- residential | commercial | venue — the single delivery class (commercial = office, hours-restricted). Replaces customer_type + location_type.
  delivery_required   TEXT,                 -- yes | no | not_sure | ''
  delivery_flexible   TEXT,                 -- yes | no | not_sure | '' (can deliver day before / pick up day after, free)
  delivery_tier       TEXT,                 -- chosen delivery type: standard (flexible day-before, 9AM–8PM) | premium | exact
  delivery_time       TEXT,                 -- LEGACY (superseded by dropoff_time/pickup_time); left in place, no longer written
  dropoff_time        TEXT,                 -- HH:MM same-day drop-off time (premium/exact)
  pickup_time         TEXT,                 -- HH:MM same-day pick-up time (premium/exact)
  setup_required      TEXT,
  pickup_required     TEXT,                 -- repurposed: wants breakdown help → Event Readiness
  access_notes        TEXT,                 -- JSON of the branched logistics answers
  logistics_notes     TEXT,
  sales_notes         TEXT,
  gs_contact_id       TEXT,                 -- Goodshuffle client contactID
  gs_project_id       TEXT,                 -- Goodshuffle project/quote id
  gs_project_url      TEXT,
  gs_status           TEXT,                 -- queued | created | failed | unavailable
  gs_error            TEXT,
  completed_at        TEXT
);

-- Shift Passes — time-limited, revocable, link-based access for contractors / temp workers. A pass is
-- minted by an owner/admin, handed over as a /pass/<token> link (optionally texted via Quo), and grants
-- a scoped "guest" session (dispatch board view + the driver surface; NO money, settings, or supervisor
-- writes). The token IS the id (opaque, unguessable). expires_at is the hard cutoff; revoked_at kills it early.
CREATE TABLE IF NOT EXISTS shift_passes (
  id           TEXT PRIMARY KEY,      -- opaque token, also the URL segment
  name         TEXT NOT NULL,         -- contractor name (attribution + how it reads in the list)
  phone        TEXT,                  -- optional, so we can text them the link via Quo
  scope        TEXT NOT NULL DEFAULT 'drive',  -- 'drive' = view board + drive (only scope for now)
  created_by   TEXT,                  -- actor label who generated it
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,         -- ISO — hard expiry
  revoked_at   TEXT,                  -- ISO — set to kill the pass before it expires (null = live)
  last_seen_at TEXT,                  -- ISO — last time the pass was used (shown in the admin list)
  truck_id     TEXT,                  -- driver pass: pre-assigned truck → link opens straight to its route
  truck_name   TEXT                   -- display label for the assigned truck
);

-- ── Event Radar (early-demand intelligence) ──────────────────────────────────────────────────────
-- Event Radar detects FUTURE events in the DMV that could create rental demand, well before the
-- planner is shopping vendors, and hands qualified opportunities to Sales OS. Design law:
-- "RULES CALCULATE. AI INTERPRETS." These tables store only FACTS (what a source told us, tagged
-- with provenance). Scores, tiers, timing and opportunity value are DERIVED deterministically at
-- read time by the pure engine in src/lib/radar/* — never persisted here, so they can never go stale
-- and are always explainable. We never fabricate a planner, attendance, date or contact: absent =
-- UNKNOWN, never a guess.

-- A source the discovery pipeline can pull from (venue calendars, convention centers, universities,
-- associations, government, nonprofits, directories, public web, search). The MVP seeds events
-- directly; this registry is the plug-in point so a real scraper/fetcher can be added per source
-- without touching the rest of the pipeline.
CREATE TABLE IF NOT EXISTS radar_sources (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- VENUE_CALENDAR | CONVENTION_CENTER | HOTEL | UNIVERSITY | ASSOCIATION | GOVERNMENT | NONPROFIT | DIRECTORY | PUBLIC_WEB | SEARCH
  url          TEXT,
  region       TEXT,                 -- DMV sub-area this source covers
  enabled      INTEGER DEFAULT 1,
  adapter      TEXT,                 -- key of the ingestion adapter (e.g. "seed") — null = not yet wired
  last_run_at  TEXT,
  last_status  TEXT,                 -- OK | ERROR | NEVER_RUN
  is_seed      INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- The organization behind an event (the association / company / university / agency). Verification
-- status distinguishes a confirmed org from an inferred one.
CREATE TABLE IF NOT EXISTS radar_organizations (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  website             TEXT,
  org_type            TEXT,          -- ASSOCIATION | CORPORATE | UNIVERSITY | GOVERNMENT | NONPROFIT | AGENCY | VENUE | OTHER
  verification_status TEXT NOT NULL, -- VERIFIED | INFERRED | UNKNOWN
  notes               TEXT,
  is_seed             INTEGER DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- A recurring event SERIES (e.g. "CHD Conference"). Individual radar_events point to their series via
-- parent_series_id. Recurrence confidence and cadence are derived from the historical instances but
-- cached here as the series' summary; a future instance is NEVER fabricated — it is only ever labelled
-- PREDICTED/UNANNOUNCED in the derived view with its supporting evidence.
CREATE TABLE IF NOT EXISTS radar_series (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  organization_id       TEXT,
  category              TEXT,
  cadence               TEXT,        -- ANNUAL | BIENNIAL | QUARTERLY | MONTHLY | IRREGULAR | UNKNOWN
  recurrence_confidence TEXT,        -- HIGH | MEDIUM | LOW
  notes                 TEXT,
  is_seed               INTEGER DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- A detected event. FACTS ONLY. dedupe_key is the stable identity (same event across re-pulls updates
-- in place, never duplicates). attributes_json holds the rental-relevant signal facts as a map of
-- signal→status (PRESENT | ABSENT | UNKNOWN) exactly as the source reported them; the qualification
-- engine turns those + the structural facts (dates, geography, attendance, recurrence) into a score.
CREATE TABLE IF NOT EXISTS radar_events (
  id                    TEXT PRIMARY KEY,
  dedupe_key            TEXT UNIQUE NOT NULL,
  name                  TEXT NOT NULL,
  description           TEXT,
  category              TEXT NOT NULL,       -- CONFERENCE | ASSOCIATION_MEETING | CORPORATE | TRADE_SHOW | EXPO | GALA | FUNDRAISER | GOVERNMENT | UNIVERSITY | NONPROFIT | MEDICAL | NETWORKING | AWARDS | OUTDOOR_RECEPTION | HOSPITALITY | OTHER
  start_date            TEXT,                -- YYYY-MM-DD (null if unannounced/unknown)
  end_date              TEXT,                -- YYYY-MM-DD (null → single day or unknown)
  venue                 TEXT,
  address               TEXT,
  city                  TEXT,
  state                 TEXT,
  region                TEXT,                -- normalized DMV sub-area (see radar/geo)
  source_id             TEXT,
  source_name           TEXT,
  source_url            TEXT,
  discovered_at         TEXT NOT NULL,
  last_verified_at      TEXT,
  verification_status   TEXT NOT NULL,       -- VERIFIED | INFERRED | UNKNOWN | NOT_YET_VERIFIED
  expected_attendance   INTEGER,             -- null = unknown (never guessed)
  attendance_confidence TEXT,                -- VERIFIED | INFERRED | UNKNOWN
  recurring             INTEGER DEFAULT 0,   -- 1 = part of a known series
  recurrence_confidence TEXT,                -- HIGH | MEDIUM | LOW | NONE
  parent_series_id      TEXT,
  event_status          TEXT NOT NULL,       -- DETECTED | QUALIFYING | QUALIFIED | HANDED_OFF | ARCHIVED
  organization_id       TEXT,
  planner_status        TEXT NOT NULL,       -- VERIFIED | INFERRED | UNKNOWN
  sales_status          TEXT NOT NULL,       -- NONE | OPPORTUNITY_CREATED | LINKED
  attributes_json       TEXT,                -- {signalKey: "PRESENT"|"ABSENT"|"UNKNOWN"}
  is_seed               INTEGER DEFAULT 0,   -- 1 = DEMO/SEED data (never mistaken for verified prod data)
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_radar_events_date ON radar_events(start_date);
CREATE INDEX IF NOT EXISTS idx_radar_events_series ON radar_events(parent_series_id);
CREATE INDEX IF NOT EXISTS idx_radar_events_org ON radar_events(organization_id);

-- A planner / event contact, at the org or event grain. NEVER invented: a row exists only when a
-- source gives us a real name. contact_status separates a verified contact from an inferred one; when
-- no planner is known there is simply NO row (the event's planner_status stays UNKNOWN and the UI shows
-- "RESEARCH ORGANIZER").
CREATE TABLE IF NOT EXISTS radar_planners (
  id              TEXT PRIMARY KEY,
  organization_id TEXT,
  event_id        TEXT,
  name            TEXT NOT NULL,
  role            TEXT,
  email           TEXT,
  phone           TEXT,
  agency          TEXT,               -- production company / planning agency, if via one
  contact_status  TEXT NOT NULL,      -- VERIFIED | INFERRED | UNKNOWN
  confidence      REAL,               -- 0..1
  evidence        TEXT,               -- the fact this planner rests on (source/quote)
  is_seed         INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_radar_planners_event ON radar_planners(event_id);
CREATE INDEX IF NOT EXISTS idx_radar_planners_org ON radar_planners(organization_id);

-- The handoff to Sales OS. Creating an opportunity does NOT duplicate the event — the radar_event
-- stays the source record; this row is the bridge. booking_id links to a real Goodshuffle booking once
-- one materializes (client actually enters the pipeline); until then it stands alone as an EARLY
-- opportunity awaiting a real quote. One row per event.
CREATE TABLE IF NOT EXISTS radar_opportunities (
  id           TEXT PRIMARY KEY,
  event_id     TEXT UNIQUE NOT NULL,
  status       TEXT NOT NULL,         -- CREATED | LINKED | ARCHIVED
  booking_id   TEXT,                  -- Goodshuffle booking id once linked (null = early, pre-pipeline)
  next_action  TEXT,
  note         TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ── Opportunity Radar (opportunity intelligence engine) ──────────────────────────────────────────
-- Event Radar reframed + broadened. Event Radar and Procurement Radar (and web/facility signals) all
-- feed ONE unified Opportunity Intelligence layer: the opportunities spine below. Domain-specific
-- raw facts live in satellite tables (radar_events already exists for events; radar_procurements is
-- new). Same design law as everything else: FACTS ONLY here; relevance/opportunity SCORES, signal
-- maturity and timing are DERIVED deterministically at read time by src/lib/opportunity/* — never
-- persisted, never stale, always explainable. AI only interprets; it never fabricates or scores.

-- The unified Opportunity Intelligence Record. Every discovery (an event, a procurement notice, a
-- facility/web signal) normalizes into one row. kind says which; event_id/procurement_id link to the
-- satellite with the raw facts. dedupe_key is the stable identity (a re-pull updates in place).
CREATE TABLE IF NOT EXISTS opportunities (
  id                  TEXT PRIMARY KEY,
  dedupe_key          TEXT UNIQUE NOT NULL,
  kind                TEXT NOT NULL,        -- EVENT | PROCUREMENT | FACILITY_SIGNAL | WEB_SIGNAL
  name                TEXT NOT NULL,
  description         TEXT,
  source_id           TEXT,
  source_name         TEXT,
  source_url          TEXT,                 -- ALWAYS preserved (provenance)
  jurisdiction        TEXT,                 -- FEDERAL | STATE_MD | DC | MONTGOMERY_CO | ROCKVILLE | GAITHERSBURG | PRINCE_GEORGES_CO | HOWARD_CO | BALTIMORE | NOVA | OTHER | UNKNOWN
  region              TEXT,                 -- normalized DMV sub-area (radar geo Region)
  city                TEXT,
  state               TEXT,
  organization        TEXT,                 -- buyer/organizer name (denormalized convenience)
  estimated_date      TEXT,                 -- YYYY-MM-DD event/project date (nullable)
  deadline            TEXT,                 -- YYYY-MM-DD procurement response deadline (nullable)
  discovered_at       TEXT NOT NULL,
  last_reviewed_at    TEXT,
  next_action_date    TEXT,
  stage               TEXT NOT NULL,        -- lifecycle: DISCOVERED | VALIDATED | RELEVANT | RESEARCHING | TARGET_IDENTIFIED | OUTREACH_READY | CONTACTED | ENGAGED | OPPORTUNITY | QUOTED | WON | LOST | ARCHIVED
  stage_source        TEXT,                 -- auto | manual (manual override wins, like lead_status)
  status              TEXT,                 -- raw source status (open | awarded | closed)
  est_value_low       REAL,
  est_value_high      REAL,
  zoe_categories      TEXT,                 -- JSON string[] (tent, tables, chairs, flooring, linens, ...)
  verification_status TEXT,                 -- VERIFIED | INFERRED | UNKNOWN | NOT_YET_VERIFIED
  confidence          REAL,
  event_id            TEXT,                 -- radar_events.id when kind=EVENT
  procurement_id      TEXT,                 -- radar_procurements.id when kind=PROCUREMENT
  campaign_id         TEXT,
  booking_id          TEXT,                 -- Goodshuffle booking once linked (Sales OS handoff)
  sales_status        TEXT NOT NULL,        -- NONE | OPPORTUNITY_CREATED | LINKED
  recommended_action  TEXT,
  is_seed             INTEGER DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunities_stage ON opportunities(stage);
CREATE INDEX IF NOT EXISTS idx_opportunities_kind ON opportunities(kind);
CREATE INDEX IF NOT EXISTS idx_opportunities_date ON opportunities(estimated_date);
CREATE INDEX IF NOT EXISTS idx_opportunities_deadline ON opportunities(deadline);
CREATE INDEX IF NOT EXISTS idx_opportunities_event ON opportunities(event_id);

-- Procurement facts (solicitations/awards) — the satellite for kind=PROCUREMENT, analogous to
-- radar_events for kind=EVENT. Preserves the solicitation number + source URL.
CREATE TABLE IF NOT EXISTS radar_procurements (
  id                  TEXT PRIMARY KEY,
  dedupe_key          TEXT UNIQUE NOT NULL,
  solicitation_number TEXT,
  notice_type         TEXT,                 -- SOURCES_SOUGHT | RFI | PRESOLICITATION | IFB | RFP | RFQ | AWARD | OTHER
  title               TEXT,
  description         TEXT,
  agency              TEXT,
  sub_agency          TEXT,
  jurisdiction        TEXT,
  naics               TEXT,
  psc                 TEXT,
  set_aside           TEXT,
  posted_date         TEXT,
  response_deadline   TEXT,
  archive_date        TEXT,
  award_amount        REAL,
  awardee             TEXT,
  award_date          TEXT,
  city                TEXT,
  state               TEXT,
  source_id           TEXT,
  source_url          TEXT,
  is_seed             INTEGER DEFAULT 0,
  discovered_at       TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- The relationship-graph NODES: companies/agencies/contacts connected to opportunities (§7/§8). Only
-- publicly-available business information. matched_customer_key links an entity to Zoe's existing
-- Sales OS customer history (§17) — the key is the same identity key aggregateCustomers uses.
CREATE TABLE IF NOT EXISTS radar_entities (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL,       -- AGENCY | PRIME | EVENT_PLANNER | FACILITIES | PRODUCTION | CATERING | VENDOR | PARTNER | CONTACT | UNKNOWN
  website              TEXT,
  email                TEXT,
  phone                TEXT,
  jurisdiction         TEXT,
  verification_status  TEXT NOT NULL,       -- VERIFIED | INFERRED | UNKNOWN
  matched_customer_key TEXT,                -- identity key into Sales OS customer history if matched
  notes                TEXT,
  is_seed              INTEGER DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- The relationship-graph EDGES: which entity plays which role on which opportunity, and whether it's
-- the recommended primary target (§7 "who is the most useful person/company for Zoe to approach?").
CREATE TABLE IF NOT EXISTS opportunity_entities (
  id                TEXT PRIMARY KEY,
  opportunity_id    TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  relationship      TEXT NOT NULL,          -- DIRECT_BUYER | PRIME_CONTRACTOR | EVENT_PLANNER | FACILITIES_CONTRACTOR | EVENT_MGMT | PRODUCTION | VENDOR | PARTNER | PROCUREMENT_CONTACT | UNKNOWN
  is_primary_target INTEGER DEFAULT 0,
  confidence        REAL,
  evidence          TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE(opportunity_id, entity_id, relationship)
);
CREATE INDEX IF NOT EXISTS idx_opp_entities_opp ON opportunity_entities(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_opp_entities_entity ON opportunity_entities(entity_id);

-- Outreach campaigns (§11): a named grouping of opportunities with target criteria. Membership is via
-- opportunities.campaign_id. Metrics (emails/calls/responses/revenue) are DERIVED, not stored here.
CREATE TABLE IF NOT EXISTS radar_campaigns (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  criteria     TEXT,                        -- JSON target criteria
  created_by   TEXT,
  is_seed      INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- AI INTERPRETATION cache (Phase 3). The deterministic engines always run for free; the LLM only
-- INTERPRETS (what is this about, what to research, draft outreach) and its output is cached here so we
-- do not re-bill on every view. Keyed by opportunity + interpretation kind. method records llm vs the
-- deterministic fallback (honesty). Absent row = not generated yet.
CREATE TABLE IF NOT EXISTS opportunity_ai (
  id            TEXT PRIMARY KEY,            -- <opportunityId>:<kind>
  opportunity_id TEXT NOT NULL,
  kind          TEXT NOT NULL,               -- summary | research | outreach
  content       TEXT NOT NULL,               -- JSON payload for the kind
  method        TEXT NOT NULL,               -- llm | template (deterministic fallback)
  model         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunity_ai_opp ON opportunity_ai(opportunity_id);

-- Outreach drafts (Phase 5). DETECT → DRAFT → HUMAN APPROVAL → SEND → TRACK. A draft is generated
-- (deterministic template floor + optional AI refine), a human approves/edits, and only then is it
-- marked sent (recorded — no automated blast). One row per opportunity+target+channel draft.
CREATE TABLE IF NOT EXISTS opportunity_outreach (
  id            TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  entity_id     TEXT,                        -- the target entity (null = generic)
  channel       TEXT NOT NULL,               -- email | call | sms | linkedin
  subject       TEXT,
  body          TEXT,
  call_script   TEXT,
  follow_ups    TEXT,                        -- JSON string[] cadence
  reason        TEXT,                        -- why we're reaching out
  status        TEXT NOT NULL,               -- draft | approved | sent | skipped
  source        TEXT NOT NULL,               -- template | ai
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_opportunity_outreach_opp ON opportunity_outreach(opportunity_id, created_at DESC);

-- Alert idempotency (§18). One row per (opportunity, alert kind) so a meaningful signal is Slack-posted
-- at most once, ever — no notification spam on re-pulls.
CREATE TABLE IF NOT EXISTS opportunity_alerts (
  alert_key      TEXT PRIMARY KEY,           -- <opportunityId>:<kind>[:<detail>]
  opportunity_id TEXT,
  kind           TEXT NOT NULL,
  detail         TEXT,
  ts             TEXT NOT NULL
);

-- ── Prospecting (cold outreach BEFORE Goodshuffle) ───────────────────────────────────────────────
-- Enriched, qualified opportunities are routed into a PROSPECTING motion (the SDR/BDR cadence model),
-- NOT Goodshuffle. Goodshuffle is reserved for CONVERSION — only once a prospect responds. Routing is
-- tiered by the deterministic opportunity score: Tier A = call-first (a rep task queue), Tier B =
-- cold-email sequence (exported to a dedicated sequencer / warmed domain), Tier C = monitor. Cadence
-- templates live in code; enrollments + the materialized tasks live here.

-- One enrollment = one opportunity being worked through one cadence toward one target company/contact.
CREATE TABLE IF NOT EXISTS prospect_enrollments (
  id             TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  entity_id      TEXT,                        -- the target company/contact
  tier           TEXT NOT NULL,               -- A | B | C
  cadence_key    TEXT NOT NULL,               -- which cadence template
  channel        TEXT NOT NULL,               -- call | email | monitor (primary channel)
  status         TEXT NOT NULL,               -- active | paused | replied | completed | stopped
  owner          TEXT,
  next_action_at TEXT,                        -- when the next task is due
  started_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE(opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_prospect_enroll_status ON prospect_enrollments(status, next_action_at);

-- The rep worklist: dated touches materialized from a cadence. A call task carries a script; an email
-- task carries subject/body (and can be exported to the sequencer). Outcome is logged by a human.
CREATE TABLE IF NOT EXISTS prospect_tasks (
  id             TEXT PRIMARY KEY,
  enrollment_id  TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  entity_id      TEXT,
  channel        TEXT NOT NULL,               -- call | email | linkedin | task
  step_index     INTEGER NOT NULL,
  due_at         TEXT NOT NULL,               -- YYYY-MM-DD
  status         TEXT NOT NULL,               -- pending | done | skipped
  subject        TEXT,
  body           TEXT,
  script         TEXT,
  outcome        TEXT,                        -- connected | voicemail | no_answer | sent | bounced | replied | not_interested | meeting
  completed_by   TEXT,
  completed_at   TEXT,
  exported_at    TEXT,                        -- when an email step was pushed to the sequencer / CSV
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prospect_tasks_due ON prospect_tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_prospect_tasks_enroll ON prospect_tasks(enrollment_id, step_index);

-- Do-not-contact / suppression (compliance + hygiene). An email, domain or company here is never
-- enrolled or exported.
CREATE TABLE IF NOT EXISTS prospect_suppression (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                  -- email | domain | company
  value       TEXT NOT NULL,                  -- lowercased match value
  reason      TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(kind, value)
);

-- Marketing module — Zoe's demand-generation OS. The app is the operating dashboard over the tools the
-- team already runs (Confluence for content planning, a social poster, ManyChat, Google Business); these
-- tables hold what the team plans and tracks in-app. FACTS the team enters; no fabrication.
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  objective     TEXT,                 -- what this campaign is for (awareness, leads, bookings)
  channels      TEXT,                 -- JSON string[] from the team's channel set
  audience      TEXT,                 -- b2c | b2b | both
  status        TEXT NOT NULL,        -- idea | planned | live | paused | done
  budget        REAL,                 -- planned spend, dollars
  spend         REAL,                 -- actual spend, dollars
  start_date    TEXT,                 -- YYYY-MM-DD
  end_date      TEXT,                 -- YYYY-MM-DD
  goal_metric   TEXT,                 -- free text goal (e.g. "20 wedding leads")
  result_leads     INTEGER,           -- team-entered outcomes
  result_bookings  INTEGER,
  result_revenue   REAL,
  link          TEXT,
  notes         TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS marketing_content (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  channel       TEXT,                 -- social | email | blog | reviews | other
  format        TEXT,                 -- e.g. reel, carousel, newsletter, blog post
  plan_date     TEXT,                 -- YYYY-MM-DD the piece is planned/scheduled for
  status        TEXT NOT NULL,        -- idea | drafting | scheduled | posted
  audience      TEXT,                 -- b2c | b2b | both
  owner         TEXT,
  link          TEXT,                 -- Confluence page, draft, or the live post
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS marketing_reviews (
  id            TEXT PRIMARY KEY,
  source        TEXT,                 -- google | the_knot | wedding_wire | yelp | facebook | other
  reviewer      TEXT,
  rating        INTEGER,              -- 1..5
  review_date   TEXT,                 -- YYYY-MM-DD
  text          TEXT,
  responded     INTEGER NOT NULL DEFAULT 0,
  response_note TEXT,
  link          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- Outreach prospects — the people/orgs the team is reaching out to BEFORE Goodshuffle. Marketing owns
-- this top-of-funnel; the win is "quote agreed" (they cross into Goodshuffle, then Sales OS takes over).
-- Goodshuffle leads are deliberately NOT tracked here — once in Goodshuffle they are already engaged.
CREATE TABLE IF NOT EXISTS marketing_prospects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  contact       TEXT,                 -- email / phone / handle
  audience      TEXT,                 -- b2c | b2b | both
  source        TEXT,                 -- referral | instagram | facebook | google | the_knot | wedding_wire | website | venue_partner | cold | other
  status        TEXT NOT NULL,        -- to_contact | contacted | responded | quote_agreed (WIN) | not_interested (lost)
  campaign_id   TEXT,                 -- optional link to a marketing_campaigns row
  owner         TEXT,
  next_action   TEXT,                 -- YYYY-MM-DD
  notes         TEXT,
  won_at        TEXT,                 -- ISO — set when status became quote_agreed
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ── Post-Event Customer Experience (service recovery + review workflow) ───────────────────────────
-- Human-first post-event follow-up. This is NOT a review harvester: a review is the OUTCOME of a
-- confirmed good experience, never the objective. Same platform law as the rest: RULES CALCULATE, AI
-- INTERPRETS. The deterministic engine computes eligibility, funnel state and metrics; AI may only ever
-- SUGGEST a disposition from a REAL transcript. We never fabricate a contact, a review, sentiment or a
-- metric. The Goodshuffle project stays the commercial source of truth — these tables REFERENCE it by id
-- (postevent_projects.booking_id === bookings.booking_id === the event tx_id) and never copy it.

-- One workflow row per eligible completed event, keyed by the Goodshuffle booking id. Every project
-- always has a KNOWN state. stage_entered_at powers aging/SLA; closure_reason is required on close.
CREATE TABLE IF NOT EXISTS postevent_projects (
  booking_id        TEXT PRIMARY KEY,   -- Goodshuffle project id (= event tx_id); commercial row lives in bookings
  state             TEXT NOT NULL,      -- needs_follow_up | follow_up_in_progress | customer_responded | experience_confirmed | review_requested | review_completed | closed
  disposition       TEXT,               -- positive | positive_minor | issue | serious_issue | mixed_neutral | unable | null(unset)
  next_action       TEXT,               -- derived cache: call | sms | await_response | review_feedback | escalate | follow_resolution | send_review_request | close | none
  assigned_employee TEXT,               -- who owns the follow-up (actor label); nullable
  event_date        TEXT,               -- denormalized for board/aging (YYYY-MM-DD)
  pickup_at         TEXT,               -- when pickup/route completed (eligibility anchor); ISO
  eligible_at       TEXT NOT NULL,      -- when it entered the workflow (Needs Follow-Up)
  stage_entered_at  TEXT NOT NULL,      -- when it entered its CURRENT state (aging/SLA)
  closure_reason    TEXT,               -- structured reason — required on close
  closure_note      TEXT,               -- required when closure_reason = 'other'
  closed_at         TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_postevent_state ON postevent_projects(state, event_date);

-- Structured state-transition audit — one row per move (drag or programmatic). Actor + timestamp always;
-- a visual move is never just visual. actor='system' for the auto-eligibility/auto-advance writes.
CREATE TABLE IF NOT EXISTS postevent_transitions (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  actor       TEXT,
  note        TEXT,
  ts          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_postevent_transitions_bk ON postevent_transitions(booking_id, ts);

-- Contact attempts. AUTO-populated from comms_events (source='comms', idempotent via dedupe_key) AND
-- manually logged (source='manual'). Attempted vs Successful vs Responded are DIFFERENT metrics, kept
-- distinct via outcome + direction — never collapsed.
CREATE TABLE IF NOT EXISTS postevent_contacts (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL,
  occurred_at TEXT NOT NULL,       -- date/time of the attempt (ISO)
  channel     TEXT NOT NULL,       -- phone | voicemail | sms | email | other
  employee    TEXT,                -- who made the attempt (actor label / rep)
  outcome     TEXT NOT NULL,       -- no_answer | left_voicemail | customer_responded | requested_callback | unavailable | positive | issue_reported | other
  direction   TEXT,                -- outbound | inbound
  notes       TEXT,
  source      TEXT NOT NULL,       -- manual | comms
  dedupe_key  TEXT UNIQUE,         -- auto rows (e.g. 'comms:<provider_id>'); null for manual
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_postevent_contacts_bk ON postevent_contacts(booking_id, occurred_at);

-- Review request + receipt records. A request is a HUMAN action (recorded, optionally sent). A received
-- review is logged when we learn of it (manual today; a directory pull can set it later). Kept separate
-- from marketing_reviews (that is public-reputation tracking; this is the per-project funnel outcome).
CREATE TABLE IF NOT EXISTS postevent_reviews (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,      -- requested | received
  occurred_at  TEXT NOT NULL,      -- ISO
  employee     TEXT,               -- who requested (attribution)
  channel      TEXT,               -- sms | email | in_person | other
  destination  TEXT,               -- review destination label/url used (from settings)
  message      TEXT,               -- the message/template sent
  rating       INTEGER,            -- received: 1..5 if known
  link         TEXT,               -- received: link to the posted review if known
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_postevent_reviews_bk ON postevent_reviews(booking_id, occurred_at);

-- Service-recovery issues. One (or more) per project when an issue is identified. Its own lifecycle:
-- identified -> escalated -> resolution_in_progress -> resolution_completed -> customer_follow_up -> closed.
CREATE TABLE IF NOT EXISTS postevent_issues (
  id                TEXT PRIMARY KEY,
  booking_id        TEXT NOT NULL,
  issue_type        TEXT,           -- damage | late | missing | staff | billing | quality | other
  description       TEXT,
  state             TEXT NOT NULL,  -- identified | escalated | resolution_in_progress | resolution_completed | customer_follow_up | closed
  escalation_level  TEXT,           -- none | supervisor | management | owner
  assigned_employee TEXT,
  resolution        TEXT,
  refund_credit     REAL,           -- dollars, nullable
  resolution_at     TEXT,
  final_response    TEXT,           -- final customer response
  closure_reason    TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_postevent_issues_bk ON postevent_issues(booking_id, state);

-- ── Creative Engine (AI-directed creative production) ─────────────────────────────────────────────
-- A professional creative-production pipeline. Platform law: AI CREATES, RULES CONSTRAIN, AI EVALUATES,
-- HUMANS APPROVE. The user defines WHAT; the Art Director (src/lib/creative/*) deterministically composes
-- the Image Brief from the centralized Zoe Visual DNA (settings KV) + the job so every image reads like
-- the same in-house team. Model-agnostic: the image provider is swappable; a mock provider makes the whole
-- lifecycle testable with no external key. We NEVER fabricate a QA score or pass a placeholder off as a
-- real Zoe photo (generations carry a placeholder flag).

-- One creative job = one asset moving through the lifecycle. image_brief stores WHY an image was generated
-- (the structured brief). preserve/transform are the reference-first constraint arrays (JSON string[]).
CREATE TABLE IF NOT EXISTS creative_jobs (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  campaign             TEXT,
  page                 TEXT,
  section              TEXT,
  asset_type           TEXT NOT NULL,      -- hero | product | lifestyle | detail | editorial | social | email | advertising
  product              TEXT,
  product_category     TEXT,
  source_mode          TEXT NOT NULL,      -- upload | existing | scratch
  source_image_id      TEXT,               -- creative_images.id (reference-first source of truth)
  reference_image_ids  TEXT,               -- JSON string[] of creative_images.id
  aspect_ratio         TEXT NOT NULL,      -- 16:9 | 4:3 | 3:2 | 1:1 | 4:5 | 9:16
  target_audience      TEXT,
  objective            TEXT,
  season               TEXT,
  location_context     TEXT,
  visual_direction     TEXT,
  preserve             TEXT,               -- JSON string[] — kept from the source (never invented away)
  transform            TEXT,               -- JSON string[] — the AI may change these
  status               TEXT NOT NULL,      -- draft | queued | generating | qa | needs_revision | awaiting_approval | approved | rejected | published
  selected_model       TEXT,
  generation_count     INTEGER NOT NULL DEFAULT 0,
  qa_score             INTEGER,            -- latest generation's QA score (0..100), null until QC runs
  image_brief          TEXT,               -- JSON ImageBrief (the WHY)
  approved_generation_id TEXT,
  approved_asset_path  TEXT,               -- served path of the saved, approved asset
  created_by           TEXT,               -- currentActor label (attribution)
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creative_jobs_status ON creative_jobs(status, updated_at DESC);

-- Each generation attempt against a job. brief_snapshot freezes the brief used; qa_report is the
-- structured deterministic QC (a real vision model can populate the same shape later). placeholder=1 means
-- the mock provider produced it (clearly NOT a real Zoe photo).
CREATE TABLE IF NOT EXISTS creative_generations (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL,
  attempt        INTEGER NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT,
  brief_snapshot TEXT,                     -- JSON ImageBrief at generation time
  image_id       TEXT,                     -- creative_images.id of the produced image
  result_path    TEXT,                     -- served path of the produced image
  placeholder    INTEGER NOT NULL DEFAULT 0,
  result_meta    TEXT,                     -- JSON provider metadata
  qa_score       INTEGER,
  qa_report      TEXT,                     -- JSON QaReport
  status         TEXT NOT NULL,            -- generating | pass | fail | error | approved | rejected
  callback_token TEXT,                     -- async providers (n8n): per-generation callback credential
  external_ref   TEXT,                     -- async providers: the provider's run id (n8n execution id)
  callback_claimed_at TEXT,                -- async: set once when a callback claims this pending row (idempotency guard)
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creative_generations_job ON creative_generations(job_id, attempt DESC);

-- Image records: uploaded photos, existing library images, and generated results. path is the served URL
-- (/api/creative/image/<id>). placeholder=1 = a generated placeholder, never a real Zoe photo.
CREATE TABLE IF NOT EXISTS creative_images (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,               -- upload | existing | generated
  name       TEXT,
  path       TEXT NOT NULL,               -- served URL
  file_path  TEXT,                        -- on-disk path (server only; not exposed)
  mime       TEXT,
  width      INTEGER,
  height     INTEGER,
  placeholder INTEGER NOT NULL DEFAULT 0,
  job_id     TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creative_images_kind ON creative_images(kind, created_at DESC);

-- Attributed lifecycle audit — one row per state change / action (created, brief_built, generated, qa,
-- approved, rejected, revision, published). Every change names who did it (currentActor) or 'system'.
CREATE TABLE IF NOT EXISTS creative_events (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  actor       TEXT,
  note        TEXT,
  ts          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creative_events_job ON creative_events(job_id, ts);
`;

type DB = InstanceType<typeof Database>;

const g = globalThis as unknown as { __aiopsDb?: DB };

// Additive column migrations for DBs created before a column existed. Each is
// idempotent — skipped if the column is already present.
const MIGRATIONS: Array<{ table: string; column: string; type: string }> = [
  { table: "stops", column: "cust_first_name", type: "TEXT" }, // customer's real first name, for greetings
  { table: "stops", column: "kind", type: "TEXT" }, // "delivery" | "pickup" (from Goodshuffle waypointType)
  { table: "stops", column: "items", type: "TEXT" }, // JSON [{name, quantity}] — event line items (crew rules)
  { table: "stops", column: "tx_id", type: "TEXT" }, // Goodshuffle waypoint transactionID (write-back match key)
  { table: "stops", column: "cust_last_name", type: "TEXT" }, // customer's real last name (renter), for "First Last" display
  { table: "stops", column: "contact_id", type: "TEXT" }, // Goodshuffle client contactID — stable customer identity (MVP6)
  { table: "routes", column: "gs_route_id", type: "TEXT" }, // Goodshuffle routeID (write-back target)
  { table: "routes", column: "driver_name", type: "TEXT" }, // Dispatch-assigned driver name (Connecteam person)
  { table: "event_readiness", column: "route_id", type: "TEXT" }, // route the event's stops sit on (readiness detail matching)
  { table: "stops", column: "day_of_name", type: "TEXT" },
  { table: "stops", column: "day_of_phone", type: "TEXT" },
  { table: "stops", column: "photos_ref", type: "TEXT" }, // JSON array of POD photo ids
  { table: "stops", column: "signature_ref", type: "TEXT" }, // POD signature image id
  { table: "bookings", column: "quote_sent_date", type: "TEXT" }, // YYYY-MM-DD — when the quote was sent (Sales OS quote age)
  { table: "bookings", column: "date_created", type: "TEXT" }, // YYYY-MM-DD — lead/project created (lead age)
  { table: "bookings", column: "client_phone", type: "TEXT" }, // customer phone (Sales OS SMS/call)
  { table: "bookings", column: "loss_reason", type: "TEXT" }, // team-tagged reason a quote was lost (Goodshuffle has none)
  { table: "bookings", column: "loss_reason_at", type: "TEXT" }, // when the loss reason was recorded
  { table: "bookings", column: "venue", type: "TEXT" }, // Goodshuffle venueLabel — for win-rate-by-venue
  { table: "bookings", column: "location", type: "TEXT" }, // Goodshuffle cityStateZipCounty — for win-rate-by-area (DC/MD/VA)
  { table: "bookings", column: "internal_notes", type: "TEXT" }, // GS internalNotes — the team's call/text/email log (comms history)
  { table: "bookings", column: "client_notes", type: "TEXT" }, // GS clientVisibleNotes — client-facing context (e.g. "on leave")
  { table: "bookings", column: "last_sent_date", type: "TEXT" }, // GS dateLastSent — when the quote/contract was last emailed
  { table: "bookings", column: "notes_updated_at", type: "TEXT" }, // when we last captured this lead's notes
  { table: "call_events", column: "note_logged_at", type: "TEXT" }, // when we queued a GS note for this call (dedupe)
  { table: "users", column: "openphone_user_id", type: "TEXT" }, // links a rep's login to their Quo user (sender attribution)
  { table: "call_events", column: "coaching_attempted_at", type: "TEXT" }, // set when a recap was tried but couldn't be generated (skip in backfill, don't wedge it)
  { table: "call_events", column: "name_attempted_at", type: "TEXT" }, // last time we tried (and failed) to resolve a name — throttles the name-enrichment loop, retried after a cooldown
  { table: "bookings", column: "line_items", type: "TEXT" }, // JSON string[] of line-item titles (event-type classification)
  { table: "bookings", column: "wd_member_added", type: "TEXT" }, // ISO ts once Warehouse Desktop was queued onto a signed project's GSPRO team (add-once)
  { table: "sales_intake", column: "delivery_tier", type: "TEXT" }, // delivery time-window tier (standard/premium/exact)
  { table: "sales_intake", column: "delivery_flexible", type: "TEXT" }, // can deliver day before / pick up day after (free)
  { table: "bookings", column: "quote_sent_at", type: "TEXT" }, // ISO — precise time the quote email was sent (from GS message thread)
  { table: "bookings", column: "quote_opened_at", type: "TEXT" }, // ISO — latest time the client opened the quote email
  { table: "bookings", column: "quote_open_alerted_at", type: "TEXT" }, // ISO — the opened_at we last Slack-alerted for (dedupe)
  { table: "shift_passes", column: "truck_id", type: "TEXT" }, // driver pass: pre-assigned truck → link opens straight to its route
  { table: "shift_passes", column: "truck_name", type: "TEXT" }, // display label for the assigned truck (admin list + callout)
  // Opportunity Radar — source registry (§14) additive columns on the existing radar_sources table.
  { table: "radar_sources", column: "acquisition_method", type: "TEXT" }, // API | BROWSER | MANUAL — how records are pulled
  { table: "radar_sources", column: "auth_status", type: "TEXT" }, // NONE | REQUIRED_OK | REQUIRED_MISSING (e.g. API key present?)
  { table: "radar_sources", column: "frequency", type: "TEXT" }, // human cadence, e.g. "daily", "weekly"
  { table: "radar_sources", column: "parser_version", type: "TEXT" }, // bump when an adapter's parsing changes
  { table: "radar_sources", column: "records_discovered", type: "INTEGER" }, // count from the last successful run
  { table: "radar_sources", column: "last_failure_at", type: "TEXT" }, // ISO of the last failed run
  { table: "opportunities", column: "expected_attendance", type: "INTEGER" }, // known/estimated size (drives the size score) — from a source or manual import
  { table: "opportunities", column: "attendance_confidence", type: "TEXT" }, // VERIFIED | INFERRED | UNKNOWN
  // Creative Engine async providers (n8n): per-generation callback credential + the provider's run id.
  { table: "creative_generations", column: "callback_token", type: "TEXT" },
  { table: "creative_generations", column: "external_ref", type: "TEXT" },
  { table: "creative_generations", column: "callback_claimed_at", type: "TEXT" }, // callback idempotency claim

  // Intake: single delivery class (residential | commercial | venue) replacing customer_type + location_type.
  { table: "sales_intake", column: "location_class", type: "TEXT" },
  // Intake: target delivery time for a same-day (premium/exact) window.
  { table: "sales_intake", column: "delivery_time", type: "TEXT" },
  // Intake: split same-day window into explicit drop-off + pick-up times.
  { table: "sales_intake", column: "dropoff_time", type: "TEXT" },
  { table: "sales_intake", column: "pickup_time", type: "TEXT" },
];

function migrate(db: DB): void {
  for (const m of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.type}`);
    }
  }
}

function open(): DB {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Wait (not throw SQLITE_BUSY) if a second connection holds a lock — e.g. a backup tool,
  // litestream, a WAL checkpoint, or a CLI session.
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  ensureIndexes(db);
  return db;
}

// Indexes on hot filter/sort columns. Run AFTER migrate() because some (stops.tx_id, contact_id)
// are added by the additive migrations, so they don't exist when SCHEMA runs.
function ensureIndexes(db: DB): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_stops_tx ON stops(tx_id);
    CREATE INDEX IF NOT EXISTS idx_stops_contact ON stops(contact_id);
    CREATE INDEX IF NOT EXISTS idx_routes_date ON routes(date);
    CREATE INDEX IF NOT EXISTS idx_messages_sent ON messages(sent_at DESC);
  `);
}

export function getDb(): DB {
  return (g.__aiopsDb ??= open());
}

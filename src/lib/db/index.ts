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
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function getDb(): DB {
  return (g.__aiopsDb ??= open());
}

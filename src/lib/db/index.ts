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
  cust_phone     TEXT,
  address        TEXT,
  planned_window TEXT,
  eta            TEXT,
  arrived_at     TEXT,
  completed_at   TEXT,
  tracking_token TEXT
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

CREATE TABLE IF NOT EXISTS tracking_links (
  token      TEXT PRIMARY KEY,
  stop_id    TEXT,
  route_id   TEXT,
  url        TEXT,
  expires_at TEXT,
  active     INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);
`;

type DB = InstanceType<typeof Database>;

const g = globalThis as unknown as { __aiopsDb?: DB };

function open(): DB {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function getDb(): DB {
  return (g.__aiopsDb ??= open());
}

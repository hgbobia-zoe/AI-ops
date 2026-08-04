# Setup & Handoff Guide — Zoe Dispatch (Module 1)

This covers the parts that require **your own accounts** (Zapier, Vercel, Goodshuffle,
Quo, Slack, Zonar). The app code is done and runs today on mock data; wiring these up
turns on real persistence and integrations. Follow the milestones in order.

The full architecture rationale lives in the approved plan. This file is the
operational checklist.

---

## 0. Run it locally right now (no accounts needed)

```bash
npm install
npm run dev
```

Open `http://localhost:3000` on a tablet-sized viewport. It serves mock route data,
so you can exercise the entire driver flow (truck select → state machine → checklist →
exceptions) before any backend exists. Every action is validated and logged by the
intake at `/api/action`.

---

## 1. Zapier Tables (the database)

Create these **12 tables**. Relations are ID references (Zapier Tables has no joins),
and read-hot fields are denormalized onto `Stops` so the tablet reads one table.

| Table | Fields |
|---|---|
| **Vehicles** | truck_id, name, plate, zonar_device_id, tablet_pin, active |
| **Drivers** | driver_id, name, phone, active |
| **Customers** | customer_id, name, phone, address, lat, lng, notes |
| **Routes** | route_id, date, truck_id, driver_id, status, raw_snapshot |
| **Stops** | stop_id, route_id, customer_id, sequence, state, cust_name, cust_phone, address, planned_window, eta, arrived_at, completed_at, tracking_link_id, signature_url, photos_ref |
| **Events** | event_id, stop_id, route_id, truck_id, driver_id, action, from_state, to_state, ts, gps, **idempotency_key** (unique), payload |
| **Transitions** | from_state, action, to_state, requires_approval, requires_checklist, last_stop_only, not_last_stop |
| **Messages** | message_id, stop_id, channel, provider, template, body, provider_msg_id, status, sent_at |
| **TrackingLinks** | link_id, stop_id, token, zonar_ref, url, expires_at, active |
| **AutomationLogs** | log_id, event_id, zap_name, step, status, result, error, duration, ts |
| **Exceptions** | exception_id, stop_id, type, reason, driver_id, truck_id, gps, ts, slack_msg_id, resolved |
| **AuditLogs** | audit_id, actor, action, entity, entity_id, before, after, ts |

**Seed the `Transitions` table** from [`zapier/transitions.seed.json`](zapier/transitions.seed.json)
— import those rows. That table is the authoritative list of legal moves; it mirrors
`src/lib/stateMachine.ts`. If you change the state machine in code, re-import.

Seed `Vehicles` with your real trucks (the tablet reads them for the select screen).

---

## 2. Zapier Zaps (orchestration)

Create **one Catch-Hook Zap per action**. Each: `Catch Hook → (Tables lookup to
validate against Transitions) → Tables update → fan-out → write AutomationLogs`.

| Zap | Trigger action | Does |
|---|---|---|
| Intake / Log | *all* | Writes the `Events` row (dedupe on idempotency_key), updates `Stops.state`. |
| Departed | `LEAVING_WAREHOUSE` | Create `TrackingLink` (Zonar) → Quo SMS (on-the-way) → `Messages` row → Slack "departed". |
| Arrived | `ARRIVED` | Quo SMS (arrived) → Slack "arrived". |
| Heading Next | `HEADING_NEXT` | Mark stop Completed → re-scrape Goodshuffle order → recompute ETA → set next stop EnRoute → SMS next customer. |
| Complete & Return | `COMPLETE_AND_RETURN` | Mark last stop Completed → Slack "route done" → expire tracking links. |
| Exception | `REPORT_EXCEPTION` | Write `Exceptions` → Slack alert → `AuditLog`. |
| Start Route | `START_ROUTE` | Set `Route.status=scraping` → trigger the Computer Use scrape job (M2). |

**Point the app at Zapier:** put the intake Catch Hook URL in `ZAPIER_FORWARD_URL`.
The app's `/api/action` validates + dedupes, then forwards the event (HMAC-signed with
`WEBHOOK_SECRET`) to that hook. Verify the signature in a Zap code step.

> Route order rule: **Goodshuffle always wins.** Re-scrape only *reads* the human-set
> order — never auto-optimize.

---

## 3. Integrations

- **Quo (SMS):** connect in Zapier; use the two templates from the spec (on-the-way /
  arrived) with `{{CustomerName}}`, `{{TrackingLink}}`, `{{ETA}}`.
- **Slack:** connect; pick the dispatch channel for departed/arrived/completed/exception/
  failure alerts.
- **Zonar:** create the tracking link on `LEAVING_WAREHOUSE`; expire it on stop complete.
- **Goodshuffle:** no API → scraped by an Anthropic Computer Use agent (M2, §5).

---

## 4. Deploy to Vercel (free tier, under your domain)

1. Push this repo to GitHub, import into Vercel.
2. Add env vars from [`.env.example`](.env.example) in the Vercel dashboard.
3. Add your subdomain (e.g. `dispatch.yourdomain.com`) in Vercel → Domains, and add the
   CNAME it gives you at your DNS provider.
4. Install the PWA on each truck tablet (Add to Home Screen) and bind it to its truck once.

---

## 5. M2 — Goodshuffle route ingestion (Anthropic Computer Use) — built

The **Start Route** lifecycle is built and working end to end:

`Start Route` → `POST /api/ingest-route` sets `status=scraping` and runs the ingestion
job in the background → tablet polls `/api/route` and shows **"Loading route…"** →
job lands on `ready` (stops loaded) or `failed` (→ **manual-entry** fallback on the
tablet). The tablet **never blocks**.

Two strategies (`INGEST_STRATEGY` env):
- **`mock`** (default) — returns the sample route after ~1.5s. No API key, no browser.
  Exercises the whole flow locally. This is what runs today.
- **`computer-use`** — the real **Anthropic Computer Use agent** (`claude-opus-5` by
  default): Claude reads Goodshuffle screenshots and drives clicks/scrolls, then calls
  a `submit_route` tool with the structured stops. Set `ANTHROPIC_API_KEY` and implement
  the browser driver.

**To turn on the real scraper**, run the **ingestion worker** — a small server that
owns a headless Chromium (Playwright) which Claude's Computer Use tool drives. It runs
on **your server** (Vercel can't run a browser); the Next app just calls it. Full
instructions in **[worker/README.md](worker/README.md)** — including a one-command
Docker deploy and how to capture the Goodshuffle login once (no password in code). The
Playwright driver ([src/lib/ingest/playwrightDriver.ts](src/lib/ingest/playwrightDriver.ts))
and Computer Use loop ([src/lib/ingest/computerUseAgent.ts](src/lib/ingest/computerUseAgent.ts))
are built and smoke-tested. Then set `INGEST_STRATEGY=computer-use`,
`INGEST_WORKER_URL`, and `INGEST_WORKER_SECRET` on the Next app.

The server route store ([src/lib/ingest/routeStore.ts](src/lib/ingest/routeStore.ts)) is
in-memory today; at production swap it for the Zapier `Routes`/`Stops` tables (or
Supabase) behind the same `getRoute`/`setRoute` contract — the tablet never changes.

---

## Kiosk mode (running beside Goodshuffle Pro)

Zoe Dispatch is an **addition** to Goodshuffle Pro, not a replacement — GSPRO stays
the source of truth for routes, stops, and inventory. On the truck tablet they run
side by side. When a truck is bound, the app opens straight into the **`/kiosk`**
shell.

- **Start shift** (one tap) goes fullscreen, acquires a screen **wake lock** (tablet
  stays awake), and **launches Goodshuffle Pro**.
- The screen is a split: Goodshuffle on one side, the Zoe Dispatch action/automation
  panel on the other. Exit is **PIN-gated** (the tablet's bind PIN).
- **Goodshuffle blocks iframe embedding** (`x-frame-options`), so GSPRO opens in its
  own window rather than inside our page. For a true single-screen split, tile the two
  windows with the tablet's kiosk browser:
  - **Android:** Fully Kiosk Browser (or split-screen) — Goodshuffle on one side, this
    app on the other.
  - **iPad:** Split View — Safari (Goodshuffle) + this app.
- Config (`.env`): `NEXT_PUBLIC_GSPRO_URL` (your Goodshuffle URL) and
  `NEXT_PUBLIC_GSPRO_EMBED` (leave `false`; set `true` only if you have a frameable URL).

Plain full-screen driver view without the split is still at **`/route`**.

## Where things live in the code

- State machine (single source of truth): `src/lib/stateMachine.ts`
- Action intake (validate / dedupe / forward): `src/app/api/action/route.ts`
- Read endpoints (mock now, Tables later): `src/app/api/route/route.ts`, `src/app/api/vehicles/route.ts`
- Tablet screens: `src/app/route/page.tsx`, `src/components/*`
- Offline queue + webhook client: `src/lib/offlineQueue.ts`, `src/lib/webhookClient.ts`

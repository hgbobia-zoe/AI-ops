# Deploy — Zoe Dispatch (all code, no Zapier)

One self-contained container: the Next.js app + the Goodshuffle scraper
(Playwright/Chromium, in-process) + the SQLite database + the notification
integrations (SMS, Slack, tracking). Deploy it to a managed container host and
point your domain (or a WordPress page) at it.

```
Tablet ──▶ Next.js app ──▶ SQLite (routes, stops, events, messages, exceptions, audit)
                │
                ├─ Start Route ─▶ Playwright + Claude Computer Use ─▶ Goodshuffle
                └─ each action ─▶ OpenPhone SMS · Slack · /track/<token> link
```

Nothing is manual/no-code — configuration is just environment variables.

---

## 1. Environment variables

Set these as host secrets (all optional except where noted — unset integrations
simply log what they'd do). Full list + examples in [.env.example](.env.example).

| Var | Purpose |
|---|---|
| `PUBLIC_BASE_URL` | Public URL of this app (builds customer tracking links). **Set this.** |
| `DATABASE_PATH` | SQLite file path (default `/data/dispatch.db` in the container). |
| `VEHICLES_JSON` | Truck list, e.g. `[{"truckId":"T-05","name":"Truck 5"}]`. |
| `ANTHROPIC_API_KEY` | Enables the real Goodshuffle scraper (Computer Use). Unset → mock routes. |
| `GOODSHUFFLE_URL` | `https://pro.goodshuffle.com/app/rms/dashboard` |
| `GOODSHUFFLE_STORAGE_STATE` | Path to a saved login (see §4). |
| `OPENPHONE_API_KEY` / `OPENPHONE_FROM` | Customer SMS (Quo/OpenPhone). |
| `SLACK_WEBHOOK_URL` | Slack alerts. |

---

## 2. Deploy to Fly.io (recommended)

A [fly.toml](fly.toml) and [Dockerfile](Dockerfile) are included. One machine + a
volume for SQLite.

```bash
fly launch --no-deploy            # uses the included fly.toml; pick an app name/region
fly volumes create dispatch_data --size 1 --region iad
fly secrets set \
  PUBLIC_BASE_URL=https://<app>.fly.dev \
  ANTHROPIC_API_KEY=... \
  OPENPHONE_API_KEY=... OPENPHONE_FROM=+1301... \
  SLACK_WEBHOOK_URL=... \
  VEHICLES_JSON='[{"truckId":"T-05","name":"Truck 5"}]'
fly deploy
```

> SQLite lives on the volume, and volumes are per-machine — keep it to **one
> machine** (`min_machines_running = 1`, auto-stop off, already set in fly.toml).

## 2b. Deploy to Railway (alternative)

1. New Project → Deploy from GitHub repo → it detects the `Dockerfile`.
2. Add a **Volume** mounted at `/data`.
3. Add the env vars from §1 (set `DATABASE_PATH=/data/dispatch.db`).
4. Set the service to **1 replica** (SQLite is single-writer).

---

## 3. Put it under your domain / WordPress

The app can't run *inside* WordPress (WP is PHP), but you can surface it under your
domain two easy ways:

- **Subdomain (cleanest):** point `dispatch.zoeeventsdmv.com` at the host (Fly/Railway
  gives you a CNAME/target). Set `PUBLIC_BASE_URL` to that subdomain.
- **Embed in a WordPress page:** add an HTML block with an iframe:
  ```html
  <iframe src="https://dispatch.zoeeventsdmv.com" style="width:100%;height:90vh;border:0" allow="fullscreen"></iframe>
  ```
  (Drivers can still "Add to Home Screen" from the subdomain for the full-screen PWA.)

---

## 4. Capture the Goodshuffle login (once)

So the scraper logs in without a password in code:

```bash
npx playwright open --save-storage=goodshuffle-auth.json https://pro.goodshuffle.com/app/rms/dashboard
# log in by hand, close the window, then upload the file to the volume and set:
#   GOODSHUFFLE_STORAGE_STATE=/data/goodshuffle-auth.json
```

Re-capture when the session expires.

---

## 5. Turning integrations on

Everything works with integrations **off** (routes load, actions persist, the UI is
fully usable; SMS/Slack are logged as "would send"). Flip each on by adding its keys:

- **SMS:** `OPENPHONE_API_KEY` + `OPENPHONE_FROM` (your OpenPhone number, E.164).
- **Slack:** `SLACK_WEBHOOK_URL` (an Incoming Webhook).
- **Real scraping:** `ANTHROPIC_API_KEY` + the saved Goodshuffle login.

## Local dev

```bash
npm install
npm run dev      # http://localhost:3000 — mock routes, integrations logged, SQLite at ./data/dispatch.db
```

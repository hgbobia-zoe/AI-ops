# Zoe Dispatch

Tablet-first dispatch app for delivery drivers. Each truck's tablet selects its
truck (no login) and captures driver actions. **Everything runs as code** — no
Zapier, no no-code backend — in one self-contained, self-hostable service.

## Architecture in one paragraph

The tablet renders state-aware buttons from a shared **state machine**
(`src/lib/stateMachine.ts`) and fires **one action per tap** at `/api/action`,
which validates the transition, dedupes on an idempotency key, persists the event
to **SQLite**, updates the stop, and fans out in code: customer **SMS** (OpenPhone/
Quo), **Slack** alerts, and a customer **tracking page**. **Start Route** scrapes
today's route out of Goodshuffle Pro with a headless Chromium driven by **Anthropic
Computer Use** — all in-process. Ships as one Docker image (app + scraper + DB).

## Run locally

```bash
npm install
npm run dev
```

Runs on mock routes with integrations logged (not sent) and SQLite at
`./data/dispatch.db` — the full driver flow works with zero config. Open on a
tablet viewport.

## Deploy

See **[DEPLOY.md](DEPLOY.md)** (Fly.io / Railway, one container + a volume, WordPress
embed). Architecture and code map in [SETUP.md](SETUP.md).

## Status

- Tablet shell, state machine, offline queue, kiosk mode — ✅
- Route ingestion (Playwright + Computer Use, in-process) — ✅
- SQLite persistence + code fan-out (SMS / Slack / tracking / audit) — ✅
- Monochrome UI — ✅

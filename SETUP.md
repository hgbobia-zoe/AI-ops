# Zoe Dispatch — Architecture (all code, no Zapier)

Tablet-first dispatch app for delivery drivers. **Everything runs as code** — no
Zapier, no no-code backend. One self-contained service you host on a managed
container platform (Fly.io / Railway) or your own server.

**To go live, see [DEPLOY.md](DEPLOY.md).**

## What it does
- Each truck's tablet selects its truck (no login) and captures driver actions.
- **Start Route** scrapes today's route out of Goodshuffle Pro (headless Chromium
  driven by Claude Computer Use) and stores it.
- Each action fans out in code: customer **SMS** (OpenPhone/Quo), **Slack** alerts,
  a customer **tracking page**, and a full audit trail — all persisted in SQLite.
- Kiosk mode tiles the app beside Goodshuffle Pro on the tablet.

## Stack
- **Next.js 16** (App Router) + React 19, TailwindCSS, monochrome UI.
- **SQLite** (better-sqlite3) — the system of record.
- **Playwright + Anthropic Computer Use** — in-process Goodshuffle scraping.
- **OpenPhone / Slack** — direct API integrations, key-gated.
- One **Dockerfile** (Playwright base image) → any container host.

## Where things live
| Concern | Path |
|---|---|
| State machine (single source of truth) | [src/lib/stateMachine.ts](src/lib/stateMachine.ts) |
| Database (schema + connection) | [src/lib/db/index.ts](src/lib/db/index.ts), [repo.ts](src/lib/db/repo.ts) |
| Action intake (validate, dedupe, persist, fan out) | [src/app/api/action/route.ts](src/app/api/action/route.ts) |
| Fan-out (SMS / Slack / tracking / audit) | [src/lib/notify/](src/lib/notify) |
| Route ingestion (Playwright + Computer Use) | [src/lib/ingest/](src/lib/ingest) |
| Customer tracking page | [src/app/track/[token]/page.tsx](src/app/track/[token]/page.tsx) |
| Tablet screens | [src/app/route](src/app/route), [src/app/kiosk](src/app/kiosk), [src/components](src/components) |
| Deploy | [Dockerfile](Dockerfile), [fly.toml](fly.toml), [DEPLOY.md](DEPLOY.md) |

## Local dev
```bash
npm install
npm run dev
```
Runs on mock routes with integrations logged (not sent) and SQLite at
`./data/dispatch.db` — the whole flow works with zero config.

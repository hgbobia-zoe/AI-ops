# Ingestion Worker — the server that owns the browser

Goodshuffle Pro has no API, so "Start Route" scrapes it with a **headless Chromium**
(Playwright) that **Claude's Computer Use** tool drives. Chromium can't run on Vercel,
so this worker runs on **your own server**. The Next app (on Vercel) just calls it.

```
Tablet ─Start Route→ Next /api/ingest-route ─HTTP→ THIS WORKER ─Playwright→ Chromium ↔ Goodshuffle
                                                        │
                                              Anthropic Computer Use (reads screenshots)
                                                        │
                                                 → structured stops → back to the tablet
```

> This Chromium is **bundled by Playwright** — it is *not* your installed Chrome, and it
> needs no display. That's why a plain Linux server (or the Docker image) works.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/health` | liveness |
| `POST` | `/ingest` | `{ truckId, date }`, `Authorization: Bearer $INGEST_WORKER_SECRET` → `{ ok, stops }` |

## Run locally

```bash
npm ci
npx playwright install chromium          # one-time: download the browser
# smoke-test the browser (no Claude / Goodshuffle needed):
GOODSHUFFLE_URL=https://example.com npm run ingest-worker -- --selftest
# run the server:
npm run ingest-worker
```

## Deploy (Docker, recommended)

The Playwright base image ships Chromium + all OS libraries.

```bash
docker build -f worker/Dockerfile -t zoe-ingest-worker .
docker run -p 8787:8787 --env-file worker.env zoe-ingest-worker
```

Then set `INGEST_WORKER_URL` + `INGEST_WORKER_SECRET` on the Next app and flip
`INGEST_STRATEGY=computer-use`.

## Environment (worker side)

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Computer Use API access |
| `INGEST_WORKER_SECRET` | shared bearer secret (must match the Next app) |
| `INGEST_WORKER_PORT` | default `8787` |
| `GOODSHUFFLE_URL` | dispatch URL; `{truckId}` / `{date}` are substituted |
| `GOODSHUFFLE_STORAGE_STATE` | path to a saved login session (see below) |
| `INGEST_MODEL` | default `claude-opus-5` |
| `INGEST_MAX_TURNS` | agent turn cap (default 40) |
| `INGEST_HEADLESS` | `false` to watch the browser while debugging |

## Logging in without putting credentials in code

Capture the Goodshuffle session once, then let the worker reuse it — no password in
env, in code, or in Claude's prompt:

```bash
# Opens a real browser; log in by hand, then close it. Saves cookies to the file.
npx playwright open --save-storage=goodshuffle-auth.json https://app.goodshuffle.com/
# Point the worker at it:
export GOODSHUFFLE_STORAGE_STATE=./goodshuffle-auth.json
```

Re-capture when the session expires. Keep `goodshuffle-auth.json` out of git (it's
already in `.gitignore`).

## Cost note

Computer Use sends a screenshot per turn, so each scrape is several Claude calls. If
Goodshuffle's dispatch DOM is stable, a **deterministic** `page` read (Playwright
selectors, no LLM) is far cheaper — add a `readRouteFromDom()` to `PlaywrightDriver`
and use Computer Use only as the fallback. The Computer Use path is the resilient
default when the DOM isn't known.

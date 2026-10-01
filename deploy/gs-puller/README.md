# Goodshuffle cloud puller (cloud runtime — Increment 2)

The goal: run the Goodshuffle pull **unattended in the cloud**, so it no longer depends on the office
machine being on. Goodshuffle is behind **Cloudflare, which blocks datacenter IPs**, so a plain Fly
fetch (or a plain Fly browser) gets blocked. This worker runs real headless **Chromium on Fly**, routed
through a **residential proxy**, so Goodshuffle sees a residential IP — the same reason the office Chrome
works today.

It reuses the exact office runner (`scripts/zoe-pull/run.mts` → `buildOfficePullScript`): read-pull of
routes + bookings, create-project drain, outbox drain, heartbeat. Only the transport changes (proxy +
bundled Chromium + a persistent profile volume).

## ⚠️ Honest status: this is a SPIKE, not proven
Nobody has confirmed that a residential-proxied headless Chromium clears Goodshuffle's Cloudflare. Real
Chromium + a clean residential IP + a logged-in profile usually passes, but Cloudflare can still throw a
Turnstile/JS challenge. **Validate the spike (steps 4–5) before relying on this** and retiring the
office extension. If it doesn't pass, options are: a stealthier residential proxy, a managed browser host
(Browserbase/Steel), or keeping the office extension for Goodshuffle only.

## What you provide (I can't do these)
1. **A residential proxy** — sign up with a provider (e.g. a rotating/sticky residential proxy). You need
   a `host:port` + username/password. A **sticky session** IP is better (Cloudflare dislikes IP churn).
2. **The dedicated Goodshuffle login** — the full-access account used for pulls.
3. **Fly cost approval** — this is a separate always-on machine with 2 GB RAM for Chromium.

## Activation

**1. Create the app + volume** (from the repo root so the build context is the whole repo):
```bash
flyctl launch --no-deploy --copy-config --config deploy/gs-puller/fly.toml --name zoe-gs-puller
flyctl volumes create gs_puller_profile --app zoe-gs-puller --region iad --size 2
```

**2. Set secrets:**
```bash
flyctl secrets set --app zoe-gs-puller \
  PROXY_SERVER="http://PROXY_HOST:PORT" \
  PROXY_USERNAME="..." \
  PROXY_PASSWORD="..." \
  GS_INGEST_TOKEN="<same as the main app, only if it's set there>"
```

**3. Seed the logged-in Goodshuffle profile** (one-time — a headless container can't do an interactive
login). Produce a logged-in profile locally, then copy it onto the volume:
```bash
# locally, sign in once (headful) into the SAME profile dir layout:
ZOE_PROFILE=./gsprofile ZOE_WATCH=0 ZOE_WATCH_LOGIN=1 npx tsx scripts/zoe-pull/run.mts   # sign in in the window, then close
# then copy ./gsprofile onto the Fly volume (tar over `flyctl ssh sftp` / `flyctl ssh console`).
```
(If seeding a profile proves awkward, the alternative is adding a Playwright `storageState` loader to the
runner — left for the spike, since it only matters once Cloudflare is confirmed to pass.)

**4. Deploy + watch the first cycle:**
```bash
flyctl deploy --config deploy/gs-puller/fly.toml --app zoe-gs-puller
flyctl logs --app zoe-gs-puller
```

**5. Confirm the spike passed:** logs should show the read-pull succeeding (routes/bookings counts) and a
heartbeat `ok`, NOT a Cloudflare challenge / `not_logged_in`. Check the main app's **Admin → Connections**
+ **Cloud runtime** card: the route source should go fresh from this worker. Once stable for a few cycles,
retire the office extension for Goodshuffle.

## After it works
- Move Goodshuffle from the "browser" bucket to a "server" job in `src/lib/runtime/jobs.ts` (its freshness
  already shows there) and drop the office-extension dependency.
- The proxy IP should be **sticky**; rotating IPs per request will trip Cloudflare.

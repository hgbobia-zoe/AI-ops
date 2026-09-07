# Deploy & Configure — Zoe Dispatch

One self-contained container: the Next.js app + the SQLite database + proof-of-delivery
file storage + the notification/ETA integrations. It needs a **persistent volume**, so it
runs on a container host (Fly.io), **not** Vercel.

**Goodshuffle sync does NOT run on the server.** Cloudflare blocks datacenter-IP calls, so
Goodshuffle data is pulled by a **logged-in browser** replaying Goodshuffle's own internal
endpoints and POSTing to our ingest APIs — the office **Auto-Pull bookmarklet** (installed
from `/admin/pull`, run once/day in a signed-in `pro.goodshuffle.com` tab) or the Android
kiosk WebView. The in-repo Playwright scraper is a non-working legacy fallback.

```
Logged-in Goodshuffle browser (office Auto-Pull bookmarklet / kiosk WebView)
   │  replays GS internal endpoints → POSTs routes + full bookings history + drains photo push-back
   ▼
Next.js app ──▶ SQLite + POD files  (on the /data volume)
   ├─ each driver action ─▶ Quo / OpenPhone SMS · Slack · /track/<token> link
   ├─ live ETA            ─▶ GPS TrackIt / Ignition (truck GPS → drive time)
   └─ staffing            ─▶ Connecteam (crew on schedule)
Blades: Command Center · Sales · Ops Manager · Event Risk · Staffing · Financial · Customers · History · Automation
Dashboard (/dispatch) ─▶ split view with Ignition (fleet telematics)
```

Everything is configured with **environment variables** — no code changes to turn
features on. The app runs fully with them all **off** (SMS/Slack logged as "would send";
planned ETA; full-width dashboard; auth open).

---

## Live deployment

- **URL:** https://zoe-dispatch.fly.dev
- **Fly app:** `zoe-dispatch` · org **Zoe Events** (`personal`) · region `iad`
- **Machine:** 1 × shared-cpu-1x / 1 GB · **Volume:** `dispatch_data` (1 GB) at `/data`
- **State today:** live Goodshuffle + Connecteam data via the office Auto-Pull; all blades
  operational. RBAC (Owner/Admin/Member, $ redacted for Members) is **built but not yet
  activated** — set the auth secrets (§⑦) to turn it on. See _TODO_ at the bottom.

### Redeploy (after code changes)

```bash
fly deploy --app zoe-dispatch --remote-only
```

Fly builds the image on its remote builder (the local image is large) and rolls the
single machine. `flyctl` lives at `~/.fly/bin/flyctl.exe`; sign in once with
`fly auth login` (opens your browser → Continue with Google).

> SQLite + uploaded photos live on the volume, and volumes are per-machine — keep it
> to **one machine** (already set: `min_machines_running = 1`, auto-stop off).

---

## Where to set the values on Fly

Every item below (except the Goodshuffle login file) is a **Fly secret**. Two ways:

**A) Fly dashboard (web UI)** — the simplest for pasting API keys:
1. Go to **https://fly.io/apps/zoe-dispatch**
2. In the left sidebar, click **Secrets**  (direct: https://fly.io/apps/zoe-dispatch/secrets)
3. Enter the **name** (e.g. `SLACK_WEBHOOK_URL`) and **value**, click **Set / Save**.
4. Fly redeploys the machine automatically (~30s). Repeat per secret.

**B) CLI** — good for setting several at once:
```bash
fly secrets set --app zoe-dispatch \
  SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..." \
  OPENPHONE_API_KEY="..." OPENPHONE_FROM="+13015551234"
```
Each `fly secrets set` triggers one redeploy. To stage several without deploying yet,
add `--stage`, then run `fly deploy` once.

To see what's set (names only, never values): `fly secrets list --app zoe-dispatch`.
To remove one: `fly secrets unset KEY --app zoe-dispatch`.

Already set: `PUBLIC_BASE_URL`, `VEHICLES_JSON`. Baseline env (in `fly.toml`, not
secret): `PORT`, `DATABASE_PATH=/data/dispatch.db`, `GOODSHUFFLE_STORAGE_STATE`.

---

## The items — what, how to get it, which key

### ① Goodshuffle data (routes + bookings) — pulled from a logged-in browser
Cloudflare blocks server-side calls, so there's nothing to "turn on" server-side. Instead:
1. Sign into `pro.goodshuffle.com` with a **full-access** account (must see financials).
2. In Zoe Dispatch open **/admin/pull** → drag the **Auto-Pull** button to the bookmarks bar.
3. Click it once each morning in the Goodshuffle tab — it then pulls routes + full bookings
   history and drains delivery-photo push-backs every ~10 min while that tab stays open.

| Item | How to get it | Fly key |
|---|---|---|
| Ingest token (gates the ingest APIs) | Any long random string; the bookmarklet carries it as `x-publish-token`. Until set, ingest is **open** (fail-open). | secret `GS_INGEST_TOKEN` |

(The legacy in-repo Playwright scraper — `ANTHROPIC_API_KEY`, `/data/goodshuffle-auth.json`,
`GOODSHUFFLE_URL` — is Cloudflare-blocked and **not** part of the working path.)

### ② Customer texts (Quo / OpenPhone)
| Item | How to get it | Fly key |
|---|---|---|
| OpenPhone API key | OpenPhone web app → **Settings → API** → generate key (needs a Business plan) | `OPENPHONE_API_KEY` |
| Sending number | Your OpenPhone number in E.164, e.g. `+13015551234` | `OPENPHONE_FROM` |

### ③ Slack alerts
| Item | How to get it | Fly key |
|---|---|---|
| Incoming webhook | [api.slack.com/apps](https://api.slack.com/apps) → create app → **Incoming Webhooks** → activate → **Add New Webhook to Workspace** → pick a channel → copy the `https://hooks.slack.com/services/…` URL | `SLACK_WEBHOOK_URL` |
| Failure-alert throttle | Optional. Seconds an identical failure is suppressed after its first post, so a persistent outage can't spam the channel. **Default `600`** (10 min). | `ALERT_THROTTLE_SECONDS` |

The same webhook carries two kinds of message: the normal operational updates
(departed / arrived / completed / exception), **and** `⛔ Zoe Dispatch failure` alerts
whenever an integration call actually fails — a customer/coordinator SMS the provider
rejected, GPS TrackIt (Zonar) or Google Maps erroring, a route scrape that failed, or
any unexpected fan-out error. Skipped-because-unconfigured cases (e.g. SMS keys unset)
are **not** alerted — only genuine failures. Identical failures are throttled per
`ALERT_THROTTLE_SECONDS` above.

### ④ Live drive-time ETA (pluggable GPS provider — GPS TrackIt / Ignition)
GPS is a switchable provider (`GPS_PROVIDER`); the current fleet is **GPS TrackIt** (also the
Ignition fleet view). ETA/tracking links are minted from the kiosk's logged-in Ignition session,
with the customer-notify number forced to the Zoe main line.
| Item | How to get it | Fly key |
|---|---|---|
| Provider select | e.g. `gpstrackit` | `GPS_PROVIDER` |
| GPS TrackIt API key | From your GPS TrackIt / Ignition account | `GPSTRACKIT_API_KEY` (+ optional `GPSTRACKIT_BASE_URL`) |
| Truck → unit map | Your GPS unit ids per truck | `GPSTRACKIT_UNITS_JSON` — e.g. `{"NPR-1":"200149626","E450":"200149627"}` |
| Timezone | Arrival clock times (default America/New_York) | `ETA_TIMEZONE` |

### ⑤ Dashboard split view (Ignition)
| Item | How to get it | Fly key |
|---|---|---|
| Ignition web URL | The URL you open to see Ignition's fleet view | `IGNITION_URL` |
| Force iframe | Only if Ignition permits framing; otherwise it opens as a tiled window / webview | `IGNITION_EMBED="true"` |

### ⑥ Optional — traffic-aware ETA fallback / geocoding
| Item | How to get it | Fly key |
|---|---|---|
| Google Maps key | [console.cloud.google.com](https://console.cloud.google.com) → new project → enable **Geocoding API** + **Directions API** → **Credentials** → API key (billing required) | `GOOGLE_MAPS_API_KEY` |

### ⑦ App authentication / RBAC (Owner · Admin · Member)
Set these to turn on sign-in + role-based financial redaction (Members see no $; Owner/Admin do):
| Item | How to get it | Fly key |
|---|---|---|
| Session-signing secret | Any long random string (`openssl rand -hex 32`) | `APP_SESSION_TOKEN` |
| First Owner | Pick a username + strong password; the app bootstraps this Owner on boot | `OWNER_USERNAME`, `OWNER_PASSWORD` |

Then add teammates in **/admin/users**. `GS_INGEST_TOKEN` (§①) additionally gates the ingest APIs.

### ⑧ Staffing (Connecteam)
| Item | How to get it | Fly key |
|---|---|---|
| Connecteam API key | Connecteam → Settings → Developer / API → generate | `CONNECTEAM_API_KEY` |

Powers **People on Schedule** + the staffing/capacity risk signals. Unset ⇒ staffing shows
**UNVERIFIED** (never assumed empty).

Full list with inline notes: [.env.example](.env.example).

---

## Goodshuffle login (the storage-state file) — legacy scraper only

> Not needed for the working browser-pull path (§①); this is only for the Cloudflare-blocked
> in-repo Playwright scraper. Keep for reference.

`GOODSHUFFLE_STORAGE_STATE` is **not** a pasted secret — it's a saved browser session
(cookies + local storage) so the scraper starts already logged in, without a password
in code. Capture it once:

```bash
# On any machine with the repo:
npx playwright open --save-storage=goodshuffle-auth.json https://pro.goodshuffle.com/app/rms/dashboard
# → a browser opens; log into Goodshuffle by hand, then close the window.
# goodshuffle-auth.json now holds the session.
```

Then upload it to the Fly volume (the app reads `/data/goodshuffle-auth.json`):

```bash
fly ssh sftp shell --app zoe-dispatch
# at the prompt:
put goodshuffle-auth.json /data/goodshuffle-auth.json
```

Re-capture when the session expires. (Ping me and I'll script this end-to-end.)

---

## Optional — custom domain

Point a subdomain at the app instead of `*.fly.dev`:

```bash
fly certs add dispatch.zoeeventsdmv.com --app zoe-dispatch   # prints the DNS records to add
```
Add the shown CNAME/A/AAAA records at your DNS provider, then update
`PUBLIC_BASE_URL=https://dispatch.zoeeventsdmv.com` (so tracking links use it).
You can also embed the app in a WordPress page with an `<iframe>`.

---

## Kiosk / dashboard desktop shells (optional)

The truck tablet and the dashboard can run in the Electron shell so Goodshuffle /
Ignition embed fully with persistent login (`kiosk-shell/`):

```bash
cd kiosk-shell && npm install
APP_URL=https://zoe-dispatch.fly.dev npm start                # truck kiosk (app + Goodshuffle)
APP_URL=https://zoe-dispatch.fly.dev IGNITION_URL="..." npm run dashboard   # office dashboard (board + Ignition)
```

---

## Android kiosk — updates (OTA)

Two layers update independently:

- **The dispatch app (UI, features, fixes)** is a web app the kiosk loads from
  `zoe-dispatch.fly.dev`. It updates the instant you deploy the server — **no APK work,
  nothing to touch on the tablets.** This is the vast majority of changes.
- **The native shell (the APK itself** — JS bridge, kiosk-lock behavior, WebView
  settings) changes rarely. For that, the app **self-updates over the air.**

### One-time setup
1. Set a publish token as a Fly secret (any long random string):
   ```bash
   fly secrets set --app zoe-dispatch KIOSK_PUBLISH_TOKEN="$(openssl rand -hex 24)"
   ```
2. Sideload the current signed APK on each tablet **once** (the first OTA-capable build
   can't install itself). From then on, updates are automatic.

### Pushing a native update
1. Bump `versionCode` in `android/app/build.gradle.kts` (tablets only update to a
   HIGHER versionCode).
2. Build the signed release APK (see `android/README`), then publish:
   ```bash
   cd android
   export KIOSK_PUBLISH_TOKEN=...        # same value as the Fly secret
   ./publish-ota.sh "what changed"
   ```
   That POSTs the APK to `/api/kiosk/publish`, which stores it on the volume. Each
   tablet checks `/api/kiosk/latest` on launch and every 6h, downloads, verifies the
   sha256, and installs — **silently**, because the kiosk runs as device owner.

Safety: the endpoint is disabled until `KIOSK_PUBLISH_TOKEN` is set, and Android only
installs an update signed with the **same Zoe release key** (kept off-repo on your
machine) — so a leaked token alone cannot push a malicious build.

---

## Tests

```bash
npm test          # Vitest — state machine, parsers, DB dedupe/roundtrip
```

---

## TODO / activation

- **Turn on auth** — RBAC is built but open by default; set `APP_SESSION_TOKEN` +
  `OWNER_USERNAME`/`OWNER_PASSWORD` (§⑦) to require sign-in before wiring real SMS keys.
- **Owned-inventory master** — until it exists, item over-booking checks stay UNVERIFIED
  (never inferred from bookings).
- Point the truck tablets at `https://zoe-dispatch.fly.dev` (Add to Home Screen for the PWA).

## Local dev

```bash
npm install
npm run dev       # http://localhost:3000 — mock routes, integrations logged, SQLite at ./data/dispatch.db
```

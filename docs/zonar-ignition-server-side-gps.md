# Server-side Zonar / Ignition GPS as the single source of truck location

Design doc — analysis only. No code changed. Another build is deploying to `zoe-dispatch`
concurrently; this is the written plan for a later, separate build.

> **User intent (verbatim):** "Now that we have an API key for Zonar / Ignition, we no
> longer need to pull location from the tablet. We can pull truck location from Ignition
> in the remote session [server-side]. We no longer need login on the app side, and for
> shift passes / links we give to drivers on their phones. Everything should be real
> links, not fallbacks."

## TL;DR

The server-side GPS path the user is asking for **already exists and already works**:
`GPSTRACKIT_API_KEY` + `GPSTRACKIT_UNITS_JSON` are deployed Fly secrets, and
`src/lib/eta/zonar.ts` → `src/lib/eta/liveEta.ts` pulls real truck position from the GPS
TrackIt REST API (the API behind the Zonar Ignition portal) and computes a real
traffic-aware drive-time ETA. It is **not** Cloudflare-blocked — unlike Goodshuffle, it
is a plain key-authed REST API callable from the server/cloud runtime.

What is left is **cleanup, not new plumbing**:

1. **Two parallel "Zonar" mechanisms exist and must be consolidated.** (a) The *real
   server-side* GPS TrackIt client (`lib/eta/zonar.ts`), and (b) a *tablet-side* Zonar
   **etaLink** minting path (`createEtaLinkViaKiosk` → Ignition GraphQL in a hidden
   WebView → a `ignition.zonarsystems.com/etaLink/...` link). The tablet etaLink path is
   the thing to retire: it needs a logged-in Ignition session on the device and is a
   different unit-id namespace. Replace the links it produces with our own `/track`
   link, which now renders real server-side GPS.
2. **`/track` and the driver app already prefer live GPS and silently fall back to the
   planned ETA.** Decision needed: keep a *labeled* planned fallback, or show an honest
   "live location unavailable." (Recommendation below: labeled fallback, but label it.)
3. **The provider abstraction (`src/lib/providers.ts`) is out of sync with reality.** Its
   `zonar` GPS provider is a `serverSide: false` no-op stub that says "handled on the
   tablet," while the real server-side implementation lives *outside* the abstraction in
   `lib/eta/zonar.ts`, and the health layer already treats `zonar` as the server-side
   GPS TrackIt source. Reconcile these.
4. **A concrete auth gap blocks the "no login on driver phones" goal:** `/api/eta` is
   **not** in the proxy `PUBLIC` list — it is only in `GUEST_ALLOW`. A device-bound
   driver tablet / phone link has *no session*, so once `APP_SESSION_TOKEN` is set,
   `/api/eta` returns 401 for the driver surface and the live ETA silently disappears
   (the client keeps the last value / falls to planned). This must be fixed for the
   user's goal to hold.
5. **The device tablet is already not a GPS source for location.** The tablet's
   `navigator.geolocation` fix (`getGps()`) is attached to action/exception rows as a
   forensic breadcrumb only — it never feeds truck position or ETA. So "remove the
   tablet as a GPS source" is mostly about retiring the **etaLink** path, not a position
   feed.

---

## 1. Current-state map

### 1a. Every truck-location / ETA consumer

| # | Consumer | File:line | Current source of truck LOCATION | Current source of ETA | Fallback |
|---|----------|-----------|----------------------------------|-----------------------|----------|
| 1 | Customer tracking page `/track/[token]` | `src/app/track/[token]/page.tsx:29,66-70` | **Server GPS TrackIt** via `computeLiveEta` (only when `stop.state==="EnRoute"` and `truckId` set) | `live.etaText` from server drive-time | **Silent** → `stop.eta` (planned, from Goodshuffle). `etaText = live?.etaText ?? stop.eta` (line 66) |
| 2 | Driver app current-stop tile | `src/components/CurrentStopView.tsx:61,226-236` | **Server GPS TrackIt** via `useLiveEta` → `/api/eta` (only while `activeStop.state==="EnRoute"`) | `live.etaText` | **Silent** → `activeStop.eta` (planned) |
| 3 | `/api/eta` endpoint | `src/app/api/eta/route.ts:22` | **Server GPS TrackIt** via `computeLiveEta(truckId, stop)` | same | returns `{eta:null}` → caller falls back |
| 4 | "On the way" customer SMS link | `src/lib/notify/fanout.ts:156-161,178-182` | n/a (link, not a position) | n/a | Link priority: `payload.etaLink` (kiosk-minted **Zonar** link) → `s.ignitionEtaLinks[truckId]` (static per-truck) → `createTracking()` **our `/track` link** |
| 5 | Dispatch board | `src/app/(console)/dispatch/page.tsx:42-67` | **None programmatic** — links out to the Ignition portal (`IGNITION_URL`); office big-screen shows Ignition side-by-side via native kiosk board mode | n/a | n/a |
| 6 | Ignition pane (dashboard split view) | `src/components/IgnitionPane.tsx` | Embedded Ignition web portal (webview/iframe/window) — visual only, not read programmatically | n/a | n/a |
| 7 | `/api/eta/units` (admin discovery) | `src/app/api/eta/units/route.ts` → `listUnits()` | GPS TrackIt `unit/search` (lists fleet vehicles + ids) | n/a | returns `{units:null}` when unconfigured |

### 1b. The server-side GPS TrackIt stack (the real, desired path)

- **`src/lib/eta/zonar.ts`** — GPS TrackIt REST client.
  - `zonarConfigured()` = `Boolean(process.env.GPSTRACKIT_API_KEY)` (line 20-22).
  - `getTruckPosition(truckId)` → `GET {GPSTRACKIT_BASE_URL||cloud-api.gpstrackit.com}unit/{unitId}` with header `x-api-key` (line 61-88).
  - `unitId(truckId)` maps via `GPSTRACKIT_UNITS_JSON` (`{"NPR-1":"1",...}`), falling back to the truckId itself (line 26-33).
  - **429 handling:** on rate-limit, sets a `globalThis.__gpstrackitRateLimitedUntil` backoff (`GPSTRACKIT_RATELIMIT_BACKOFF_SECONDS`, default **900s**) and quietly degrades — does **not** page ops (line 48-76).
  - Non-429 HTTP errors / exceptions → `alertOps("GPS TrackIt (Zonar)", ...)` + return null (line 77-87).
  - `parsePosition()` walks the response tree for the first plausible lat/lng pair, rejecting null-island `(0,0)` (line 112-154).
  - `listUnits()` → `POST unit/search` (discovery for the units map) (line 94-108).
- **`src/lib/eta/liveEta.ts`** — composition + cache.
  - `computeLiveEta(truckId, stop)`: `getTruckPosition` → `geocode(stop.address)` → `driveTime()` → `LiveEta{etaText, minutesAway, distanceMiles, truck, source:"gpstrackit", computedAt}`. Returns `null` if unconfigured, no address, or any step fails (line 35-72).
  - **ETA cache:** `globalThis.__etaCache`, keyed `` `${truckId}|${stop.address}` ``, TTL `ETA_CACHE_SECONDS` default **240s (4 min)**. This TTL — not the client poll interval — governs the GPS TrackIt call rate (one upstream call per truck+stop per TTL, shared across all viewers) (line 28-43,70).
  - `liveEtaEnabled()` = `zonarConfigured()`.
- **`src/lib/eta/geo.ts`** — geocode + drive-time. `GOOGLE_MAPS_API_KEY` set → Google geocode + Directions with `departure_time=now` (real traffic-aware ETA); else keyless Nominatim + OSRM (no traffic, rate-limited, "not for prod"). Geocode cached in `globalThis.__zoeGeocache`. Any failure → null (line 24-113).
- **`src/lib/eta/useLiveEta.ts`** — client hook; polls `/api/eta?truckId&stopId` every **60s** while `active`; keeps the last value on a transient error (line 22-48).

### 1c. The tablet-side Zonar etaLink path (the thing to retire)

- **`src/lib/kioskBridge.ts:229-241`** — `createEtaLinkViaKiosk(truckId, address, etaHours)` mints a `ignition.zonarsystems.com/etaLink/<code>` link by replaying Ignition's `createEtaLink` GraphQL in the kiosk's hidden, logged-in Ignition WebView.
  - Uses a **different unit-id namespace**: `DEFAULT_UNITS` `{E450:200149627, "NPR-1":200149626, "NPR-2":200214102}` (Ignition unit ids), overridable via `NEXT_PUBLIC_IGNITION_UNITS_JSON` (line 206-221). These are **not** the GPS TrackIt unit ids used server-side.
  - Contract documented in `android/IGNITION_ETALINK.md` (Cognito `IdToken` from device localStorage; notify SMS forced to the Zoe main line `+13012915296`, never the customer).
- **`src/lib/useRouteMachine.ts:463-467`** — `perform()` calls `createEtaLinkViaKiosk` on `LEAVING_WAREHOUSE`/`HEADING_NEXT`, puts the URL on `payload.etaLink`; `fanout.ts` prefers it (consumer #4 above).
- **`src/lib/settings.ts:41,91`** — `ignitionEtaLinks` (static per-truck links, `IGNITION_ETALINK_JSON`) — the second-priority link in fanout.
- Requires a **logged-in Ignition session on the device** → exactly the device dependency the user wants gone.

### 1d. The tablet's own GPS (confirmed: NOT a location feed)

- **`src/lib/webhookClient.ts:29` `getGps()`** — best-effort `navigator.geolocation`, 2.5s hard cap, resolves `undefined` on any failure.
- **`src/lib/useRouteMachine.ts:469,552`** — attaches that fix to each action/side-action request.
- **`src/lib/db/repo.ts:2257-2279,2336-2351`** — the fix is stored on `events.gps` and `exceptions.gps` only (a "where was the driver when they tapped" breadcrumb). **It never feeds truck position or ETA.** So the driver device is already not a location source for tracking.

### 1e. The provider abstraction + health — inconsistencies

- **`src/lib/providers.ts:209-220`** — the `zonar` GPS provider is `serverSide: false`, `fields: []`, and `getLocation()` is a **no-op stub** returning `{skipped:true, error:"handled on the tablet's Ignition session"}`. `samsara`/`motive` (line 222-286) are real `serverSide:true` clients. `gpsProviderById` defaults to `zonar` (line 295-297).
- **`src/lib/health/connections.ts:242-265`** — but the health layer already treats `gpsId==="zonar"` as **GPS TrackIt server-side** (`zonarConfigured()`, test kind `gpstrackit`, "truck location + ETA viewable from anywhere"). So the *abstraction* says "on tablet" while the *health model* and the *actual ETA code* say "server-side." This contradiction is the core thing to reconcile.

### 1f. Auth / login surface for drivers (`src/proxy.ts`)

- Gate is **inactive until `APP_SESSION_TOKEN` is set** (fail-open) (line 95-96).
- `PUBLIC` (no session needed): `/login /join /pass /pass-expired /api/auth /track /kiosk /select /route /api/action /api/pod /api/kiosk /api/vehicles ...` (line 17-52). The driver surface is public by **device binding** (a tablet is bound to a truck, not a person).
- `GUEST_ALLOW` (shift-pass guest role): `/dispatch /track /kiosk /select /route /api/eta /api/dispatch/route-health /api/vehicles /api/action /api/pod /api/kiosk /api/route/stop/complete` (line 76-89).
- **Gap:** `/api/eta` is in `GUEST_ALLOW` but **not** in `PUBLIC`. The device-bound driver surface has no session, so with the gate active, `/api/eta` → 401 for a plain driver tablet / phone link. `useLiveEta` swallows the error and the live ETA silently vanishes (falls to planned). See §3.
- `/pass/[token]` (`src/app/pass/[token]/route.ts`) mints a scoped, self-expiring **guest** cookie from the token and redirects to `/select?pass=1` (driver) or `/dispatch` (board). The token *is* the credential; no password. Guests are hard-scoped by `GUEST_ALLOW`.
- `/api/eta/units` is reachable under the `/api/eta` prefix match (`isPublicPath` matches `p + "/"`), so it inherits `/api/eta`'s gating — it lists the whole fleet's vehicle ids. Minor info-leak; should be admin-gated (see §3).

---

## 2. Target design — server-side Ignition GPS as the single source of truth

### 2.1 Position SoR

`getTruckPosition(truckId)` (GPS TrackIt) is **the** source of truck location. No code
reads a device-reported position for tracking today, so no position feed needs removing —
only the **etaLink** device path (§2.3) and the provider stub (§2.4).

### 2.2 How each consumer rewires

| Consumer | Change |
|----------|--------|
| `/track` (#1) | Keep `computeLiveEta`. Decision §4: show an explicit state when live is unavailable instead of a silent swap to planned. Relax the `state==="EnRoute"`-only gate if the user wants "see the truck" also when Arrived/approaching (optional). |
| Driver tile (#2) | No change to the data path; only the §3 auth fix makes it actually resolve on a no-session device. Consider labeling planned vs live (§4). |
| `/api/eta` (#3) | Add to `PUBLIC` (§3). Otherwise unchanged. |
| SMS link (#4) | **Drop `payload.etaLink` and `s.ignitionEtaLinks` priority; always use our `createTracking()` `/track` link.** That link now shows real server GPS, so it is "the real link, not a fallback." Keeps the notify-line rule moot (we never hand Zonar the customer number because we stop minting Zonar links). |
| Dispatch board (#5,6) | Optional enhancement: add a small server-rendered "live position / last-seen" read from `getTruckPosition` per active truck, rather than only linking to the Ignition portal. Not required by the user's ask; note as future. |
| `/api/eta/units` (#7) | Admin-gate it (§3). |

### 2.3 Retiring the tablet etaLink path

Remove (in the later build):
- `createEtaLinkViaKiosk` call in `useRouteMachine.perform()` (`:463-467`) and the
  `payload.etaLink` branch — so departures no longer depend on a logged-in Ignition
  WebView.
- The `payload.etaLink` / `s.ignitionEtaLinks` priority in `fanout.ts` (§2.2 #4).
- Can keep `createEtaLinkViaKiosk`/`ignitionUnitId` in `kioskBridge.ts` dormant (harmless)
  or delete; `android/IGNITION_ETALINK.md` becomes historical. **Decision §7.**

Net effect: nothing the customer receives needs the device's Ignition login. The device
tablet keeps only its Goodshuffle role (route pull — still Cloudflare-blocked server-side,
so that stays on the logged-in WebView / office Auto-Pull; **out of scope** for GPS).

### 2.4 Reconciling the provider abstraction (design *within* it, don't bypass)

Make the `zonar` provider the real server-side GPS TrackIt client so the abstraction
matches reality and the health layer:
- Flip `zonar` to `serverSide: true`; implement `getLocation(vehicleId, cfg)` by delegating
  to the `lib/eta/zonar.ts` logic (shared helper), returning `{ok,lat,lng,ts}`.
- Keep `lib/eta/zonar.ts` as the shared low-level client (the 429 backoff + tree-walk
  parser live there); have `liveEta.ts` and the provider both call it, so there is one
  code path. Env keys stay (`GPSTRACKIT_API_KEY`, `GPSTRACKIT_UNITS_JSON`) — they are the
  already-deployed secrets; `providers.ts` would read them (or the secrets store) via a
  single accessor rather than re-implementing.
- This keeps the "switch GPS provider" module honest: `zonar` / `samsara` / `motive` are
  all server-side REST, selectable in `/admin`.

`RULES CALCULATE, AI INTERPRETS`: all of this is deterministic (position → geocode →
route → minutes). No model involved; nothing to interpret. Honesty posture: never
synthesize a position — `parsePosition` already rejects `(0,0)`, and every failure path
returns null rather than a guess.

---

## 3. Auth simplification + security implications

Goal: driver phone / shift-pass links show real live truck location + ETA with no login.

**Required for the goal to hold (concrete):**
- **Add `/api/eta` to `PUBLIC`** in `src/proxy.ts` (currently only in `GUEST_ALLOW`).
  - *What it exposes:* given a `truckId` + `stopId`, the truck's current lat/lng, minutes
    away, and ETA clock time. `stopId`s are DB ids (`R-<date>-<truck>-S<n>` or UUID-ish);
    `truckId`s are small/guessable (`E450`, `NPR-1`). So treat this as effectively public
    truck telemetry. For an events-rental fleet this is low-sensitivity (the same data is
    already texted to customers as a tracking link), but it is **not** nothing — it lets
    anyone who guesses a `truckId`+`stopId` poll live truck position.
  - *Mitigations (pick per §7):* (a) accept only a `/track` **token** instead of raw
    `truckId`+`stopId` (the token already scopes to one stop and expires in 12h —
    `createTracking` sets a 12h expiry, `repo.ts:2439`); or (b) keep `truckId`+`stopId`
    but require the stop to be `EnRoute` and within its window. Option (a) is the
    cleaner "capability, not an open endpoint" model and matches how `/track` and
    `/api/pod` already work ("ids are unguessable capabilities").

**Can stay as-is (already tokenless-by-capability):**
- `/track/[token]` — public, token is the capability, 12h expiry. No change needed.
- `/pass/[token]` — public gateway; mints a scoped guest cookie. No change.
- `/kiosk`, `/select`, `/route`, `/api/action`, `/api/pod`, `/api/vehicles` — already
  `PUBLIC` by device binding; GPS going server-side doesn't change their gating.

**Must keep their gate (do NOT loosen):**
- `/api/eta/units` — **should be tightened**, not loosened: it lists the whole fleet's
  vehicle ids and today inherits `/api/eta`'s public-ness via prefix match. Move it out
  from under the public `/api/eta` prefix (e.g. `/api/admin/eta-units`) or add an explicit
  settings-gate in `isSettings()`. Deny-by-default discipline.
- Everything already behind the session/role gates (finance, settings, sales, coaching,
  supervisor route writes under `/api/route/*`) — unchanged. Removing *GPS* login does not
  justify opening any of these.

**What "no login on the app side" does and does not mean:**
- It *does* mean: no Ignition login on the device for location/ETA (achieved by §2.3), and
  the driver phone link resolving live ETA with no session (achieved by the `/api/eta`
  `PUBLIC` fix).
- It does *not* mean: dropping the device's Goodshuffle login used for route pull (still
  Cloudflare-blocked, still needs a logged-in session somewhere). That is a separate
  concern; see the "Web pull plan" / "Cloud runtime vision" memory notes. **Flag for the
  user:** confirm they mean GPS/location login, not the GS route-pull session.

---

## 4. Real-vs-fallback policy (the honesty decision)

Today both `/track` and the driver tile **silently** fall back to the planned ETA
(`live?.etaText ?? stop.eta`) with no label distinguishing a live traffic ETA from a
static planned window. The user says "real, not fallbacks," but also never wants a
fabricated position.

Two options:

- **Option A — labeled planned fallback (recommended).** When live GPS is momentarily
  unavailable (API 429/backoff, unit offline, geocode miss), keep showing the planned ETA
  but **label it** ("Scheduled arrival" / "Estimated from schedule"), and only show the
  "See the truck on the map" link when `live.truck` exists. Reserve the big "N min away /
  live" treatment for a genuine live fix. Never render a map pin without a real position.
  - *Why:* a planned ETA is still true information (it comes from Goodshuffle's schedule),
    and hiding it entirely degrades the customer experience during a transient 15-min
    GPS TrackIt backoff. The dishonesty today is the *lack of a label*, not the fallback
    itself. Labeling resolves the honesty concern without a worse UX.
- **Option B — "live location unavailable."** When live GPS fails, show an explicit
  "Live location is temporarily unavailable" state and suppress any ETA. Maximally
  honest, but drops useful scheduled info and makes a routine 429 backoff look like an
  outage.

**Recommendation:** Option A, per consumer:
- `/track` (customer): labeled planned fallback; map link only with a real fix.
- Driver tile: labeled planned fallback (driver also has the raw window already).
- SMS link: always the `/track` link (which itself applies Option A on open).

Decision belongs to the user — see §7.

---

## 5. Caching / rate-limit / cost

- **Upstream call budget:** GPS TrackIt plan caps ~800 calls/day (per `liveEta.ts`
  comment). The **ETA cache** (`ETA_CACHE_SECONDS`, default 240s) is what bounds calls:
  one upstream `unit/{id}` call per `truckId|address` per 4 min, shared across all viewers
  and both consumers. Client polls (60s) are mostly cache hits.
  - 3 trucks × ~1 active stop each, 4-min TTL → ~0.75 calls/min/truck ≈ ~45 calls/hr for
    the fleet → comfortably under 800/day even on a long dispatch day.
- **429 backoff:** `GPSTRACKIT_RATELIMIT_BACKOFF_SECONDS` (default 900s) stops hammering
  after a quota hit; self-healing, no ops page. Good as-is.
- **Geocode cache:** `globalThis.__zoeGeocache` caches address→latlng indefinitely per
  process (stable per address) — keeps Google/Nominatim calls down. The cache key is the
  stop address string.
- **Per-unit mapping:** `GPSTRACKIT_UNITS_JSON` maps `truckId → GPS TrackIt unit id`
  (already deployed). Note this is a **different** map from the Ignition etaLink unit ids
  in `kioskBridge.ts` (`DEFAULT_UNITS`) — retiring the etaLink path removes that second
  map. Confirm `GPSTRACKIT_UNITS_JSON` covers all three trucks (`/api/eta/units` /
  `listUnits()` is the discovery tool; admin-gate it per §3).
- **Cost:** Google Directions with `departure_time=now` is a paid call per uncached ETA;
  the 4-min cache is the cost governor. If `GOOGLE_MAPS_API_KEY` is unset it degrades to
  keyless OSRM/Nominatim (no traffic) — fine for test, flagged "not for prod load." Confirm
  the Google key is set in prod (separate from the GPS TrackIt key).
- **Caveat (serverless):** `globalThis` caches/backoff are per-instance. On Fly with one
  machine this is fine; if scaled to N machines the effective call rate is ×N and the
  backoff isn't shared. Note for scale, not a blocker now.

---

## 6. Smallest-safe build order

Additive / read-only first, then cutover, then retire — each step shippable alone.

1. **(additive, no flag) Fix the `/api/eta` auth gap.** Add `/api/eta` to `PUBLIC` (or the
   token-scoped variant per §3). Makes live ETA actually resolve on no-session driver
   links. Low risk; today it only "works" because the gate is fail-open until
   `APP_SESSION_TOKEN` is set — this prevents a silent regression the day auth is enabled.
2. **(additive) Admin-gate `/api/eta/units`.** Move it out of the public `/api/eta` prefix
   or add it to `isSettings()`. Closes the fleet-id leak.
3. **(additive) Honesty labels (§4 Option A).** Label planned vs live on `/track` and the
   driver tile; show the map link only with a real fix. No behavior change to the data
   path; pure presentation.
4. **(additive) Reconcile the provider abstraction (§2.4).** Make `zonar`
   `serverSide:true` and route `getLocation` through the shared `lib/eta/zonar.ts` client.
   Keeps `liveEta.ts` as-is (still the ETA composer). Health already expects this.
5. **(cutover, behind a flag) Switch the SMS link to always-`/track`.** Gate the removal
   of the `payload.etaLink` / `ignitionEtaLinks` priority in `fanout.ts` behind a flag
   (e.g. `GS_ETALINK_DISABLE=1`) so it can be rolled back if the `/track` experience needs
   polish first. Flip on when §3 is deployed so the link shows real GPS.
6. **(cutover) Stop minting etaLinks on the device.** Remove the `createEtaLinkViaKiosk`
   call from `useRouteMachine.perform()`. After step 5 this is dead weight anyway.
7. **(retire) Remove dormant etaLink code / docs.** `createEtaLinkViaKiosk`,
   `ignitionUnitId`, `DEFAULT_UNITS`, `ignitionEtaLinks` setting, `IGNITION_ETALINK.md`.
   Hard cutover; do last, only after 5-6 have soaked.

Steps 1-4 are safe to land anytime. Step 5 is the only behavior change customers see; it
is the one to flag-gate. The tablet GPS-breadcrumb path (`getGps()` on events/exceptions)
is **left alone** — it is not a location source and still has forensic value.

---

## 7. Open questions for the user

1. **Fallback honesty (the §4 decision):** keep a **labeled** planned-ETA fallback
   (recommended) or show an explicit "live location unavailable" with no ETA? Per
   consumer, or one policy?
2. **How far to remove login:** you said "no login on the app side." Confirm this means
   the **Ignition/location** login on the device (which this design removes), **not** the
   Goodshuffle route-pull session — route data is still Cloudflare-blocked server-side and
   must stay on a logged-in session somewhere (device WebView or office Auto-Pull).
3. **`/api/eta` exposure model:** make `/api/eta` fully public by `truckId`+`stopId`
   (simplest), or switch it to a `/track` **token** capability (scoped to one stop, 12h
   expiry — more private)? The latter is more in keeping with how `/track` and `/api/pod`
   already work.
4. **Retire the tablet etaLink path now, or keep it dormant as a backup?** Recommendation:
   stop *using* it (steps 5-6) but keep the code dormant one release before deleting
   (step 7), in case `/track`-only reveals a gap.
5. **Prod geocoding key:** confirm `GOOGLE_MAPS_API_KEY` is set in prod so ETAs are
   traffic-aware; otherwise we silently run on keyless OSRM (no traffic), which is not a
   fabrication but is a lower-quality "real" ETA.
6. **`GPSTRACKIT_UNITS_JSON` coverage:** confirm it maps all three trucks
   (`E450`/`NPR-1`/`NPR-2`) to their GPS TrackIt unit ids — otherwise `getTruckPosition`
   falls back to using the truckId as the unit id and returns null.
7. **Dispatch board live position (optional):** do you want the office board to show a
   real server-side "last seen / position" per truck (read from `getTruckPosition`),
   rather than only the "Open Ignition" link? Not in your ask, but a natural follow-on now
   that position is server-side.

---

*Honesty posture held throughout: no fabricated positions (every failure returns null;
`(0,0)` rejected), estimates to be explicitly labeled, and all computation is
deterministic — `RULES CALCULATE, AI INTERPRETS`.*

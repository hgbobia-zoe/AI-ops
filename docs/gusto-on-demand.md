# Gusto on-demand sync (and the server-side-replay end state)

## Why this exists

Gusto has no approved API for us yet, so — like Goodshuffle and Instawork — we read it by **replaying its
own internal GraphQL from a logged-in `app.gusto.com` tab** (the Auto-Pull extension's `gusto.js`, world
MAIN, which hooks the app's `window.fetch` to capture `MembersTable` / `TimeTrackingDashboard` / the
per-member pay query, then POSTs the snapshot to `/api/payroll/gusto/import`).

The problem that prompted this: Gusto used to ride the extension's **10-minute auto-pull loop**
(`ensureGustoTab()` inside `runPullCycle`). Payroll is not a continuous job, and the find-or-create de-dup
kept missing (Gusto navigates/redirects, so the URL match failed), so background `app.gusto.com` tabs
**piled up overnight**. The operator "woke up with a lot of Gusto tabs."

## The stopgap we shipped: ON-DEMAND sync

Gusto is now pulled only when a human asks, and the tab is opened and **closed** per sync. Goodshuffle,
Instawork and Ignition are unchanged — they stay on the 10-minute loop.

End-to-end flow:

1. **App button** — `/payroll` → Settings → **"Sync Gusto now"** (`SyncGustoButton.tsx`, owner/admin only,
   the whole blade is gated by `canManagePayroll`). It uses the same `chrome.runtime.sendMessage(EXTENSION_ID, …)`
   idiom as `ConnectInstaworkButton` / `PullRoutesButton` and sends `{ type: "zoe-gusto-sync" }`.
2. **Extension (background)** — `startGustoSync()` guards against a concurrent sync (one `storage.gustoSync`
   marker, stale after 120s), then opens **one** background `app.gusto.com` tab and arms a watchdog alarm.
3. **`gusto.js` (world MAIN)** — auto-runs on the hidden tab: `maybeSeedNavigate()` hops to the People page,
   the app fires its GraphQL reads, the fetch hook captures them, and `sendToZoe()` POSTs the snapshot to
   `/api/payroll/gusto/import`. It then emits `window.postMessage({ __zoeGusto: true, type: "posted", ok })`.
4. **`gusto-bridge.js` (isolated world)** — world-MAIN scripts can't use `chrome.*`, so this tiny bridge
   listens for that window message and relays it to the background as `{ type: "zoe-gusto-posted" }`.
5. **Extension (background)** — on `zoe-gusto-posted` it closes the **exact tab** it opened (matched by tab
   id, so a user's own Gusto tab is never touched) and clears the marker + watchdog. If Gusto is signed out
   and nothing posts, the watchdog reaps the tab after 120s. Nothing lingers.
6. **Status is honest** — the button never claims "synced." It reads the real import-ledger row
   (`getLatestImportBySource()["gusto"]`) for last-pull time / state. A signed-out or failed pull simply
   doesn't advance it.

This keeps the proven browser-replay path but removes the always-open-tab cost. It still depends on the
office machine having the extension and a signed-in Gusto.

## The end state the user wants: server-side replay through a proxy (NOT built here)

The on-demand fix is a stopgap toward a hosted runtime where **no extension and no office browser are
needed** — matching the broader cloud-runtime direction (see `deploy/gs-puller/` for the same pattern being
spiked for Goodshuffle, and the "Cloud runtime vision" note). Gusto, like Goodshuffle, is behind defenses
that block datacenter IPs, so the server can't just call it; the session has to look like a real logged-in
browser on a residential/business IP.

Shape of the target design:

1. **Capture a live Gusto session at sync time.** An **in-app browser** (the office user signs into Gusto
   once inside Zoe, the way the Goodshuffle spike seeds a logged-in profile) captures the session material
   the GraphQL calls need: the Gusto auth **cookies**, the **CSRF / `x-gusto-*` headers**, and the exact
   captured operation bodies (`gusto.js` already has these — the versioned `MembersTable` /
   `TimeTrackingDashboard` / `CompanyMemberDashboardPeopleShowPay` queries with their variables).
2. **Store it securely.** Put the captured cookies/tokens in the app's **write-only secrets store** (the
   same store used for provider creds, set in `/admin`, never read back to the UI). Treat it as sensitive:
   encrypted at rest, scoped to payroll, and with explicit **expiry/refresh handling** — Gusto sessions
   roll, so the design needs a "session stale → re-capture in the in-app browser" loop (surfaced on the
   `/payroll` Settings connection row, like the current freshness signal).
3. **Replay server-side through a proxy on a sync trigger.** On the same "Sync Gusto now" trigger, a server
   job replays the captured GraphQL calls (roster, pay periods, per-member pay) against
   `graphql.app.gusto.com` with the stored cookies/headers, routed through a **residential/business proxy**
   so Gusto sees a residential IP. It parses + snapshots exactly as `/api/payroll/gusto/import` does today
   (reuse `gustoSnapshot.ts`), so the rest of HR/Payroll is unchanged.

What it needs (the parts a human must provide / decide):

- A **residential or business proxy provider** + credentials (`host:port` + user/pass; a **sticky** session
  IP, since IP churn trips bot defenses — same requirement the `deploy/gs-puller/` README calls out).
- **Secure session storage** in the secrets store, plus a **refresh/expiry** strategy and a re-capture path
  when the session dies.
- **Server-side replay** of the captured calls (transport + proxy + the existing parse/snapshot), likely as
  a separate Fly worker mirroring the `deploy/gs-puller/` scaffold (Dockerfile + `fly.toml` + README there).
- **Honest status**: a confirmation that the proxied replay actually clears Gusto's defenses before retiring
  the extension path — exactly the "this is a SPIKE, not proven" caveat the Goodshuffle puller carries.

Until that is built and proven, the on-demand extension sync above is the supported path, and Gusto stays
off the continuous loop.

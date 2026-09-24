# Zoe Auto-Pull runner (standalone, no extension)

A scheduled task that keeps Goodshuffle data flowing into Zoe Ops **without** the Chrome extension, an
open `pro.goodshuffle.com` tab, or manual clicks. It launches its **own** Chrome (a dedicated profile
kept signed into Goodshuffle), runs the same read-pull the bookmarklet/extension does (routes, bookings,
notes, photo push), and — the part the extension could never do on its own — **creates queued project
shells by navigating a tab** (no popup gesture required).

Runs on the **office machine only** (Cloudflare blocks datacenter IPs, so it must be a residential-IP
machine with real Chrome). Everyone else just uses the app.

## Why this exists
The extension pulls reads fine but can only create a Goodshuffle project from a real navigation, which it
did via a popup (`window.open`) that fires only on a manual bookmarklet click — so `create_project` jobs
never drained automatically and intake shells got stuck on "Creating…". This runner navigates a tab
instead of opening a popup, so creation just works on the schedule.

## Start using it (sign in once, then it stays running)
1. Ensure Node + this repo are on the machine (`npx tsx` + `playwright` with Chrome installed).
2. Double-click **`run.cmd`**. A dedicated Chrome window opens on the Goodshuffle sign-in page.
3. **Sign into Goodshuffle** with a full-access (financial) office account.
4. **Minimize that window and leave it.** It pulls immediately and then every ~10 minutes on its own,
   forever — routes, bookings, and any queued project shells. No scheduled task, no clicking. The session
   persists in the profile at `%USERPROFILE%\ZoePull\profile`; you only sign in again if Goodshuffle logs
   the profile out (it pauses and waits for you in the same window).
5. Logs go to `%USERPROFILE%\ZoePull\pull.log`; health shows on **/admin/pull**.

## Auto-start on boot (so you don't reopen it after a restart)
Put a shortcut to `run.cmd` in the Startup folder:
- Press **Win+R**, type **`shell:startup`**, Enter.
- Drop a shortcut to `scripts\zoe-pull\run.cmd` in that folder.
Now the watcher launches automatically each time you log into Windows.

## One-off mode (advanced)
Setting `ZOE_WATCH` to anything but `1` (or unsetting it) makes the runner do a single pull and exit —
useful for a manual run or a scheduled task. Watch mode (`ZOE_WATCH=1`, the default in `run.cmd`) is the
recommended way.

## Environment overrides (optional)
- `ZOE_WATCH=1` — persistent "sign in once, stays running" mode (default in `run.cmd`); anything else = one-off
- `ZOE_INTERVAL_MIN` — watch-mode pull interval in minutes (default 10)
- `ZOE_API` — Zoe Ops origin (default `https://zoe-dispatch.fly.dev`)
- `GS_INGEST_TOKEN` — only if the server sets it (ingest APIs are fail-open otherwise)
- `ZOE_PROFILE` — Chrome user-data-dir (default `%USERPROFILE%\ZoePull\profile`)
- `ZOE_HEADLESS=1` — invisible run (only after the profile is logged in; may trip Cloudflare)
- `ZOE_LOGIN_WAIT_MS` — how long a one-off run waits for a manual sign-in (default 180000)

## Health
Each run posts a heartbeat, so **/admin/pull** and the Connections health show it reporting in. The app
also Slack-alerts if the pull fails for more than one cycle.

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

## One-time setup
1. Ensure Node + this repo are on the machine (`npx tsx` + `playwright` with Chrome installed).
2. Double-click **`run.cmd`** (or run it once from a terminal). A Chrome window opens.
3. **Sign into Goodshuffle** in that window with a full-access (financial) office account. The session
   persists in the profile at `%USERPROFILE%\ZoePull\profile`; you won't need to sign in again unless
   Goodshuffle logs the profile out.
4. It then pulls immediately and closes. Check `%USERPROFILE%\ZoePull\pull.log`.

## Schedule it (every 15 minutes, only while signed in)
Open **Command Prompt** and run (adjust the path if the repo lives elsewhere):

```
schtasks /Create /TN "Zoe Auto-Pull" /TR "\"C:\Git\ZER\AI-OPS\scripts\zoe-pull\run.cmd\"" /SC MINUTE /MO 15 /RL LIMITED /F
```

- Runs as the logged-in user (needs a desktop for the browser), every 15 min.
- Remove it later with: `schtasks /Delete /TN "Zoe Auto-Pull" /F`
- Run it on demand: `schtasks /Run /TN "Zoe Auto-Pull"`

By default each run briefly opens a Chrome window. Once the profile is logged in you can try **invisible**
runs: uncomment `set "ZOE_HEADLESS=1"` in `run.cmd`. If Goodshuffle's Cloudflare challenges the headless
browser (the log shows "signed out" / pull failed), leave it headful.

## Environment overrides (optional)
- `ZOE_API` — Zoe Ops origin (default `https://zoe-dispatch.fly.dev`)
- `GS_INGEST_TOKEN` — only if the server sets it (ingest APIs are fail-open otherwise)
- `ZOE_PROFILE` — Chrome user-data-dir (default `%USERPROFILE%\ZoePull\profile`)
- `ZOE_HEADLESS=1` — invisible run (only after the profile is logged in)
- `ZOE_LOGIN_WAIT_MS` — how long the first run waits for a manual sign-in (default 180000)

## Health
Each run posts a heartbeat, so **/admin/pull** and the Connections health show it reporting in. The app
also Slack-alerts if the pull fails for more than one cycle.

# Gusto remote-browser runner (office machine)

Lets a payroll person **with no browser extension** push DRAFT hours to Gusto from the app and watch it
happen. The app queues an approved push; this runner — a persistent, logged-in Gusto browser on the office
machine (residential IP, so Cloudflare is happy) — claims it, writes the hours into the **current DRAFT run**,
and streams a live screenshot + per-worker results back to `/payroll`.

Same pattern as the Website Studio runner (app queues, office machine executes). It replaces the per-user
`gusto-push.js` extension path — nothing to install on the payroll person's machine.

## Hard safety — DRAFT only

The only Gusto mutation this ever sends is `AutoSaveWorkedHours` (set draft hours). It **never** submits, runs,
processes, or approves payroll, never clicks such a control, and **aborts without writing if the open run is
not a DRAFT**. Identical guarantees to `extension/gusto-push.js`.

## One-time setup

1. **App side (Fly):** set `GUSTO_RUNNER_TOKEN` to a long random string:
   ```bash
   fly secrets set GUSTO_RUNNER_TOKEN=$(openssl rand -hex 32) -a zoe-dispatch
   ```
   Until it's set, the runner endpoints return 503 (fail-closed) and `/payroll` shows the remote-browser push
   as "not set up" — so this is off by default. (Note the value; you'll paste it into the runner's `.env`.)
2. **Office machine** — from `tools/gusto-runner`, run setup once, then fill in `.env`:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\setup.ps1
   ```
   It installs deps + Chromium and creates `.env`. Open `.env` and set `GUSTO_RUNNER_TOKEN` to the **same value**
   you set on Fly. (`APP_URL` and `GUSTO_HEADLESS=1` are pre-filled.)
3. **Run it as an always-on service** (survives reboots, restarts on failure):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-service.ps1
   Start-ScheduledTask -TaskName ZoeGustoRunner
   ```
   Or run it in the foreground to watch it: `.\start.ps1`.

That's it. **No sign-in step here** — the runner can run headless from day one, and the first Gusto login (and
every later re-login) happens from the `/payroll` pane (see below). Keep the machine powered on and logged into
Windows. One job at a time; a failed job is marked `failed` in the app and the loop continues.

Config lives in `.env` (git-ignored). You can still override any value inline, e.g. `GUSTO_HEADLESS= .\start.ps1`
to force a visible window for debugging.

## Interactive sign-in from the app (Phase 2)

When the Gusto session lapses, the job goes to `signin_required` and the pane streams the **live login screen**.
The payroll person signs in **from `/payroll`** — their clicks and keystrokes are forwarded to this browser — so
**nobody has to touch the office machine** for a routine re-login. Guards: the runner only replays forwarded
input while the page is a `gusto.com` auth screen (`applyInput`), and the app only accepts input from an
owner/admin while the job is `signin_required`. The DRAFT hours write is always fully automated and never takes
forwarded input. For headless background operation this is the normal re-login path; keep a headful window only
if you prefer to sign in at the machine.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `APP_URL` | — (required) | The Zoe app origin |
| `GUSTO_RUNNER_TOKEN` | — (required) | Shared secret; must match the app's env |
| `GUSTO_PROFILE_DIR` | `./.gusto-profile` | Persistent Chrome profile dir (the logged-in session) |
| `GUSTO_HEADLESS` | unset (headful) | `1` = no visible window (recommended; sign-in still works from the pane) |
| `POLL_INTERVAL_MS` | `10000` | How often to poll for a job |
| `FRAME_INTERVAL_MS` | `1500` | Live screenshot cadence to the app |
| `SIGNIN_POLL_MS` | `600` | During interactive sign-in: how often to replay forwarded input + stream a fresh frame |
| `SIGNIN_TIMEOUT_MS` | `600000` | How long to wait for a human sign-in before aborting the job |
| `INPUTS_TIMEOUT_MS` | `60000` | How long to reach the draft inputs step before aborting |

## How a push flows

1. Owner/admin clicks **Push hours to Gusto** in `/payroll` → the app builds the per-worker entries
   (owner/admin-gated, same builder as the extension) and records a `queued` job.
2. This runner claims it, opens Gusto, and:
   - if signed out → reports `signin_required` and shows the login screen; the payroll person signs in from the
     app pane (or someone at the office machine), then it continues automatically;
   - drives to the DRAFT inputs step, captures the member map + headers, and replays `AutoSaveWorkedHours`
     for each matched worker (skips unmatched + idempotent-no-change).
3. It streams a live frame (~1.5s) and posts the per-worker result. `/payroll` shows the live browser + the
   outcome, and the shared "Last push" status updates exactly like the extension path.

Nothing is ever submitted. A human still runs/approves payroll inside Gusto.

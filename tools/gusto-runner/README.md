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

1. **App side (Fly):** set `GUSTO_RUNNER_TOKEN` to a long random string. Until it's set, the runner endpoints
   return 503 (fail-closed) and `/payroll` shows the remote-browser push as "not set up" — so this is off by
   default. Deploy.
2. **Office machine:**
   ```bash
   cd tools/gusto-runner
   npm install
   npx playwright install chromium
   ```
3. Create a `.env` (or export) with:
   ```
   APP_URL=https://zoe-dispatch.fly.dev
   GUSTO_RUNNER_TOKEN=<the same value you set on Fly>
   GUSTO_PROFILE_DIR=./.gusto-profile      # persistent Chrome profile (keeps Gusto logged in)
   # GUSTO_HEADLESS=1                       # leave UNSET for the first run so you can sign in to Gusto
   ```
4. **First run (interactive login):**
   ```bash
   APP_URL=... GUSTO_RUNNER_TOKEN=... npm start
   ```
   A Chrome window opens. When a push runs and the session is signed out, the window shows Gusto's login — sign
   in once. The persistent profile keeps you logged in for later runs. (Phase 2 will let the payroll person
   sign in from the app pane; for now sign-in happens here at the office machine.)

Keep it running like the other office-machine loops (Auto-Pull, responder). One job at a time; a failed job is
marked `failed` in the app and the loop continues.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `APP_URL` | — (required) | The Zoe app origin |
| `GUSTO_RUNNER_TOKEN` | — (required) | Shared secret; must match the app's env |
| `GUSTO_PROFILE_DIR` | `./.gusto-profile` | Persistent Chrome profile dir (the logged-in session) |
| `GUSTO_HEADLESS` | unset (headful) | Set to `1` only once the profile is reliably logged in |
| `POLL_INTERVAL_MS` | `10000` | How often to poll for a job |
| `FRAME_INTERVAL_MS` | `1500` | Live screenshot cadence to the app |
| `SIGNIN_TIMEOUT_MS` | `600000` | How long to wait for a human sign-in before aborting the job |
| `INPUTS_TIMEOUT_MS` | `60000` | How long to reach the draft inputs step before aborting |

## How a push flows

1. Owner/admin clicks **Push hours to Gusto** in `/payroll` → the app builds the per-worker entries
   (owner/admin-gated, same builder as the extension) and records a `queued` job.
2. This runner claims it, opens Gusto, and:
   - if signed out → reports `signin_required` and shows the login screen (sign in at the office machine);
   - drives to the DRAFT inputs step, captures the member map + headers, and replays `AutoSaveWorkedHours`
     for each matched worker (skips unmatched + idempotent-no-change).
3. It streams a live frame (~1.5s) and posts the per-worker result. `/payroll` shows the live browser + the
   outcome, and the shared "Last push" status updates exactly like the extension path.

Nothing is ever submitted. A human still runs/approves payroll inside Gusto.

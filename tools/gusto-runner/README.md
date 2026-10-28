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

## Verify it's actually running

`install-service.ps1` registers the task but does not prove the runner stayed up. After installing:

```powershell
(Get-ScheduledTask -TaskName ZoeGustoRunner).State        # want: Running
Get-ScheduledTaskInfo -TaskName ZoeGustoRunner | Select-Object LastTaskResult, LastRunTime  # want: 0
```

`State: Ready` + `LastTaskResult: 1` means it launched and exited (see the gotcha below). A healthy start logs
`[gusto-runner] starting. app=... profile=... headless=true` and keeps polling.

## Known gotcha: the task must call runner.js by ABSOLUTE path

Task Scheduler does **not** reliably honor the action's `WorkingDirectory` ("Start in") at logon under a limited
run level, so a task that runs `node runner.js` (relative) launches from the wrong cwd, fails with
`MODULE_NOT_FOUND`, and exits 1 — the runner never stays up. Two things prevent this and **both must hold**:

- `install-service.ps1` passes an **absolute** path to `runner.js` (`Join-Path $PSScriptRoot 'runner.js'`), and
- `runner.js` resolves `.env` and the Chrome profile dir from its **own** directory (`import.meta.url`), not cwd.

If you ever see `LastTaskResult: 1` with `Arguments: runner.js` (relative) on the registered task, you installed
an **old** copy — pull the latest and **re-run `install-service.ps1`** to re-register, then `Start-ScheduledTask`.
Check the registered action with: `(Get-ScheduledTask -TaskName ZoeGustoRunner).Actions | Format-List Execute, Arguments`.

## Known gotcha: headless needs chrome-headless-shell, co-located with the runner

`GUSTO_HEADLESS=1` launches Playwright's **chrome-headless-shell**, which is a **separate download** from the
regular chromium (`npx playwright install chromium` alone does NOT get it — use
`npx playwright install chromium chromium-headless-shell`). `setup.ps1` installs both.

`setup.ps1` also sets **`PLAYWRIGHT_BROWSERS_PATH`** to a `.pw-browsers` folder next to the runner and installs
the browsers there, instead of the per-user `%LOCALAPPDATA%\ms-playwright` default. Keep it that way: a scheduled
task can run under a filesystem view where the AppData default is **invisible** (e.g. a redirected or sandboxed
profile), and Playwright then throws `Executable doesn't exist at ...` and the task exits 1 even though the files
look present interactively. Co-locating the browsers with the runner removes that dependency.

Because `runner.js` reads `PLAYWRIGHT_BROWSERS_PATH` from `.env`, it imports playwright **dynamically after**
loading `.env` — a static import would read the variable too early (ESM hoists imports) and ignore it. Don't
convert that back to a top-level `import`.

**Diagnosing a silent task exit:** the runner tees stdout/stderr and fatal errors to **`boot.log`** in its own
folder (the scheduled task itself discards them). After a failed start, read `boot.log` for the real error.

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

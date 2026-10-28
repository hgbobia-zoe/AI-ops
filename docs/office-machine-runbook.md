# Office-machine runbook (rebuild / migration reference)

Several parts of Zoe Dispatch can't run on the server: **Goodshuffle and Gusto sit behind Cloudflare, which
blocks datacenter IPs**, and some jobs need a long-lived, logged-in real browser on a residential IP. So a
machine in the office does that work — it polls the app (on Fly), executes against the real browser/APIs, and
reports back. The server governs and records; the office machine executes.

This doc is the single inventory of **everything running on the office machine**, so it can be rebuilt on a new
box or migrated to a proper always-on server later. Each component has its own README (linked); this is the map.

> **Direction of travel:** the office machine is a residential-IP dependency we want to retire. The cloud
> replacement path is the Goodshuffle cloud puller spike (`deploy/gs-puller/`, residential proxy + Fly Chromium)
> and, more broadly, the [cloud runtime vision](../README.md). Until that's proven, these processes stay here.

## Rebuild prerequisites (once per machine)

1. **Windows user** that **stays logged in** (these run at logon and need the desktop session). Keep the machine
   powered on and signed in.
2. **Node.js** (LTS) + this repo checked out. Several runners use `npx tsx` / Playwright.
3. **Real Chrome** installed (for the Goodshuffle paths — Cloudflare must see a genuine residential browser).
4. **The app's shared tokens** (set on Fly, pasted into each runner's local config — see each component). Treat
   every token as write-only/secret; never commit `.env` files.
5. Confirm the machine's public IP is **residential** (not a VPN/datacenter range), or Goodshuffle/Gusto will be
   challenged by Cloudflare.

## Components running here

### 1. Goodshuffle Auto-Pull — Chrome extension *(primary pull path)*
- **Does:** from a logged-in `pro.goodshuffle.com` tab, pulls routes + full bookings history, drains the
  `gs_outbox` (photo pushes / write-backs), and snapshots Instawork. CORS-locked to `pro.goodshuffle.com`.
- **Lives:** `extension/` (built). Loaded unpacked from **`C:\Git\zoe-autopull-extension`** per the standing
  "extension drop to C:\Git" rule — after any rebuild, extract the build there (replace) + copy the zip.
- **State/sign-in:** the user's own logged-in Goodshuffle session in Chrome. Health on **/admin/pull**.
- **Token:** `GS_INGEST_TOKEN` (app side; fail-open until set).
- **README:** [`extension/README.md`](../extension/README.md)

### 2. Goodshuffle Auto-Pull — standalone runner `zoe-pull` *(no-extension alternative)*
- **Does:** same read-pull as the extension **plus** creates queued project shells by navigating a tab (the
  extension couldn't do that without a manual popup gesture). Pulls immediately then every ~10 min.
- **Lives:** `scripts/zoe-pull/` — start with **`run.cmd`** (watch mode `ZOE_WATCH=1`).
- **State/sign-in:** dedicated Chrome profile at **`%USERPROFILE%\ZoePull\profile`**; sign into Goodshuffle once
  with a full-access (financial) office account, then leave it minimized. Logs: `%USERPROFILE%\ZoePull\pull.log`.
- **Autostart:** shortcut to `run.cmd` in the Startup folder (`shell:startup`).
- **README:** [`scripts/zoe-pull/README.md`](../scripts/zoe-pull/README.md)

### 3. Gusto DRAFT hours runner — `ZoeGustoRunner` scheduled task
- **Does:** claims an approved DRAFT-hours push from `/payroll`, writes hours into the **current DRAFT run** via
  Playwright (DRAFT-only: only `AutoSaveWorkedHours`, aborts if the run isn't a draft), streams a live screenshot
  back. First/renewed Gusto login is done **from the `/payroll` pane** (in-pane sign-in), not at the machine.
- **Lives:** `tools/gusto-runner/`, staged self-contained at **`C:\Git\zoe-gusto-runner`**.
- **Install:** `install-service.ps1` → registers the `ZoeGustoRunner` scheduled task (at logon, restarts on
  failure), then `Start-ScheduledTask -TaskName ZoeGustoRunner`.
- **State/sign-in:** persistent Chrome profile at **`C:\Git\zoe-gusto-runner\.gusto-profile`** — **established by
  the first DRAFT push**: the job goes to `signin_required`, you sign into Gusto (incl. 2FA) from the `/payroll`
  pane, and that login persists for future headless pushes.
- **Token:** `GUSTO_RUNNER_TOKEN` (fail-CLOSED — runner endpoints 503 until set on both Fly and the runner's
  `.env`; must match). Write `.env` without a UTF-8 BOM (the first-line regex breaks on a BOM).
- **⚠️ Gotcha (bit us 2026-10-27/28):** the scheduled task must invoke `runner.js` by **absolute** path, and
  `runner.js` must resolve `.env`/profile from its own dir (`import.meta.url`) — Task Scheduler doesn't honor
  "Start in" at logon, so a relative `node runner.js` fails `MODULE_NOT_FOUND` and exits 1 (`State: Ready`,
  `LastTaskResult: 1`). If you see a relative `Arguments: runner.js` on the task, you installed an old copy —
  re-run the current `install-service.ps1`. Fixed in commit `60f9f99` / PR #142.
- **README:** [`tools/gusto-runner/README.md`](../tools/gusto-runner/README.md) · design: [`docs/gusto-on-demand.md`](gusto-on-demand.md)

### 4. Website Studio runner — Claude Agent SDK
- **Does:** drains the Website Studio queue (marketing's plain-English site-change requests), edits the **separate
  website repo** with the Agent SDK on a branch, renders + screenshots on the local DevKinsta site for human
  preview, and — only after in-app approval — opens a PR. Single-flight, PR-only, never commits to the default
  branch.
- **Lives:** `tools/website-studio-runner/`.
- **Needs:** the website repo checkout, DevKinsta running locally (`WEBSITE_PREVIEW_URL`), a centralized org
  `ANTHROPIC_API_KEY`, and `gh` auth for PRs. App origins via `WEBSITE_PROD_URL` / `WEBSITE_LOCAL_URL`.
- **README:** [`tools/website-studio-runner/README.md`](../tools/website-studio-runner/README.md) · [`docs/self-improving-app-pattern.md`](self-improving-app-pattern.md)

### 5. AI Bridge responder — Claude Code session
- **Does:** the external agent the app can't be — reads the AI-bridge work queue, works in an isolated git
  worktree, writes code, runs tests, and opens PRs; a human merges. Also handles human instructions
  (question/operational/feature) and "act on a call" triggers.
- **Lives:** `scripts/responder/` (helper `poll.mjs`, `start.ps1`); deploy notes in `deploy/responder/`.
- **Token:** `AI_BRIDGE_TOKEN` (same value as the app's Fly secret). **Keep autonomy switches OFF until the
  scoped, non-admin machine identity + sandbox exist** — the gates are advisory against an owner/admin-credentialed
  agent.
- **README:** [`scripts/responder/README.md`](../scripts/responder/README.md) · contract: [`docs/ai-bridge-responder.md`](ai-bridge-responder.md) · setup: [`docs/self-improvement-setup.md`](self-improvement-setup.md)

## Cloud migration target (not on the office machine yet)
- **Goodshuffle cloud puller** — `deploy/gs-puller/`: the office pull re-run as unattended headless Chromium on
  Fly, routed through a **residential proxy** so Cloudflare sees a residential IP. **SPIKE, not proven** — nobody
  has confirmed a residential-proxied headless Chromium clears Goodshuffle's Turnstile. Validate before retiring
  the office extension. README: [`deploy/gs-puller/README.md`](../deploy/gs-puller/README.md).

## Quick health check (all components)
| Component | Up signal |
|-----------|-----------|
| Auto-Pull extension | **/admin/pull** shows a recent pull; Goodshuffle tab logged in |
| zoe-pull runner | `%USERPROFILE%\ZoePull\pull.log` advancing; /admin/pull fresh |
| Gusto runner | `(Get-ScheduledTask -TaskName ZoeGustoRunner).State` = `Running`, `LastTaskResult` = `0` |
| Website Studio runner | a queued job reaches `preview` with screenshots |
| AI Bridge responder | the app shows the responder "live" (heartbeat from `poll.mjs`) |

# Website Studio runner (office machine)

This is the office-machine half of **Website Studio**. The AI-OPS app (Zoe Dispatch, on Fly) only *queues*
plain-English website-change requests from the marketing team. This runner drains that queue, makes the
change with the **Claude Agent SDK** against the **separate website repo**, renders + screenshots it on the
**local DevKinsta site** for a human to preview, and — only after a human approves in the app — opens a PR.

It mirrors how the office machine already drains the Goodshuffle `gs_outbox` via the Auto-Pull: the server
can't do this work, so a machine you control does.

## What it does, one job at a time (single-flight)

1. Claim the next queued job from the app.
2. In the website repo: fetch + hard-reset the default branch, then cut `website-studio/<jobId>`.
3. Run the Claude Agent SDK with the marketer's prompt **plus the edit context** to edit the repo (confined
   to the repo dir). See **Edit context** below.
4. Commit the change **on the branch** (never on the default branch).
5. Deploy the branch's working tree to the **local DevKinsta** WordPress site (local preview only).
6. Screenshot the changed page(s) at **desktop (1280w)** and **mobile (390w)** with Playwright, upload them +
   the summary + the changed-file list, and set the job to **`preview`**.
7. Wait for the human decision in the app:
   - **Approved** → push the branch + `gh pr create` (base = the website repo's default branch) → mark `done`
     with the PR URL.
   - **Discarded** → delete the local branch, restore the local site to a clean default branch.

### Edit context (browse-and-edit)

The app's Website Studio is a **browse-and-edit** tool: the marketer browses the site in an embedded browser,
lands on a page, and submits a change. The job therefore carries the **page they were viewing** (`contextUrl`)
and the **environment** they were in (`production` or `local`). The runner derives the site path from
`contextUrl` and tells the agent *which* page to edit, so it no longer has to guess the target from the prose.

This URL→repo-page mapping is **best-effort**: the runner hands the agent the path and the agent (which can
read the repo) maps it to the matching WordPress template/page/content. If it can't map a URL confidently, it
says so explicitly in the job summary rather than guessing silently. The two environment origins the browser
and (optionally) the runner use are configured **on the app** via `WEBSITE_PROD_URL` (default
`https://zoeeventsdmv.com`) and `WEBSITE_LOCAL_URL` (default `http://zoeeventsdmv.local`, falls back to
`WEBSITE_PREVIEW_URL`). The runner still renders + screenshots **locally** (via `WEBSITE_PREVIEW_URL`)
regardless of environment — the environment only tells the agent which page the request targeted.

### Guardrails (important — this edits real website code driven by non-engineers)

- The agent is **file-ops only** (Read/Write/Edit/Glob/Grep) — it has **no shell / no Bash**. Because it runs
  without human tool-call approval on prompts from non-engineers (which may include text injected via files
  it reads), a shell would be arbitrary command execution on the office machine (whose env holds
  `ANTHROPIC_API_KEY` + `WEBSITE_RUNNER_TOKEN`). The **runner** owns all git, build/preview, and PR operations;
  the agent only edits website source under the repo dir. If a theme build step is ever needed for preview,
  the runner runs it as a fixed command in its deploy step — never the agent.
- The runner **never merges a PR, never pushes to the default branch, and never deploys.** It is PR-only; a
  human reviews and merges. Nothing goes live from here.
- One job at a time. A single job failing is caught, marked `failed` in the app, and the loop continues.
- Secrets come from the environment, never hardcoded.

## One-time setup

1. **Install Node 18+** (uses global `fetch`/`FormData`/`Blob`).
2. **Install dependencies** (pinned):
   ```
   cd tools/website-studio-runner
   npm install
   npx playwright install chromium
   ```
3. **Authenticate `gh`** for the *website* repo so the runner can open PRs:
   ```
   gh auth login
   ```
   (Run from the website repo once, or ensure `gh` has access to its remote.)
4. **Docker Desktop + DevKinsta running**, with the website repo imported, so the local site is reachable
   (see the `website-devkinsta-local` note). The preview step needs the local site up.

## Required environment variables

| Var | What |
|-----|------|
| `ANTHROPIC_API_KEY`     | The **centralized org** Anthropic API key. The marketing team needs no Claude subscription of their own — this one key powers every job. |
| `WEBSITE_RUNNER_TOKEN`  | Shared secret; must equal the app's `WEBSITE_RUNNER_TOKEN`. Sent as `x-website-runner-token`. The app's runner endpoints are **fail-closed** (HTTP 503) until this is set on the app, so nothing runs until you configure it on both sides. |
| `WEBSITE_REPO_PATH`     | Absolute path to the local website repo checkout (e.g. `C:\git\zer\website`). |
| `APP_URL`               | Base URL of the AI-OPS app (e.g. `https://<your-app>.fly.dev`). |

## Optional environment variables

| Var | Default | What |
|-----|---------|------|
| `WEBSITE_PREVIEW_URL` | *(none)* | Base URL the local DevKinsta site is served at (e.g. `http://zoeeventsdmv.local`). **Needed for screenshots** — without it the preview has no images. |
| `DEVKINSTA_CONTAINER` | *(none)* | Docker container name/id of the DevKinsta WordPress container. Used by the `docker cp` fallback **only if the website repo has no `sync.ps1`**. |
| `DEVKINSTA_WP_PATH`   | `/var/www/html` | WordPress root inside the container, for the `docker cp` fallback. |
| `WEBSITE_MODEL`       | `claude-opus-4-8` | Model id passed to the Agent SDK. |
| `POLL_INTERVAL_MS`    | `15000` | How often to poll for new jobs / the approval decision. |
| `APPROVAL_TIMEOUT_MS` | `86400000` (1 day) | How long to wait for a human approve/discard before leaving the job in `preview` and moving on. |

### Local preview deploy

The runner applies the branch to DevKinsta one of two ways:
- **Preferred:** if the website repo has a `sync.ps1` at its root (the website redesign's docker-cp deploy
  script), the runner runs it via PowerShell.
- **Fallback:** if there's no `sync.ps1` but `DEVKINSTA_CONTAINER` is set, the runner `docker cp`s each
  changed file into `DEVKINSTA_CONTAINER:DEVKINSTA_WP_PATH/<file>`.
- If neither is configured, the preview deploy is **skipped** with a warning and the screenshots capture the
  site as it currently stands — set one of these up for a true preview.

This deploy is **local only** and never touches the live site.

## Run

```
cd tools/website-studio-runner
# set the env vars above (PowerShell: $env:ANTHROPIC_API_KEY="...", etc.)
node runner.js
```

Keep it running whenever marketing might submit requests. If it isn't running, jobs sit in the app at
**Queued** until it comes back — the blade tells marketers exactly that.

## Phase-2 TODO

- Move the runner to a **cloud box** and run it as a **service** (so it isn't tied to the office machine
  being on).
- Serve a real **shareable / interactive staging URL** instead of screenshots. Screenshots are the Phase-1
  preview; a live preview tunnel is Phase 2.
- In-app code-diff view, multi-turn follow-up on a job, and auto-deploy are also out of scope for Phase 1.
- **Security:** run the agent in a sandbox/container or as a lower-privilege user so even file writes can't
  escape the repo (the file tools run under `bypassPermissions`, so they can still write by absolute path).

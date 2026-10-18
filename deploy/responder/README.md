# Zoe AI Responder on Fly (`zoe-responder`)

Runs the responder loop (`scripts/responder/loop.md`) **headless, 24/7, on the Claude subscription** — no
office machine, no metered API. It drains the AI session bridge: answers Viktor's Slack questions, turns
operational asks into approval cards, files feature asks to the backlog, and (secondarily) advances
self-improvement runs. All of that happens through the dispatch app's bridge HTTP API; per `loop.md` it never
writes operational data directly and never merges or deploys.

## What runs WHERE (important — the responder is NOT a browser)

| Home | Runs | Why |
|---|---|---|
| **zoe-dispatch** (Fly app) | The web app + the **deterministic runtime tick** (Connecteam import, route auto-sync = assign + seniority + ratchet, staffing pre-check, worker debriefs, lifecycle, prep sweep, ETA pre-mint, people lifecycle, self-audit). Plus the one LLM job `sales-ai` (uses `ANTHROPIC_API_KEY`, metered). | Server-reachable integrations. Needs `RUNTIME_TOKEN` set to actually fire. |
| **zoe-responder** (this new Fly machine) | The **LLM brain**: the responder loop (Viktor Q&A, approvals, feature backlog, improvement PRs). | The subscription-priced reasoning layer. This is what **moves OFF your workstation.** |
| **Office machine + Chrome extension** (STILL required) | The **browser pulls + write-backs**: Goodshuffle routes/bookings, Instawork shifts + phone capture, Ignition ETA-link minting, the `gs_outbox` drainer, Gusto. | **Cloudflare blocks datacenter IPs.** These need a logged-in browser on a residential IP. The responder machine is a datacenter IP → it **cannot** do these. |

**So:** the responder machine replaces the *office Claude Code session* (the brain), not the *extension*.
Goodshuffle/Instawork/Ignition/Gusto pulls stay on the office machine until the separate "cloud browser
behind a residential proxy" project is built. The responder does not help with Cloudflare at all.

## One-time setup

1. **Generate the subscription token** (on any machine where you can log in to Claude):
   ```
   claude setup-token
   ```
   Copy the printed token. It bills to your Claude subscription and lasts ~1 year.

2. **Create the app + a volume** (from the repo root):
   ```
   flyctl apps create zoe-responder
   flyctl volumes create responder_data --app zoe-responder --region iad --size 1
   ```

3. **Set the secrets** (NO `ANTHROPIC_API_KEY` here — it would override the OAuth token and bill the metered
   API; `run-loop.mjs` refuses to start if one is present):
   ```
   flyctl secrets set CLAUDE_CODE_OAUTH_TOKEN=<the setup-token value> -a zoe-responder
   flyctl secrets set AI_BRIDGE_TOKEN=<same value as zoe-dispatch's AI_BRIDGE_TOKEN> -a zoe-responder
   ```

4. **Deploy** (from the repo root, so the Docker build context is the whole repo):
   ```
   flyctl deploy -c deploy/responder/fly.toml
   ```

5. **Verify:** `flyctl logs -a zoe-responder` should show `[responder] starting …` then `cycle ok …` every
   ~60s, and the dispatch app's responder-health should flip to alive (no "responder DOWN" Slack alarm).

## Footguns / caveats

- **Never set `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` on this app.** In headless mode they outrank the
  OAuth token and silently switch to metered API billing. The loop refuses to start if one is set.
- **Pin the Claude Code CLI version.** The headless flags (`--permission-mode`, `--allowedTools`, the
  `--bare` default) are version-sensitive. The Dockerfile `CLAUDE_CODE_VERSION` is PINNED (currently
  `2.1.302`), not floating `latest`. Bump it only after verifying the flags against the changelog, e.g.
  `flyctl deploy -c deploy/responder/fly.toml --build-arg CLAUDE_CODE_VERSION=<x.y.z>`.
- **`--allowedTools` is COMMA-separated** (`Bash,Read,Glob,Grep,WebFetch`), the documented form. A
  space-separated string parses as one rule that matches nothing and silently denies every tool.
- **Onboarding gate.** Headless `-p` refuses to run until `$HOME/.claude.json` has
  `"hasCompletedOnboarding": true`; on a fresh `/data` volume it's absent. `run-loop.mjs` sets it
  idempotently at startup (`ensureOnboarded`), so you don't have to.
- **"Not logged in" == HTTP 401.** If a cycle fails and the output says `Not logged in · Please run /login`,
  the token is being REJECTED by the API (bad / expired / whitespace-mangled when the secret was set), not an
  onboarding or infra problem. `claude auth status` showing `loggedIn: true` only means a token is present,
  not that it's accepted. Confirm with `claude -p hello --output-format json` (look for `"api_error_status":401`).
  Fix = regenerate (`claude setup-token`) and re-set the secret with NO trailing whitespace. The loop prints a
  pointed hint on this case instead of silently backing off.
- **Verify the invocation once interactively** before trusting it unattended: run the `claude -p … --allowedTools … --max-turns …` from `run-loop.mjs` by hand and confirm it completes a cycle without hanging on a permission prompt. Adjust `RESPONDER_PERMISSION_MODE` / `RESPONDER_ALLOWED_TOOLS` (env) if your CLI version needs different values.
- **Shared usage windows.** This draws from the SAME Max limits as your own interactive Claude use. If it
  competes with your usage, put the responder on its own seat.
- **Token renewal ~yearly.** Calendar it; re-run `claude setup-token` and update the secret. Watch Fly logs
  for `OAuth token revoked/expired`.
- **Confluence answers need the Atlassian MCP** configured in the container (not wired yet). Until then the
  loop answers from the app's own read endpoints and honestly says when it can't support an answer from
  Confluence. Wiring the MCP (a `claude mcp add` + its auth on the volume) is a follow-up.

## Tunables (env / Fly secrets)

`RESPONDER_INTERVAL_SEC` (60), `RESPONDER_MAX_TURNS` (40), `RESPONDER_ALLOWED_TOOLS` ("Bash,Read,Glob,Grep,WebFetch"),
`RESPONDER_PERMISSION_MODE` (acceptEdits), `RESPONDER_LIMIT_BACKOFF_SEC` (900),
`RESPONDER_MAX_BACKOFF_SEC` (1800), `APP_URL` (https://zoe-dispatch.fly.dev).

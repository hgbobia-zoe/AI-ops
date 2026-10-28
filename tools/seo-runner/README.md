# SEO keyword-pull runner (office machine)

Feeds the **SEO Growth** engine with real keyword data. Ubersuggest's MCP
(`https://ubersuggest-mcp.neilpatelapi.com/mcp`) authenticates by **OAuth sign-in with a Ubersuggest
account** — there is no API token, and Ubersuggest has no public REST API. Our app on Fly can't hold an
OAuth session, so this runner (on the office machine, a residential IP that can do the one-time browser
sign-in) runs the MCP client, pulls a small batch of **pending** keywords, and **pushes the raw results to the
app** at `/api/seo/ingest`. The app parses + scores them — the runner never decides anything.

Same pattern as `tools/gusto-runner` and `scripts/zoe-pull`: office executes, server governs.

## Honesty + free-tier behavior

- The runner **fabricates nothing**. It pushes only what a real MCP call returned.
- The account is **free** for now (a few keyword lookups/day). Each run pulls only `SEO_BATCH` (default **3**)
  pending keywords and **stops immediately** on a quota/limit response, posting `meta.limitHit` so the app's
  **watcher** records it and fires a (deduped) Slack alert: *"Ubersuggest daily limit reached…"*. The SEO
  Overview + health card show `discovered / total (pending)`, last pull, and last limit-hit.
- On a paid plan, raise `SEO_BATCH` and lower the drip interval in `install-service.ps1`.

## One-time setup

1. `powershell -ExecutionPolicy Bypass -File .\setup.ps1` — installs deps, creates `.env`.
2. Edit `.env`: set **`SEO_INGEST_TOKEN`** to the SAME value as the app's `SEO_INGEST_TOKEN` Fly secret
   (shared with `/api/seo/cron`; until it's set on both sides the ingest fails open).
3. **Sign in once:** `.\start.ps1` — opens a browser for the Ubersuggest OAuth. Authorize; the token is cached
   in `.seo-oauth/` and refreshed, so the scheduled task then runs **headless**.
4. **Install the drip:** `.\install-service.ps1` — registers the `ZoeSeoRunner` scheduled task (runs at logon
   and every 6h; each run pulls a batch and exits).

If the scheduled task runs before you've signed in, it exits cleanly and tells the app *"sign-in required"*
(shown on the SEO health card) — run `.\start.ps1` once to fix.

## First-run schema note

Our result parser is written defensively but the **live Ubersuggest tool name + response schema are
unverified** until your first signed-in run. That run dumps the real `tools/list` + a sample result to
`boot.log` AND posts `meta.toolsList` to the app (visible in the SEO Overview's "Recent retrievals" as an
`ingest.schema` row). If the real keyword tool isn't `keyword_overview` or the fields differ, set
`SEO_KEYWORD_TOOL` / `SEO_KEYWORD_ARG` / `SEO_TOOL_ARGS` in `.env` and (if needed) tweak the field aliases in
`src/lib/seo/discovery.ts` (`parseKeywordResult`). This is expected — one look, one tweak.

## Config (.env)

| Var | Default | Meaning |
|-----|---------|---------|
| `APP_URL` | — (required) | The Zoe app origin |
| `SEO_INGEST_TOKEN` | — | Shared secret; must match the app's env (fail-open until set) |
| `SEO_BATCH` | `3` | Pending keywords pulled per run (free-tier drip) |
| `SEO_KEYWORD_TOOL` | `keyword_overview` | The MCP keyword tool (confirm on first run) |
| `SEO_KEYWORD_ARG` | `keyword` | The tool's keyword argument name |
| `SEO_TOOL_ARGS` | `{"country":"US","language":"en"}` | Extra static tool args (JSON) |
| `UBERSUGGEST_MCP_URL` | neilpatelapi MCP | Override only for staging |
| `SEO_OAUTH_PORT` | `7331` | Loopback port for the one-time sign-in |
| `SEO_CACHE_DIR` | `./.seo-oauth` | Where OAuth tokens are cached |

## How a run flows

1. `GET /api/seo/ingest?pending=<SEO_BATCH>` → the app returns the next seed keywords not yet discovered.
2. Connect the MCP client (OAuth; interactive only via `start.ps1`).
3. Call the keyword tool per pending keyword; stop on a limit response.
4. `POST /api/seo/ingest` with `{ keywords: [{ keyword, category, location, intent, rawResult }], meta }`.
5. The app parses → gates → upserts → analyzes → advances each to `ANALYZING`, and records freshness / limit.

Logs: `boot.log` in this folder (the scheduled task discards stdout/stderr, so always check there).

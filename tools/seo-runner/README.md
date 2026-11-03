# SEO data feeds (office machine)

## Primary: weekly Ubersuggest feed (`push-ubersuggest.mjs`)

Ubersuggest's connector **is** signed in inside Claude (an official client), so a **scheduled Claude task** on the
office PC reads the Zoe project's weekly rank-tracking report (`project_position_info`) and pushes it here with
`push-ubersuggest.mjs`. Each tracked keyword lands as an opportunity with **real search volume, SEO difficulty and
Zoe's tracked position** (or a final "not in the top 100"). Reading rank tracking does not use the free plan's 3
daily searches.

- Install: copy `push-ubersuggest.mjs` next to the runner's `.env` (`C:\Git\zoe-seo-runner`), which already
  holds `APP_URL` + `SEO_INGEST_TOKEN`.
- Run: `node push-ubersuggest.mjs <report.json>` (`--dry-run` prints the payload; `--error "<msg>"` records an
  honest failure, e.g. the connector signed out). It refuses to push until the deployed app lists
  `ubersuggest_project` in `GET /api/seo/ingest` `sources`, and refuses a non-final (`done:false`) report.
- Schedule: the Claude desktop scheduled task "SEO weekly Ubersuggest feed" (Sundays 10:00; prompt in
  `weekly-task-prompt.md`). It runs while the
  Claude app is open; a missed run fires on the next launch.
- Tracked keywords, competitors and location are managed in Ubersuggest itself (project "Zoe Event Rentals").
  The free plan allows 25 keywords and 1 location.

## Optional: Google SERP-pull runner (`runner.mjs`)

Feeds the **SEO Growth** competitive-gap engine with real data. We read **live Google SERPs** for Zoe's
tracked keywords and look at who ranks: which competitor domains own page 1, and whether Zoe appears and where.
That is the gap.

**Why the office machine:** Google blocks datacenter IPs (our Fly app can't read SERPs), but a residential
office machine can. So this runner reads a small batch of **pending** keywords' SERPs and **pushes the observed
results to the app** at `/api/seo/ingest` (`meta.source = "serp"`). The app computes the gap, scores priority,
and surfaces findings. The runner never decides anything. Same pattern as `tools/gusto-runner`: office
executes, server governs.

> This replaced the old Ubersuggest MCP runner. Ubersuggest's OAuth server only trusts its own official
> clients, so a custom runner could never sign in. SERP reading needs no account and no sign-in.

## Honesty + what it does NOT do

- The runner **fabricates nothing**. It pushes only what it actually read on the page.
- A SERP read gives **rankings, not search volume/difficulty** — those stay honest UNKNOWN in the engine.
- Google serves a **consent wall / CAPTCHA / empty page** to automation. When a read looks blocked the runner
  sets `meta.blocked`, pushes **zero rows**, and stops — the app's health card shows "blocked" rather than any
  invented data. Keep `SEO_BATCH` tiny (a few/run) so the drip stays under the radar.
- Fragility is real: Google's HTML is undocumented and drifts. If the parser stops finding results the run
  reports blocked (honest) instead of guessing. To move to a robust source later, flip `SEO_SERP_PROVIDER=api`
  and point `SEO_SERP_ENDPOINT` at a SERP API — no app change (the ingest shape is identical).

## One-time setup

1. `powershell -ExecutionPolicy Bypass -File .\setup.ps1` — creates `.env` (no dependencies to install).
2. Edit `.env`: set **`SEO_INGEST_TOKEN`** (same value as the app's Fly secret), **`SEO_ZOE_DOMAIN`**, and
   **`SEO_COMPETITOR_DOMAINS`** (the local rivals to track first).
3. **Test one read:** `.\start.ps1` — reads a small batch in the foreground and pushes it. Check `boot.log` and
   the SEO Overview.
4. **Install the drip:** `.\install-service.ps1` — registers the `ZoeSeoRunner` scheduled task (at logon + every
   6h; each run reads a batch and exits).

## Config (.env)

| Var | Default | Meaning |
|-----|---------|---------|
| `APP_URL` | — (required) | The Zoe app origin |
| `SEO_INGEST_TOKEN` | — | Shared secret; must match the app's env (fail-open until set) |
| `SEO_ZOE_DOMAIN` | `zoeeventsdmv.com` | Zoe's own domain — found in the SERP to get Zoe's rank |
| `SEO_COMPETITOR_DOMAINS` | (empty) | Comma-separated rival hosts to surface first |
| `SEO_BATCH` | `3` | Keywords read per run (keep small — Google blocks volume) |
| `SEO_SERP_GL` / `SEO_SERP_HL` | `us` / `en` | SERP geo + language |
| `SEO_QUERY_DELAY_MS` | `2500` | Pause between queries |
| `SEO_SERP_PROVIDER` | `google-html` | `google-html` (free, fragile) or `api` (robust drop-in) |
| `SEO_SERP_ENDPOINT` / `SEO_SERP_API_KEY` | — | For `provider=api`: a JSON SERP API URL (`{q}`/`{gl}`/`{hl}`) + key |

## How a run flows

1. `GET /api/seo/ingest?pending=<SEO_BATCH>` → the app returns the next seed keywords not yet read.
2. For each, read the Google SERP (residential IP). Parse organic results, People-Also-Ask, related searches.
3. `POST /api/seo/ingest` with `{ keywords: [{ keyword, category, location, intent, rawResult }], meta: {
   source:"serp", zoeDomain, blocked, retrievedAt } }`.
4. The app parses the SERP (`src/lib/seo/serp.ts`), detects Zoe's rank + competitors, scores the competitive
   gap, and advances each opportunity to `ANALYZING`.

Logs: `boot.log` in this folder (the scheduled task discards stdout/stderr, so always check there).

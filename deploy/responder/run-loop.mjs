// The Zoe AI responder loop (Fly). Each cycle runs ONE pass of scripts/responder/loop.md via `claude -p`,
// headless, on the Claude SUBSCRIPTION (CLAUDE_CODE_OAUTH_TOKEN) — not the metered API. Between cycles it
// sleeps RESPONDER_INTERVAL_SEC; on a usage-limit it backs off long (the limit resets hours later); on any
// other failure it backs off exponentially. Dependency-free (Node 22). Fly logs show each cycle's output.
//
// SAFETY: this is an unattended agent that TAKES ACTIONS (answers Slack, raises approvals) via the bridge
// HTTP API only — per loop.md it never writes operational data directly and never merges/deploys. The tool
// allowlist below is deliberately narrow.

import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Repo root = two dirs up from deploy/responder/, resolved from THIS file so the CWD can't break it.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const env = (k, d) => {
  const v = process.env[k];
  return v == null || v === "" ? d : v;
};

// ── Guards (fail fast + loud) ────────────────────────────────────────────────────────────────────────────
// Auth source: EITHER the env OAuth token (subscription, from `claude setup-token`) OR an interactive login
// stored on the volume ($HOME/.claude/.credentials.json, created by running `claude` + /login ON the machine
// and auto-refreshed by the CLI). One must be present. The stored-login path is the fallback for when a
// setup-token env token is rejected by headless `-p` (HTTP 401 "Invalid bearer token"). NOTE: when BOTH
// exist the env token takes precedence (and would 401), so to use the stored login the env secret must be
// UNSET. An API key is refused below regardless (it would silently meter-bill).
const CREDENTIALS_FILE = join(process.env.HOME || "/data", ".claude", ".credentials.json");
const hasEnvToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const hasStoredLogin = existsSync(CREDENTIALS_FILE);
if (!hasEnvToken && !hasStoredLogin) {
  console.error(
    `FATAL: no Claude auth available. Either set CLAUDE_CODE_OAUTH_TOKEN (run \`claude setup-token\`, set it as a Fly secret), ` +
      `OR log in on the machine: \`flyctl ssh console -a zoe-responder\`, then \`env HOME=/data claude\` and /login (writes ${CREDENTIALS_FILE}, persists on the volume).`,
  );
  process.exit(2);
}
if (hasEnvToken && hasStoredLogin) {
  console.warn("[responder] both CLAUDE_CODE_OAUTH_TOKEN and a stored login are present — the env token OUTRANKS the file. If the env token is 401ing, unset it (flyctl secrets unset CLAUDE_CODE_OAUTH_TOKEN -a zoe-responder) to use the stored login.");
}
// The footgun: in headless mode an API key/auth token OUTRANKS the OAuth token and bills the metered API.
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
  if (process.env[k]) {
    console.error(`FATAL: ${k} is set on this app — refusing to start. It would override the subscription OAuth token and bill the metered API. Unset it: flyctl secrets unset ${k} -a zoe-responder`);
    process.exit(2);
  }
}
if (!process.env.AI_BRIDGE_TOKEN) {
  console.error("FATAL: AI_BRIDGE_TOKEN is not set (the bridge token — the SAME value as zoe-dispatch's AI_BRIDGE_TOKEN secret).");
  process.exit(2);
}

// ── Config ──────────────────────────────────────────────────────────────────────────────────────────────
const INTERVAL_MS = Number(env("RESPONDER_INTERVAL_SEC", "60")) * 1000;
const MAX_TURNS = env("RESPONDER_MAX_TURNS", "40");
// Narrow allowlist: the loop acts via curl (Bash) + reads files; WebFetch for public docs. Expand only
// deliberately (e.g. add Edit/Write + git for improvement-run PRs). See README. COMMA-separated — that's the
// documented --allowedTools form; a space-separated string parses as ONE rule that matches nothing, silently
// denying every tool.
const ALLOWED_TOOLS = env("RESPONDER_ALLOWED_TOOLS", "Bash,Read,Glob,Grep,WebFetch");
const PERMISSION_MODE = env("RESPONDER_PERMISSION_MODE", "acceptEdits");
const LIMIT_BACKOFF_MS = Number(env("RESPONDER_LIMIT_BACKOFF_SEC", "900")) * 1000; // 15m on a usage limit
const MAX_BACKOFF_MS = Number(env("RESPONDER_MAX_BACKOFF_SEC", "1800")) * 1000; // cap other-error backoff at 30m

const PROMPT = readFileSync(join(REPO_ROOT, "scripts", "responder", "loop.md"), "utf8") + "\n\n---\nRun exactly ONE cycle of the above now, then stop.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Subscription usage-limit signals (so we back off until it resets instead of hammering it).
const LIMIT_RE = /(usage|session|weekly|opus|sonnet|rate)[^.\n]{0,24}limit|limit[^.\n]{0,24}(reached|reset)|too many requests|\b429\b|insufficient[_ ]?quota/i;
// Auth-rejection signals: the CLI prints "Not logged in" for an HTTP 401 (a bad/expired/whitespace-mangled
// OAuth token), which is NOT a transient error — retrying can't fix it. We surface a pointed hint so the fix
// (re-set CLAUDE_CODE_OAUTH_TOKEN) is obvious in the logs instead of a silent back-off loop.
const AUTH_RE = /not logged in|please run \/login|"?api_error_status"?\s*:?\s*401|invalid bearer/i;

// Claude Code gates headless `-p` behind an "onboarding complete" flag in $HOME/.claude.json. On a fresh
// volume that file is absent or lacks the key, so `-p` can refuse with a misleading "Not logged in" even with
// a valid token. Set the flag idempotently before the first cycle. Never clobber an existing config on a
// parse error (that file holds real session state).
function ensureOnboarded() {
  const cfgPath = join(process.env.HOME || "/data", ".claude.json");
  try {
    let cfg = {};
    if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    if (cfg.hasCompletedOnboarding === true) return;
    cfg.hasCompletedOnboarding = true;
    writeFileSync(cfgPath, JSON.stringify(cfg));
    console.log(`[responder] set hasCompletedOnboarding in ${cfgPath}`);
  } catch (e) {
    console.warn(`[responder] could not ensure onboarding flag (${e && e.message ? e.message : e}) — continuing`);
  }
}

function runCycle() {
  return new Promise((resolve) => {
    const args = ["-p", PROMPT, "--permission-mode", PERMISSION_MODE, "--allowedTools", ALLOWED_TOOLS, "--max-turns", String(MAX_TURNS)];
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env, cwd: REPO_ROOT });
    let out = "";
    const cap = (b) => {
      const s = b.toString();
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", (e) => resolve({ code: -1, out: String(e && e.message ? e.message : e) }));
  });
}

let backoff = 0;
async function main() {
  console.log(`[responder] starting — auth=${hasEnvToken ? "env-token" : "stored-login"} interval=${INTERVAL_MS / 1000}s max-turns=${MAX_TURNS} mode=${PERMISSION_MODE} tools="${ALLOWED_TOOLS}"`);
  ensureOnboarded();
  for (;;) {
    const started = Date.now();
    const { code, out } = await runCycle();
    const limited = LIMIT_RE.test(out);
    if (code === 0 && !limited) {
      backoff = 0;
      console.log(`[responder] cycle ok in ${((Date.now() - started) / 1000).toFixed(0)}s — sleeping ${INTERVAL_MS / 1000}s`);
      await sleep(INTERVAL_MS);
    } else if (limited) {
      console.warn(`[responder] subscription usage limit hit — backing off ${LIMIT_BACKOFF_MS / 1000}s (it resets later)`);
      await sleep(LIMIT_BACKOFF_MS);
    } else {
      if (AUTH_RE.test(out)) {
        console.error('[responder] AUTH REJECTED (HTTP 401 — the CLI reports "Not logged in"). The OAuth token is bad/expired/whitespace-mangled; retrying will not fix it. Regenerate with `claude setup-token` and re-set it cleanly: flyctl secrets set CLAUDE_CODE_OAUTH_TOKEN=<token> -a zoe-responder');
      }
      backoff = Math.min(backoff ? backoff * 2 : INTERVAL_MS, MAX_BACKOFF_MS);
      console.warn(`[responder] cycle failed (exit ${code}) — backing off ${backoff / 1000}s`);
      await sleep(backoff);
    }
  }
}

main().catch((e) => {
  console.error("[responder] fatal:", e && e.message ? e.message : e);
  process.exit(1);
});

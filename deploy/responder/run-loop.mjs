// The Zoe AI responder loop (Fly). Each cycle runs ONE pass of scripts/responder/loop.md via `claude -p`,
// headless, on the Claude SUBSCRIPTION (CLAUDE_CODE_OAUTH_TOKEN) — not the metered API. Between cycles it
// sleeps RESPONDER_INTERVAL_SEC; on a usage-limit it backs off long (the limit resets hours later); on any
// other failure it backs off exponentially. Dependency-free (Node 22). Fly logs show each cycle's output.
//
// SAFETY: this is an unattended agent that TAKES ACTIONS (answers Slack, raises approvals) via the bridge
// HTTP API only — per loop.md it never writes operational data directly and never merges/deploys. The tool
// allowlist below is deliberately narrow.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const env = (k, d) => {
  const v = process.env[k];
  return v == null || v === "" ? d : v;
};

// ── Guards (fail fast + loud) ────────────────────────────────────────────────────────────────────────────
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error("FATAL: CLAUDE_CODE_OAUTH_TOKEN is not set. Run `claude setup-token` and set it as a Fly secret on this app.");
  process.exit(2);
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
// deliberately (e.g. add Edit/Write + git for improvement-run PRs). See README. Space-separated.
const ALLOWED_TOOLS = env("RESPONDER_ALLOWED_TOOLS", "Bash Read Glob Grep WebFetch");
const PERMISSION_MODE = env("RESPONDER_PERMISSION_MODE", "acceptEdits");
const LIMIT_BACKOFF_MS = Number(env("RESPONDER_LIMIT_BACKOFF_SEC", "900")) * 1000; // 15m on a usage limit
const MAX_BACKOFF_MS = Number(env("RESPONDER_MAX_BACKOFF_SEC", "1800")) * 1000; // cap other-error backoff at 30m

const PROMPT = readFileSync("scripts/responder/loop.md", "utf8") + "\n\n---\nRun exactly ONE cycle of the above now, then stop.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Subscription usage-limit signals (so we back off until it resets instead of hammering it).
const LIMIT_RE = /(usage|session|weekly|opus|sonnet|rate)[^.\n]{0,24}limit|limit[^.\n]{0,24}(reached|reset)|too many requests|\b429\b|insufficient[_ ]?quota/i;

function runCycle() {
  return new Promise((resolve) => {
    const args = ["-p", PROMPT, "--permission-mode", PERMISSION_MODE, "--allowedTools", ALLOWED_TOOLS, "--max-turns", String(MAX_TURNS)];
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
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
  console.log(`[responder] starting — interval=${INTERVAL_MS / 1000}s max-turns=${MAX_TURNS} mode=${PERMISSION_MODE} tools="${ALLOWED_TOOLS}"`);
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

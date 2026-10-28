// SEO keyword-pull — office-machine runner (path B).
//
// WHY THIS EXISTS: Ubersuggest's MCP (https://ubersuggest-mcp.neilpatelapi.com/mcp) authenticates by OAuth
// sign-in with a Ubersuggest account — there is NO static API token, and Ubersuggest has no public REST API.
// Our app on Fly can't hold an OAuth session, so the OFFICE MACHINE (residential, can do the one-time browser
// sign-in) runs the MCP client, pulls a small batch of pending keywords, and PUSHES the raw results to the app
// at /api/seo/ingest. Mirrors tools/gusto-runner (office executes, server governs). The app parses + scores.
//
// FREE-TIER SAFE: the account is free for now (a few lookups/day), so each run pulls only SEO_BATCH pending
// keywords and STOPS on the first quota/limit response, posting meta.limitHit so the app's watcher alerts.
// Nothing is fabricated: a limit-hit sends zero keyword rows.
//
// FIRST RUN: must be interactive (run start.ps1) so you can complete the Ubersuggest OAuth sign-in in the
// browser; the tokens are cached locally and refreshed, so the scheduled task then runs headless. The first
// successful run also dumps tools/list + a sample result to boot.log AND posts meta.toolsList, so the REAL
// Ubersuggest tool name + response schema are captured (ours is written defensively and unverified).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve .env, the token cache and boot.log against THIS script's dir, never the cwd — a Windows Scheduled
// Task does not reliably honor its "Start in" dir (see tools/gusto-runner).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ── bootstrap crash log (the scheduled task discards stdout/stderr) ──────────────────────────────────
const BOOT_LOG = join(SCRIPT_DIR, "boot.log");
function bootLog(tag, ...a) {
  try {
    const parts = a.map((x) => (typeof x === "string" ? x : (x && x.stack) || JSON.stringify(x)));
    appendFileSync(BOOT_LOG, `${new Date().toISOString()} [${tag}] ${parts.join(" ")}\n`);
  } catch { /* logging must never crash the runner */ }
}
{
  const _log = console.log.bind(console);
  const _err = console.error.bind(console);
  console.log = (...a) => { bootLog("log", ...a); _log(...a); };
  console.error = (...a) => { bootLog("err", ...a); _err(...a); };
  process.on("uncaughtException", (e) => bootLog("uncaughtException", e));
  process.on("unhandledRejection", (e) => bootLog("unhandledRejection", e));
  process.on("exit", (code) => bootLog("exit", `code=${code}`));
}

// ── load .env (KEY=VALUE per line; a real env var wins) ──────────────────────────────────────────────
(function loadDotEnv() {
  try {
    const p = process.env.SEO_RUNNER_ENV || join(SCRIPT_DIR, ".env");
    if (!existsSync(p)) return;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trimStart().startsWith("#")) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch { /* a malformed .env is non-fatal */ }
})();

// ── config ───────────────────────────────────────────────────────────────────────────────────────────
const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");
const INGEST_TOKEN = process.env.SEO_INGEST_TOKEN || "";
const MCP_URL = process.env.UBERSUGGEST_MCP_URL || "https://ubersuggest-mcp.neilpatelapi.com/mcp";
// The keyword tool + its arg mapping are CONFIGURABLE because the live schema is unverified until the first
// signed-in run (which dumps the real tools/list). Defaults match the app's server-side guess.
const KEYWORD_TOOL = process.env.SEO_KEYWORD_TOOL || "keyword_overview";
const KEYWORD_ARG = process.env.SEO_KEYWORD_ARG || "keyword";
const TOOL_ARGS = (() => { try { return JSON.parse(process.env.SEO_TOOL_ARGS || '{"country":"US","language":"en"}'); } catch { return { country: "US", language: "en" }; } })();
const BATCH = Math.max(1, Math.min(Number(process.env.SEO_BATCH || 3) || 3, 50));
const CACHE_DIR = process.env.SEO_CACHE_DIR || join(SCRIPT_DIR, ".seo-oauth");
const REDIRECT_PORT = Number(process.env.SEO_OAUTH_PORT || 7331) || 7331;
const REDIRECT_URL = `http://localhost:${REDIRECT_PORT}/callback`;
// start.ps1 sets this so a human-run invocation may open the browser for sign-in; the scheduled task does NOT
// set it, so an unauthenticated headless run exits cleanly with a "sign-in required" note instead of hanging.
const ALLOW_INTERACTIVE = /^(1|true|yes|on)$/i.test(process.env.SEO_ALLOW_INTERACTIVE || "");
const LIMIT_RE = new RegExp(process.env.SEO_LIMIT_PATTERN || "limit|quota|exceed|upgrade|too many|rate.?limit|429|insufficient", "i");

function requireEnv() {
  const missing = [];
  if (!APP_URL) missing.push("APP_URL");
  if (missing.length) { console.error(`[seo-runner] missing required env: ${missing.join(", ")} — see README`); process.exit(1); }
}

const log = (...a) => console.log(`[seo-runner] ${new Date().toISOString()}`, ...a);
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

// ── file-backed OAuth client provider (MCP SDK OAuthClientProvider) ──────────────────────────────────
// Stores the dynamic client registration, PKCE verifier and tokens in CACHE_DIR so the OAuth session persists
// (and refreshes) across runs — a one-time interactive sign-in, headless thereafter.
function readJson(name) { try { return JSON.parse(readFileSync(join(CACHE_DIR, name), "utf8")); } catch { return undefined; } }
function writeJson(name, v) { writeFileSync(join(CACHE_DIR, name), JSON.stringify(v, null, 2)); }

let pendingAuthUrl = null; // set by redirectToAuthorization when a sign-in is needed

const authProvider = {
  get redirectUrl() { return REDIRECT_URL; },
  get clientMetadata() {
    return { client_name: "Zoe Ops SEO Runner", redirect_uris: [REDIRECT_URL], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  },
  clientInformation() { return readJson("client.json"); },
  saveClientInformation(info) { writeJson("client.json", info); },
  tokens() { return readJson("tokens.json"); },
  saveTokens(tokens) { writeJson("tokens.json", tokens); },
  saveCodeVerifier(v) { writeJson("verifier.json", { v }); },
  codeVerifier() { const r = readJson("verifier.json"); if (!r?.v) throw new Error("no code_verifier cached"); return r.v; },
  // The SDK calls this when it needs the user to authorize. We stash the URL; main() opens it + waits for the
  // code on our localhost callback, then calls transport.finishAuth(code).
  redirectToAuthorization(authorizationUrl) { pendingAuthUrl = authorizationUrl.toString(); },
};

/** Run a one-shot localhost server to capture the OAuth ?code= redirect. Resolves with the code. */
function waitForCallbackCode(timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const u = new URL(req.url, REDIRECT_URL);
        const code = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body style="font-family:sans-serif;padding:2rem"><h2>${code ? "Ubersuggest connected — you can close this tab." : "Sign-in failed: " + (err || "no code")}</h2></body></html>`);
        if (code) { server.close(); resolve(code); }
        else if (err) { server.close(); reject(new Error(`oauth error: ${err}`)); }
      } catch (e) { reject(e); }
    });
    server.on("error", reject);
    server.listen(REDIRECT_PORT, () => log(`waiting for OAuth callback on ${REDIRECT_URL}`));
    setTimeout(() => { server.close(); reject(new Error("timed out waiting for OAuth sign-in")); }, timeoutMs);
  });
}

function openBrowser(url) {
  // Windows: `cmd /c start "" <url>`. Best-effort; if it fails the URL is in boot.log for a manual open.
  try { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); }
  catch (e) { bootLog("err", `could not open browser: ${String(e)} — open manually: ${url}`); }
}

/** Connect an MCP client to Ubersuggest, running the interactive OAuth flow if needed (and allowed). */
async function connect() {
  const client = new Client({ name: "zoe-seo-runner", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider });
  try {
    await client.connect(transport);
    return client;
  } catch (e) {
    if (!(e instanceof UnauthorizedError) && !pendingAuthUrl) throw e;
    if (!ALLOW_INTERACTIVE) {
      const msg = "Ubersuggest sign-in required — run start.ps1 once to authorize (then the scheduled task runs headless).";
      bootLog("signin_required", msg);
      const e2 = new Error(msg); e2.signinRequired = true; throw e2;
    }
    if (!pendingAuthUrl) throw e;
    log("opening browser for Ubersuggest OAuth sign-in…");
    openBrowser(pendingAuthUrl);
    const code = await waitForCallbackCode();
    await transport.finishAuth(code);
    // Reconnect with the freshly-saved tokens.
    const client2 = new Client({ name: "zoe-seo-runner", version: "0.1.0" }, { capabilities: {} });
    await client2.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider }));
    return client2;
  }
}

async function appFetch(path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (INGEST_TOKEN) headers["x-seo-token"] = INGEST_TOKEN;
  return fetch(`${APP_URL}${path}`, { ...init, headers });
}

/** Does a tool call look like a quota/limit response? (free-tier daily cap). */
function looksLimited(result, errText) {
  if (errText && LIMIT_RE.test(errText)) return true;
  try {
    if (result?.isError) {
      const txt = JSON.stringify(result.content ?? result);
      if (LIMIT_RE.test(txt)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

async function main() {
  requireEnv();
  bootLog("boot", `node ${process.version} cwd=${process.cwd()} script=${SCRIPT_DIR} app=${APP_URL} tool=${KEYWORD_TOOL} batch=${BATCH} interactive=${ALLOW_INTERACTIVE}`);

  // 1) What should we pull next? (the app computes pending = seeds − already discovered)
  let pending = [];
  try {
    const res = await appFetch(`/api/seo/ingest?pending=${BATCH}`);
    if (!res.ok) { log(`pending fetch → ${res.status}`); process.exit(res.status === 401 ? 1 : 0); }
    pending = (await res.json()).pending ?? [];
  } catch (e) { console.error(`[seo-runner] could not reach the app: ${e.message}`); process.exit(1); }
  if (pending.length === 0) { log("nothing pending — all seed keywords discovered. Exiting."); return; }
  log(`pending: ${pending.length} keyword(s) to pull this run`);

  // 2) Connect to Ubersuggest (OAuth). A scheduled (non-interactive) run with no cached token exits cleanly
  //    after telling the app so the health card shows "sign-in required".
  let client;
  try {
    client = await connect();
  } catch (e) {
    if (e.signinRequired) {
      await appFetch("/api/seo/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keywords: [], meta: { error: e.message } }) }).catch(() => {});
      process.exit(0);
    }
    throw e;
  }

  // 3) First-run schema capture: dump the live tools/list (ours is unverified).
  let toolsList;
  try {
    const t = await client.listTools();
    toolsList = t.tools?.map((x) => ({ name: x.name, description: x.description })) ?? t;
    bootLog("tools", JSON.stringify(toolsList));
    log(`MCP exposes ${Array.isArray(toolsList) ? toolsList.length : "?"} tool(s). Using "${KEYWORD_TOOL}".`);
  } catch (e) { bootLog("err", `listTools failed: ${String(e)}`); }

  // 4) Pull the batch; STOP immediately on a quota/limit response (never retry into a limit).
  const keywords = [];
  let limitHit = false;
  let sampleDumped = false;
  for (const seed of pending) {
    let result, errText;
    try {
      result = await client.callTool({ name: KEYWORD_TOOL, arguments: { [KEYWORD_ARG]: seed.keyword, ...TOOL_ARGS } });
    } catch (e) { errText = String(e?.message || e); }
    if (looksLimited(result, errText)) { limitHit = true; log(`daily limit reached at "${seed.keyword}" — stopping.`); break; }
    if (errText) { bootLog("err", `tool error for "${seed.keyword}": ${errText}`); continue; }
    if (!sampleDumped) { bootLog("sample", `"${seed.keyword}" → ${JSON.stringify(result).slice(0, 2000)}`); sampleDumped = true; }
    keywords.push({ keyword: seed.keyword, category: seed.category, location: seed.location, intent: seed.intent, rawResult: result });
  }
  try { await client.close(); } catch { /* ignore */ }

  // 5) Push to the app (even an empty batch on a limit-hit, so the watcher records + alerts).
  const body = { keywords, meta: { toolName: KEYWORD_TOOL, toolsList, limitHit, retrievedAt: new Date().toISOString() } };
  try {
    const res = await appFetch("/api/seo/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    log(`pushed ${keywords.length} keyword(s)${limitHit ? " (LIMIT HIT)" : ""} → ${res.status} ${JSON.stringify(json.result ?? json)}`);
  } catch (e) { console.error(`[seo-runner] push failed: ${e.message}`); process.exit(1); }
}

main().catch((e) => { console.error("[seo-runner] fatal:", e); process.exit(1); });

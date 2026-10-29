// SEO SERP-pull — office-machine runner (the current SEO data source).
//
// WHY THIS EXISTS: Ubersuggest's MCP was OAuth-only and its auth server rejects any non-official client, so we
// cannot sign a headless runner in. We pivoted the SEO engine to read LIVE GOOGLE SERPs instead. The app on Fly
// is a datacenter IP (Google blocks that); the OFFICE MACHINE is residential, so IT reads the SERPs and PUSHES
// the observed results to the app at /api/seo/ingest (meta.source = "serp"). The app computes the competitive
// gap (who ranks, whether Zoe appears and where). Mirrors tools/gusto-runner: office executes, server governs.
//
// HONESTY LAW: this runner NEVER fabricates a ranking. It pushes only what it actually read. Google serves a
// consent wall / CAPTCHA / empty page to automation; when a read looks blocked the runner sets meta.blocked and
// STOPS (pushes zero rows) so the app's health/watcher surface it honestly. Keep the drip tiny (SEO_BATCH).
//
// DATA SHAPE pushed per keyword (rawResult): { organic: [{ rank, url, title }], peopleAlsoAsk: string[],
// relatedSearches: string[], retrievedAt } — parsed by src/lib/seo/serp.ts (defensive about this shape).
//
// FRAGILITY: Google's HTML is undocumented and DRIFTS. The parse below is best-effort and isolated in
// parseGoogleHtml(); if it stops finding results the run reports blocked (honest) rather than inventing data.
// A future robust source drops in via the SEO_SERP_PROVIDER seam (e.g. a SERP API) without touching the app.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve .env + boot.log against THIS script's dir, never the cwd — a Windows Scheduled Task does not reliably
// honor its "Start in" dir (see tools/gusto-runner).
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
const ZOE_DOMAIN = (process.env.SEO_ZOE_DOMAIN || "zoeeventsdmv.com").trim();
const COMPETITOR_DOMAINS = (process.env.SEO_COMPETITOR_DOMAINS || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const BATCH = Math.max(1, Math.min(Number(process.env.SEO_BATCH || 3) || 3, 25));
const GL = (process.env.SEO_SERP_GL || "us").toLowerCase();
const HL = (process.env.SEO_SERP_HL || "en").toLowerCase();
const PROVIDER = (process.env.SEO_SERP_PROVIDER || "google-html").toLowerCase();
// Optional generic SERP-API provider (set SEO_SERP_PROVIDER=api). Robust/paid; a drop-in for google-html.
const SERP_API_ENDPOINT = process.env.SEO_SERP_ENDPOINT || "";
const SERP_API_KEY = process.env.SEO_SERP_API_KEY || "";
// Polite pause between queries to look human + stay under Google's radar on the tiny drip.
const QUERY_DELAY_MS = Math.max(0, Number(process.env.SEO_QUERY_DELAY_MS || 2500) || 2500);

const UA =
  process.env.SEO_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const log = (...a) => console.log(`[seo-runner] ${new Date().toISOString()}`, ...a);

function requireEnv() {
  if (!APP_URL) { console.error("[seo-runner] missing required env: APP_URL — see README"); process.exit(1); }
}

async function appFetch(path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (INGEST_TOKEN) headers["x-seo-token"] = INGEST_TOKEN;
  return fetch(`${APP_URL}${path}`, { ...init, headers });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Google SERP read (best-effort HTML) ───────────────────────────────────────────────────────────────
// Google infra / non-result hosts to skip when harvesting result links.
const SKIP_HOSTS = /(^|\.)(google\.|gstatic\.com|googleusercontent\.com|googleadservices\.com|youtube\.com\/redirect|schema\.org|w3\.org)/i;

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").trim();
}

/**
 * Parse a Google results HTML page into organic results + PAA + related searches. BEST-EFFORT and DRIFT-PRONE
 * (Google's markup is undocumented and changes) — isolated here on purpose. Returns { organic, peopleAlsoAsk,
 * relatedSearches }. An empty organic list is treated by the caller as "blocked/empty", never as real data.
 */
function parseGoogleHtml(html) {
  const organic = [];
  const seen = new Set();
  // Result anchors appear either as a direct external href or wrapped in Google's /url?q= redirector. Harvest
  // both, in document order, and pull the nearest following <h3> as the title.
  const anchorRe = /<a\s+[^>]*href="(\/url\?q=[^"]+|https?:\/\/[^"]+)"[^>]*>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null && organic.length < 20) {
    let href = m[1];
    if (href.startsWith("/url?q=")) {
      const q = /[?&]q=([^&]+)/.exec(href);
      if (!q) continue;
      try { href = decodeURIComponent(q[1]); } catch { continue; }
    }
    if (!/^https?:\/\//i.test(href)) continue;
    let host;
    try { host = new URL(href).hostname; } catch { continue; }
    if (SKIP_HOSTS.test(host)) continue;
    if (seen.has(host)) continue; // one result row per host (keep its best position)
    seen.add(host);
    // Title: the nearest <h3>…</h3> within a window after the anchor (Google wraps the title in an h3).
    const after = html.slice(m.index, m.index + 600);
    const h3 = /<h3[^>]*>(.*?)<\/h3>/i.exec(after);
    const title = h3 ? stripTags(h3[1]).slice(0, 200) : null;
    organic.push({ rank: organic.length + 1, url: href, title });
  }

  // "People also ask" + "Related searches" are best-effort: harvest question-ish / related anchor text blocks.
  const peopleAlsoAsk = [];
  const paaRe = /data-q="([^"]+)"/gi;
  while ((m = paaRe.exec(html)) !== null && peopleAlsoAsk.length < 20) peopleAlsoAsk.push(stripTags(m[1]));

  const relatedSearches = [];
  // Related searches link to /search?q=…; capture their visible text.
  const relRe = /<a[^>]+href="\/search\?[^"]*q=([^"&]+)[^"]*"[^>]*>(?:<[^>]+>)*([^<]{3,80})</gi;
  while ((m = relRe.exec(html)) !== null && relatedSearches.length < 20) {
    const txt = stripTags(m[2]);
    if (txt && !/^https?:/i.test(txt)) relatedSearches.push(txt);
  }

  return { organic, peopleAlsoAsk: dedupe(peopleAlsoAsk), relatedSearches: dedupe(relatedSearches) };
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) { const k = s.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(s); } }
  return out;
}

const BLOCK_RE = /unusual traffic|detected unusual|our systems have detected|recaptcha|\/sorry\/|enablejs|before you continue to google/i;

/** Read one keyword's SERP. Returns { ok, blocked, rawResult } — rawResult is the parsed SERP for the app. */
async function readGoogleSerp(keyword) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&num=20&gl=${GL}&hl=${HL}&pws=0`;
  let res, html;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": UA,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": `${HL}-${GL.toUpperCase()},${HL};q=0.9`,
        // Consent cookies so Google serves results instead of the EU consent interstitial (best-effort).
        "cookie": "CONSENT=YES+1; SOCS=CAESHAgBEhIaAB",
      },
    });
    clearTimeout(timer);
    html = await res.text();
  } catch (e) {
    bootLog("err", `SERP fetch failed for "${keyword}": ${String(e?.message || e)}`);
    return { ok: false, blocked: false, error: String(e?.message || e) };
  }

  // A 429 or a consent/CAPTCHA interstitial = blocked (honest no-data, never fabricate).
  if (res.status === 429 || res.status === 503 || (res.status >= 300 && res.status < 400) || /\/sorry\//.test(res.url || "")) {
    return { ok: false, blocked: true, error: `HTTP ${res.status}` };
  }
  if (BLOCK_RE.test(html.slice(0, 4000))) return { ok: false, blocked: true, error: "consent/CAPTCHA interstitial" };

  const parsed = parseGoogleHtml(html);
  if (parsed.organic.length === 0) return { ok: false, blocked: true, error: "no organic results parsed (markup drift or soft-block)" };
  return { ok: true, blocked: false, rawResult: { ...parsed, retrievedAt: new Date().toISOString() } };
}

/** Optional generic SERP-API provider (SEO_SERP_PROVIDER=api). A thin seam so a robust/paid source drops in
 *  without touching the app: it must return JSON the app's parseSerpResult understands (organic/results[...]). */
async function readApiSerp(keyword) {
  if (!SERP_API_ENDPOINT) return { ok: false, blocked: false, error: "SEO_SERP_ENDPOINT not set for provider=api" };
  const u = SERP_API_ENDPOINT.replace("{q}", encodeURIComponent(keyword)).replace("{gl}", GL).replace("{hl}", HL);
  try {
    const res = await fetch(u, { headers: SERP_API_KEY ? { authorization: `Bearer ${SERP_API_KEY}` } : {} });
    if (res.status === 429) return { ok: false, blocked: true, error: "API 429" };
    if (!res.ok) return { ok: false, blocked: false, error: `API ${res.status}` };
    const json = await res.json();
    return { ok: true, blocked: false, rawResult: { ...json, retrievedAt: new Date().toISOString() } };
  } catch (e) {
    return { ok: false, blocked: false, error: String(e?.message || e) };
  }
}

async function readSerp(keyword) {
  return PROVIDER === "api" ? readApiSerp(keyword) : readGoogleSerp(keyword);
}

async function main() {
  requireEnv();
  bootLog("boot", `node ${process.version} script=${SCRIPT_DIR} app=${APP_URL} provider=${PROVIDER} batch=${BATCH} zoe=${ZOE_DOMAIN} competitors=${COMPETITOR_DOMAINS.length}`);

  // 1) What should we read next? (the app computes pending = seeds − already discovered)
  let pending = [];
  try {
    const res = await appFetch(`/api/seo/ingest?pending=${BATCH}`);
    if (!res.ok) { log(`pending fetch → ${res.status}`); process.exit(res.status === 401 ? 1 : 0); }
    pending = (await res.json()).pending ?? [];
  } catch (e) { console.error(`[seo-runner] could not reach the app: ${e.message}`); process.exit(1); }
  if (pending.length === 0) { log("nothing pending — all seed keywords read. Exiting."); return; }
  log(`pending: ${pending.length} keyword(s) to read this run (provider=${PROVIDER})`);

  // 2) Read each SERP; STOP on the first blocked response (never hammer a block).
  const keywords = [];
  let blocked = false;
  let sampleDumped = false;
  for (let i = 0; i < pending.length; i++) {
    const seed = pending[i];
    if (i > 0) await sleep(QUERY_DELAY_MS);
    const r = await readSerp(seed.keyword);
    if (r.blocked) { blocked = true; log(`blocked at "${seed.keyword}" (${r.error}) — stopping this run.`); break; }
    if (!r.ok) { bootLog("err", `read error for "${seed.keyword}": ${r.error}`); continue; }
    if (!sampleDumped) { bootLog("sample", `"${seed.keyword}" → ${JSON.stringify(r.rawResult).slice(0, 1500)}`); sampleDumped = true; }
    keywords.push({ keyword: seed.keyword, category: seed.category, location: seed.location, intent: seed.intent, rawResult: r.rawResult });
  }

  // 3) Push to the app (even an empty batch on a block, so the health card records it honestly).
  const body = { keywords, meta: { source: "serp", zoeDomain: ZOE_DOMAIN, toolName: `${PROVIDER === "api" ? "serp-api" : "google-serp"}`, blocked, retrievedAt: new Date().toISOString() } };
  try {
    const res = await appFetch("/api/seo/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    log(`pushed ${keywords.length} SERP(s)${blocked ? " (BLOCKED)" : ""} → ${res.status} ${JSON.stringify(json.result ?? json)}`);
  } catch (e) { console.error(`[seo-runner] push failed: ${e.message}`); process.exit(1); }
}

main().catch((e) => { console.error("[seo-runner] fatal:", e); process.exit(1); });

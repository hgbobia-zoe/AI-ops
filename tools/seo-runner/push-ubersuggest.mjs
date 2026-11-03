#!/usr/bin/env node
// Push Ubersuggest's weekly rank-tracking report to the Zoe app (/api/seo/ingest, meta.source =
// "ubersuggest_project"). The report is read by a scheduled Claude task that is signed in to the Ubersuggest
// connector (the connector's OAuth only trusts official clients, so a plain Node script can't read it). The
// task saves the raw `project_position_info` result to a JSON file and runs this script on it. Parsing and
// scoring happen in the app; this script only splits the report into entries and POSTs them.
//
//   node push-ubersuggest.mjs <report.json>            push the report
//   node push-ubersuggest.mjs <report.json> --dry-run  validate + print the payload, send nothing
//   node push-ubersuggest.mjs --error "<message>"      record an honest failure (e.g. connector signed out)
//
// Config (.env next to this script, or real env vars): APP_URL, SEO_INGEST_TOKEN. Dependency-free.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
try {
  const p = process.env.SEO_RUNNER_ENV || join(SCRIPT_DIR, ".env");
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
} catch { /* no .env: real env vars only */ }

const APP_URL = (process.env.APP_URL || "https://zoe-dispatch.fly.dev").replace(/\/+$/, "");
const TOKEN = process.env.SEO_INGEST_TOKEN || "";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

class PushError extends Error {}
function fail(msg) {
  throw new PushError(msg);
}

/** Accept the bare report, an MCP tool result ({content:[{type:"text",text}]}), or {result: report}. */
function unwrap(x) {
  if (x && Array.isArray(x.content)) {
    for (const c of x.content) {
      if (c && typeof c.text === "string") {
        try { return unwrap(JSON.parse(c.text)); } catch { /* not JSON */ }
      }
    }
  }
  if (x && x.result && typeof x.result === "object" && !Array.isArray(x.keywords)) return unwrap(x.result);
  return x;
}

/** Refuse to push until the deployed app parses this source; an older deploy would misread the entries. */
async function assertAppSupportsSource() {
  const res = await fetch(`${APP_URL}/api/seo/ingest?pending=1`, { headers: TOKEN ? { "x-seo-token": TOKEN } : {} });
  if (!res.ok) fail(`app check HTTP ${res.status}`);
  const j = await res.json().catch(() => ({}));
  if (!Array.isArray(j.sources) || !j.sources.includes("ubersuggest_project")) {
    fail("the deployed app does not parse ubersuggest_project yet (deploy the SEO feed PR first); nothing pushed");
  }
}

async function post(body) {
  if (dryRun) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  await assertAppSupportsSource();
  const res = await fetch(`${APP_URL}/api/seo/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN ? { "x-seo-token": TOKEN } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`ingest HTTP ${res.status}: ${text.slice(0, 500)}`);
  console.log(`[push-ubersuggest] ok: ${text.slice(0, 800)}`);
}

async function main() {
  const retrievedAt = new Date().toISOString();
  const errIdx = args.indexOf("--error");
  if (errIdx >= 0) {
    const message = args[errIdx + 1] || "Ubersuggest report could not be read";
    await post({ keywords: [], meta: { source: "ubersuggest_project", toolName: "project_position_info", error: `Ubersuggest feed: ${message}`, retrievedAt } });
    return;
  }

  const file = args.find((a) => !a.startsWith("--"));
  if (!file) fail("usage: node push-ubersuggest.mjs <report.json> [--dry-run] | --error \"<message>\"");

  let report;
  try {
    report = unwrap(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    fail(`could not read ${file} as JSON: ${e.message}`);
  }
  const entries = Array.isArray(report?.keywords) ? report.keywords : null;
  if (!entries) fail("report has no keywords[] array; expected the raw project_position_info result");

  const bad = entries.filter((e) => !e || typeof e.keyword !== "string" || !e.keyword.trim());
  if (bad.length) fail(`${bad.length} entr(ies) without a keyword; refusing to push a malformed report`);
  if (report.done === false) fail("report is not final (done=false); retry later instead of pushing partial data");

  await post({
    keywords: entries.map((e) => ({ keyword: e.keyword.trim(), rawResult: e })),
    meta: { source: "ubersuggest_project", toolName: "project_position_info", retrievedAt },
  });
}

// Set exitCode instead of process.exit(): exiting while a fetch handle is open crashes Node on Windows.
try {
  await main();
} catch (e) {
  console.error(`[push-ubersuggest] ${e instanceof PushError ? e.message : e?.stack || e}`);
  process.exitCode = 1;
}

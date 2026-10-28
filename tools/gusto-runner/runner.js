// Gusto remote-browser push — office-machine runner.
//
// WHY THIS EXISTS: Gusto has no API and Cloudflare blocks datacenter IPs, so a DRAFT hours push can only run
// from a real, logged-in browser on a residential IP. This replaces the per-user browser EXTENSION with ONE
// office-machine browser the whole team drives from the app — so a payroll person with nothing installed can
// push hours from /payroll and WATCH the remote browser. Mirrors the Website Studio runner (app queues, office
// machine executes) and the extension's DRAFT-only replay (gusto-push.js), just driven from Playwright.
//
// Phase 2 — INTERACTIVE SIGN-IN: when the office Gusto session has lapsed, the runner streams the live login
// screen and REPLAYS the payroll person's clicks/keystrokes (forwarded from the pane) into it, so they sign in
// from the app without touching the office machine. Input is replayed ONLY while on a gusto.com auth screen
// (applyInput's guards) — never into the draft/hours write, which stays fully automated and DRAFT-only.
//
// ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ HARD SAFETY — DRAFT ONLY. NON-NEGOTIABLE (identical to extension/gusto-push.js).                       ║
// ║  • The ONLY mutation ever POSTed is `AutoSaveWorkedHours` (updateDraftPayroll → set hours).            ║
// ║  • It NEVER posts a submit/run/process/approve mutation, and NEVER clicks such a control.              ║
// ║  • If the open run is not a DRAFT, it ABORTS without writing. Read-only except the hours mutation.     ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝
//
// ONE job at a time (single-flight). Loop: claim a job (GET /runner/next) → open app.gusto.com in a PERSISTENT
// profile (stays logged in across runs) → if signed out, report `signin_required` + stream the login screen so
// a human can sign in at the office machine → drive to the DRAFT inputs step → replay AutoSaveWorkedHours per
// worker → stream a live screenshot throughout → report the result (POST /runner/update). A human can cancel
// from the app; the runner polls the job and stops. One job failing never crashes the loop.

// NOTE: playwright is imported DYNAMICALLY inside main(), AFTER loadDotEnv() runs. playwright-core reads
// PLAYWRIGHT_BROWSERS_PATH at module-load time, and ESM hoists static imports above all other code — so a
// static `import ... from "playwright"` would read the env var before .env is applied and cache the wrong
// (default per-user AppData) browser location. Deferring the import lets a PLAYWRIGHT_BROWSERS_PATH set in
// .env win, which is how we keep the browsers co-located with the runner (portable, survives profile quirks).
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve .env and the profile dir against THIS script's directory, not the current working directory. A Windows
// Scheduled Task does not reliably honor its "Start in" dir, so the runner must never depend on cwd.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ── Bootstrap crash log ──────────────────────────────────────────────────────
// A Scheduled Task discards the process's stdout/stderr, so when a task-launched run exits (e.g. exit 1) there
// is otherwise no trace of WHY — even when the same command runs fine interactively. Tee console + the fatal
// handlers to boot.log in the script dir so a task run always leaves a diagnosable record.
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
  bootLog("boot", `node ${process.version} cwd=${process.cwd()} script=${SCRIPT_DIR}`);
}

// ── Load a local .env first (KEY=VALUE per line) so the token + config can live in a file instead of the shell
// — no dependency, a tiny parser. A var already set in the real environment always wins, so `GUSTO_RUNNER_TOKEN=…
// npm start` still overrides the file. Point elsewhere with GUSTO_RUNNER_ENV.
(function loadDotEnv() {
  try {
    const p = process.env.GUSTO_RUNNER_ENV || join(SCRIPT_DIR, ".env");
    if (!existsSync(p)) return;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trimStart().startsWith("#")) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch { /* a malformed .env is non-fatal — explicit env vars still work */ }
})();

// ── Config from the environment ──────────────────────────────────────────────
const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");
const RUNNER_TOKEN = process.env.GUSTO_RUNNER_TOKEN || "";
// Persistent Chrome profile dir — this is what keeps Gusto logged in between runs. Default under the user dir.
const PROFILE_DIR = process.env.GUSTO_PROFILE_DIR || join(SCRIPT_DIR, ".gusto-profile");
const GUSTO_HOME = "https://app.gusto.com/";
// Headful by default so a human can sign in at the office machine when the session lapses. Set GUSTO_HEADLESS=1
// only once the profile is reliably logged in and no interactive login is expected.
const HEADLESS = /^(1|true|yes|on)$/i.test(process.env.GUSTO_HEADLESS || "");
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 10000);
const FRAME_MS = Number(process.env.FRAME_INTERVAL_MS || 1500); // live screenshot cadence
const SIGNIN_TIMEOUT_MS = Number(process.env.SIGNIN_TIMEOUT_MS || 10 * 60 * 1000); // wait up to 10 min for a human login
const SIGNIN_POLL_MS = Number(process.env.SIGNIN_POLL_MS || 600); // during interactive sign-in: poll input + stream a fresh frame this often
const INPUTS_TIMEOUT_MS = Number(process.env.INPUTS_TIMEOUT_MS || 60 * 1000); // reach the draft inputs step

function requireEnv() {
  const missing = [];
  if (!APP_URL) missing.push("APP_URL");
  if (!RUNNER_TOKEN) missing.push("GUSTO_RUNNER_TOKEN");
  if (missing.length) {
    console.error(`[gusto-runner] Missing required env: ${missing.join(", ")}. See README.`);
    process.exit(1);
  }
}

const log = (...a) => console.log(`[gusto-runner] ${new Date().toISOString()}`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function appFetch(path, init = {}) {
  return fetch(`${APP_URL}${path}`, {
    ...init,
    headers: { "x-gusto-runner-token": RUNNER_TOKEN, ...(init.headers || {}) },
  });
}

async function postUpdate(body) {
  try {
    const res = await appFetch("/api/payroll/gusto/runner/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { log(`update(${body.status || "progress"}) → ${res.status}`); return null; }
    return await res.json().catch(() => null);
  } catch (e) {
    log(`update failed: ${e.message}`);
    return null;
  }
}

// Drain the pending INTERACTIVE SIGN-IN input the pane forwarded for this job (claim-once on the server).
async function fetchInput(id) {
  try {
    const res = await appFetch(`/api/payroll/gusto/runner/input?id=${encodeURIComponent(id)}`);
    if (!res.ok) return [];
    const { events } = await res.json();
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

// Allowlisted special keys — matches the server-side allowlist. Printable chars arrive as {kind:'type'}.
const ALLOWED_KEYS = new Set([
  "Enter", "Tab", "Backspace", "Delete", "Escape",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End",
]);

// Replay forwarded sign-in input into the live Gusto login page. DEFENSE IN DEPTH (independent of the app's
// own gates): only act while the page is actually a gusto.com AUTH screen, so a forwarded keystroke (incl. a
// password) can never reach the draft write or any non-Gusto origin.
async function applyInput(page, events) {
  if (!events.length) return;
  if (!(await onAuthPage(page))) return;
  let host = "";
  try { host = new URL(page.url()).host; } catch {}
  if (!/(^|\.)gusto\.com$/i.test(host)) return; // never forward input to an unexpected origin
  for (const ev of events) {
    try {
      if (ev.kind === "click") await page.mouse.click(Number(ev.x) || 0, Number(ev.y) || 0);
      else if (ev.kind === "type" && typeof ev.text === "string") await page.keyboard.type(ev.text, { delay: 8 });
      else if (ev.kind === "key" && typeof ev.key === "string" && ALLOWED_KEYS.has(ev.key)) await page.keyboard.press(ev.key);
      else if (ev.kind === "scroll") await page.mouse.wheel(0, Number(ev.deltaY) || 0);
    } catch { /* one bad event never stops the rest */ }
  }
}

// Poll the current job state so we can stop when a human cancels it from the app.
async function jobIsCanceled(id) {
  try {
    const res = await appFetch(`/api/payroll/gusto/runner/job?id=${encodeURIComponent(id)}`);
    if (!res.ok) return false;
    const { job } = await res.json();
    return !!job && job.status === "canceled";
  } catch {
    return false;
  }
}

// ── The in-page CAPTURE hook (init script) — identical intent to extension/gusto.js + gusto-push.js. It wraps
// window.fetch on app.gusto.com and records: a header template (x-gusto-*/csrf) from any graphql request, the
// DRAFT inputs response (member map + draft id), and — if the app itself fired a save — a real save template
// (query + a valid session id). It NEVER issues a write; the runner does the write via a separate evaluate.
const CAPTURE_INIT = `
(() => {
  if (window.__zoeGustoCap) return;
  const cap = window.__zoeGustoCap = { headerTemplate: null, memberMap: null, draftPayrollId: null, isDraft: false, saveTemplate: null };
  const GQL = "graphql.app.gusto.com";
  const INPUTS_OP = "PayrollInputStepDraftEmployeePayrollsByIds";
  const SAVE_OP = "AutoSaveWorkedHours";
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  function currentHours(all, jobUuid) {
    try {
      const list = Array.isArray(all) ? all : [];
      const wh = list.find((h) => h && (h.employeeJobUuid === jobUuid || (h.employeeJob && h.employeeJob.uuid === jobUuid)));
      if (!wh) return null;
      return { regularHours: num(wh.regularHours), overtimeHours: num(wh.overtimeHours), doubleOvertimeHours: num(wh.doubleOvertimeHours) };
    } catch (e) { return null; }
  }
  function ingestInputs(json) {
    try {
      const draft = json && json.data && json.data.company && json.data.company.draftPayroll;
      if (!draft) return;
      cap.isDraft = true;
      cap.draftPayrollId = draft.id || cap.draftPayrollId;
      const list = Array.isArray(draft.draftEmployeePayrollsByIds) ? draft.draftEmployeePayrollsByIds : [];
      const map = {};
      for (const dp of list) {
        const emp = (dp && dp.employee) || {};
        const companyMemberUuid = emp.companyMemberUuid || (emp.companyMember && emp.companyMember.id);
        const employeeUuid = emp.uuid;
        const job = dp && dp.primaryJobApplicableCompensation && dp.primaryJobApplicableCompensation.employeeJob;
        const employeeJobUuid = job && job.uuid;
        if (!companyMemberUuid || !employeeUuid || !employeeJobUuid) continue;
        map[companyMemberUuid] = { employeeUuid, employeeJobUuid, current: currentHours(dp.allWorkedHours, employeeJobUuid) };
      }
      cap.memberMap = map;
    } catch (e) { /* shape change → memberMap stays null → abort cleanly */ }
  }
  const origFetch = window.fetch;
  if (!origFetch) return;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && url.indexOf(GQL) >= 0) {
        let parsed = null;
        try { parsed = init && init.body ? JSON.parse(init.body) : null; } catch (e) {}
        const op = parsed && parsed.operationName;
        if (!cap.headerTemplate && init && init.headers) {
          const h = {};
          try { new Headers(init.headers).forEach((v, k) => { h[k] = v; }); } catch (e) {}
          if (h["x-csrf-token"] || h["x-gusto-view-name"]) cap.headerTemplate = { url, headers: h };
        }
        if (op === INPUTS_OP) { const j = await res.clone().json().catch(() => null); if (j) ingestInputs(j); }
        else if (op === SAVE_OP && parsed) {
          try {
            const sid = parsed.variables && parsed.variables.input && parsed.variables.input.payrollActivitySessionId;
            cap.saveTemplate = { query: parsed.query || null, payrollActivitySessionId: sid || null };
          } catch (e) {}
        }
      }
    } catch (e) {}
    return res;
  };
})();
`;

// ── Drive the page toward the DRAFT inputs step (the SAME safe clicks as gusto-push.js). Returns true once the
// member map is captured. NEVER clicks a submit/run/approve control. Runs in the page.
const DRIVE_FN = `() => {
  const SAFE = [/continue to payroll/i, /default weekly payroll/i, /review (hours|time)/i, /enter hours/i, /payroll inputs/i];
  const UNSAFE = /(submit|run payroll|approve|process|pay employees|cancel)/i;
  try {
    if (window.__zoeGustoCap && window.__zoeGustoCap.memberMap) return "inputs";
    const nodes = Array.from(document.querySelectorAll("a,button,[role=button],[ng-click]"));
    for (const re of SAFE) {
      const el = nodes.find((n) => { const t = (n.textContent || "").trim(); return t && re.test(t) && !UNSAFE.test(t) && n.offsetParent !== null; });
      if (el) { el.click(); return "clicked"; }
    }
  } catch (e) {}
  return "waiting";
}`;

// ── The in-page REPLAY — DRAFT ONLY. Reads the captured member map + headers, writes each matched worker's
// hours via AutoSaveWorkedHours, skips unmatched + idempotent-no-change. Identical write shape + the
// FORBIDDEN_OP guard from extension/gusto-push.js. Returns the per-worker result. Runs in the page.
const REPLAY_FN = `async (entries) => {
  const cap = window.__zoeGustoCap || {};
  const SAVE_OP = "AutoSaveWorkedHours";
  const FORBIDDEN = /(submit|run|process|approve|finaliz|cancel|delete|skip)/i;
  const FALLBACK_DOC = "mutation AutoSaveWorkedHours($employeeUuid: ID!, $input: UpdateDraftPayrollInput!) { updateDraftPayroll(input: $input) { draftPayroll { id } } }";
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const out = { workers: [], sessionMode: null, draftPayrollId: cap.draftPayrollId || null, aborted: null };
  if (!cap.memberMap) { out.aborted = "could_not_reach_inputs"; return out; }
  if (!cap.isDraft) { out.aborted = "not_a_draft"; return out; }
  if (!cap.headerTemplate) { out.aborted = "no_graphql_headers"; return out; }
  if (FORBIDDEN.test(SAVE_OP)) { out.aborted = "refused_safety_check"; return out; }
  const uuid = () => (crypto && crypto.randomUUID) ? crypto.randomUUID() : ("xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random()*16|0; const v = c==="x"?r:(r&0x3|0x8); return v.toString(16); }));
  const uniqueId = () => { let s = (uuid()+uuid()+uuid()).replace(/-/g,"") + Date.now().toString(36); while (s.length<92) s += Math.random().toString(36).slice(2); return s.slice(0,92); };
  const sessionMode = cap.saveTemplate && cap.saveTemplate.payrollActivitySessionId ? "captured" : "generated";
  const shared = sessionMode === "captured" ? cap.saveTemplate.payrollActivitySessionId : uuid();
  out.sessionMode = sessionMode;
  const query = (cap.saveTemplate && cap.saveTemplate.query) ? cap.saveTemplate.query : FALLBACK_DOC;
  const match = (t, c) => { if (!c) return false; const e = 0.001; return Math.abs(num(t.regularHours)-c.regularHours)<e && Math.abs(num(t.overtimeHours)-c.overtimeHours)<e && Math.abs(num(t.doubleOvertimeHours)-c.doubleOvertimeHours)<e; };
  for (const entry of entries) {
    const ids = cap.memberMap[entry.gustoMemberId];
    const row = { gustoMemberId: entry.gustoMemberId, name: entry.name || null, regularHours: num(entry.regularHours), overtimeHours: num(entry.overtimeHours) };
    if (!ids) { out.workers.push({ ...row, outcome: "skipped", reason: "not in draft (no matching employee)" }); continue; }
    if (match(entry, ids.current)) { out.workers.push({ ...row, outcome: "skipped", reason: "already set (idempotent)" }); continue; }
    try {
      const variables = { employeeUuid: ids.employeeUuid, input: { payrollActivitySessionId: shared, uniqueIdentifier: uniqueId(), workedHours: [ { employeeUuid: ids.employeeUuid, workedHours: [ { employeeJobUuid: ids.employeeJobUuid, regularHours: num(entry.regularHours), overtimeHours: num(entry.overtimeHours), doubleOvertimeHours: num(entry.doubleOvertimeHours), missedBreakHours: "0.0" } ] } ] } };
      const res = await window.fetch(cap.headerTemplate.url, { method: "POST", headers: cap.headerTemplate.headers, body: JSON.stringify({ operationName: SAVE_OP, query, variables }), credentials: "include" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error("http_" + res.status);
      if (json && json.errors && json.errors.length) throw new Error((json.errors[0] && json.errors[0].message) || "graphql_error");
      out.workers.push({ ...row, outcome: "pushed" });
    } catch (e) { out.workers.push({ ...row, outcome: "failed", reason: (e && e.message) || "error" }); }
  }
  return out;
}`;

// Is the page on a Gusto sign-in / MFA screen (expired session)?
async function onAuthPage(page) {
  try {
    const url = page.url();
    if (/\/(login|sign[_-]?in|signin|session|sso|saml|oauth|mfa|two[_-]?factor)\b/i.test(url)) return true;
    return (await page.$('input[type="password"]')) !== null;
  } catch {
    return false;
  }
}

// Stream the current frame to the app so the pane shows the remote browser. Best-effort.
async function streamFrame(page, jobId, phase) {
  try {
    const buf = await page.screenshot({ type: "png" });
    const form = new FormData();
    form.set("jobId", jobId);
    if (phase) form.set("phase", phase);
    form.set("file", new Blob([buf], { type: "image/png" }), "live.png");
    await appFetch("/api/payroll/gusto/runner/artifact", { method: "POST", body: form });
  } catch { /* best-effort */ }
}

// ── Process one claimed job end to end ───────────────────────────────────────
async function processJob(context, job) {
  const page = await context.newPage();
  // Keep streaming the live frame on a timer for the whole job so the pane is live regardless of step.
  let lastPhase = "Starting";
  const frameTimer = setInterval(() => { void streamFrame(page, job.id, lastPhase); }, FRAME_MS);
  const setPhase = async (phase, status) => { lastPhase = phase; await postUpdate({ id: job.id, status, phase }); await streamFrame(page, job.id, phase); };

  try {
    await page.goto(GUSTO_HOME, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});

    // 1) Sign-in gate — if the session lapsed, surface the login screen and let a human sign in. Phase 2: the
    // person signs in FROM THE PANE — we stream the live frame fast and replay their forwarded clicks/keys.
    if (await onAuthPage(page)) {
      await setPhase("Sign in to Gusto", "signin_required");
      const deadline = Date.now() + SIGNIN_TIMEOUT_MS;
      let clearChecks = 0; // require 2 consecutive "off the auth page" reads before proceeding (rides out redirects)
      for (;;) {
        if (Date.now() > deadline) { await postUpdate({ id: job.id, status: "done", aborted: "not_logged_in" }); return; }
        if (await jobIsCanceled(job.id)) { log(`job ${job.id} canceled during sign-in`); return; }
        const onAuth = await onAuthPage(page);
        if (onAuth) {
          clearChecks = 0;
          await applyInput(page, await fetchInput(job.id)); // replay the pane's sign-in input
        } else if (++clearChecks >= 2) {
          break; // signed in and settled
        }
        await streamFrame(page, job.id, onAuth ? "Sign in to Gusto" : "Finishing sign-in");
        await sleep(SIGNIN_POLL_MS);
      }
      await page.goto(GUSTO_HOME, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    }

    // 2) Reach the DRAFT inputs step (safe clicks only) until the member map is captured.
    await setPhase("Opening the draft payroll run", "pushing");
    const inputsDeadline = Date.now() + INPUTS_TIMEOUT_MS;
    let reached = false;
    while (Date.now() < inputsDeadline) {
      if (await jobIsCanceled(job.id)) { log(`job ${job.id} canceled before inputs`); return; }
      const cap = await page.evaluate("window.__zoeGustoCap && window.__zoeGustoCap.memberMap ? true : false").catch(() => false);
      if (cap) { reached = true; break; }
      if (await onAuthPage(page)) { await postUpdate({ id: job.id, status: "done", aborted: "not_logged_in" }); return; }
      await page.evaluate(DRIVE_FN).catch(() => {});
      await sleep(1500);
    }
    if (!reached) { await postUpdate({ id: job.id, status: "done", aborted: "could_not_reach_inputs" }); return; }

    if (await jobIsCanceled(job.id)) { log(`job ${job.id} canceled before write`); return; }

    // 3) DRAFT-ONLY write — replay AutoSaveWorkedHours per worker in the page.
    await setPhase("Writing hours into the draft", "pushing");
    const result = await page.evaluate(REPLAY_FN, job.entries);
    await streamFrame(page, job.id, "Done");

    // 4) Report the final outcome.
    await postUpdate({
      id: job.id,
      status: "done",
      draftPayrollId: result.draftPayrollId,
      sessionMode: result.sessionMode,
      aborted: result.aborted,
      workers: result.workers,
    });
    const pushed = result.workers.filter((w) => w.outcome === "pushed").length;
    log(`job ${job.id} done — ${pushed} pushed${result.aborted ? ` (aborted: ${result.aborted})` : ""}`);
  } finally {
    clearInterval(frameTimer);
    await page.close().catch(() => {});
  }
}

// ── Main loop (single-flight) ────────────────────────────────────────────────
async function main() {
  requireEnv();
  // Import playwright only now — .env (incl. any PLAYWRIGHT_BROWSERS_PATH) has been applied above, so
  // playwright-core resolves the browsers against the configured path rather than the default AppData one.
  const { chromium } = await import("playwright");
  if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });
  log(`starting. app=${APP_URL} profile=${PROFILE_DIR} headless=${HEADLESS} poll=${POLL_MS}ms`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(CAPTURE_INIT);

  for (;;) {
    let job = null;
    try {
      const res = await appFetch("/api/payroll/gusto/runner/next");
      if (res.status === 503) log("runner endpoints disabled on the app (GUSTO_RUNNER_TOKEN unset there?) — retrying");
      else if (res.status === 401) log("unauthorized — GUSTO_RUNNER_TOKEN mismatch between runner and app");
      else if (res.ok) ({ job } = await res.json());
      else log(`next → ${res.status}`);
    } catch (e) {
      log(`could not reach the app: ${e.message}`);
    }

    if (job) {
      log(`claimed job ${job.id} — ${job.entries.length} worker(s), period ${job.periodLabel || "?"}`);
      try {
        await processJob(context, job);
      } catch (e) {
        await postUpdate({ id: job.id, status: "failed", error: e && e.message ? e.message : String(e) });
        log(`job ${job.id} FAILED: ${e && e.message ? e.message : e}`);
      }
    } else {
      await sleep(POLL_MS);
    }
  }
}

main().catch((e) => {
  console.error("[gusto-runner] fatal:", e);
  process.exit(1);
});

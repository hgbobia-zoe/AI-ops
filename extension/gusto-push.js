// Zoe Auto-Pull — Gusto HOURS PUSH content script (manifest content_scripts, world: MAIN so it can see +
// replay the app's own fetches). This is the WRITE side of the Gusto integration: it writes the reconciled
// per-worker hours into the CURRENT DRAFT payroll run by replaying Gusto's internal `AutoSaveWorkedHours`
// GraphQL mutation from the logged-in tab (Gusto's official API is pending; Cloudflare blocks server calls —
// same browser-replay pattern as the read sync in gusto.js).
//
// ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ HARD SAFETY — DRAFT ONLY. NON-NEGOTIABLE.                                                              ║
// ║  • The ONLY mutation this ever POSTs is `AutoSaveWorkedHours` (updateDraftPayroll → set hours).        ║
// ║  • It NEVER calls a submit/run/process/approve mutation, and NEVER navigates to review-summary/submit. ║
// ║  • If the open run is not a DRAFT, it ABORTS without writing.                                          ║
// ║  Read-only everywhere except the hours mutation.                                                       ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝
//
// Lifecycle: the background opens ONE hidden app.gusto.com tab and arms a push job. gusto-bridge.js (isolated
// world) CLAIMS the job for this exact tab and postMessages the entries into this MAIN world. This script
// drives the hidden tab to the DRAFT run's inputs step, captures the per-worker ids + the app's own graphql
// headers/template, writes each worker's hours, POSTs a result summary to Zoe, then tells the bridge "done"
// so the background closes the tab (watchdog reaps it if anything stalls).

(function () {
  if (window.__zoeGustoPush) return;
  window.__zoeGustoPush = true;

  const API = "https://zoe-dispatch.fly.dev";
  const GQL_HOST = "graphql.app.gusto.com";
  const INPUTS_OP = "PayrollInputStepDraftEmployeePayrollsByIds";
  const SAVE_OP = "AutoSaveWorkedHours";
  const MARK_OP = "MarkCompanyTouchedHours";
  // A signed-out Gusto session lands this hidden tab on an auth page instead of the run. Detect it so we can
  // REVEAL the tab for the operator to sign in and abort with a clear `not_logged_in` (not the vague
  // could_not_reach_inputs). Path match for the login/MFA routes + a password field as a belt-and-braces
  // heuristic (a real DRAFT run page never has one, so this won't false-abort a legit push).
  const AUTH_RE = /\/(login|sign[_-]?in|signin|session|sso|saml|oauth|mfa|two[_-]?factor)\b/i;
  // Any operation that could advance/submit payroll — we must NEVER POST one of these. Belt-and-braces guard.
  const FORBIDDEN_OP = /(submit|run|process|approve|finaliz|cancel|delete|skip)/i;
  // Fallback mutation doc (the app's own captured query is preferred — see captureTemplate).
  const SAVE_DOC =
    "mutation AutoSaveWorkedHours($employeeUuid: ID!, $input: UpdateDraftPayrollInput!) { updateDraftPayroll(input: $input) { draftPayroll { id } } }";

  const origFetch = window.fetch;
  if (!origFetch) return;

  // ── captured state (from hooking the app's own graphql traffic) ──────────────────────────────────────
  let headerTemplate = null; // { url, headers } from any live graphql request on the run page (the x-gusto-* set)
  let saveTemplate = null; // { query, payrollActivitySessionId } captured from the app's OWN AutoSaveWorkedHours
  let memberMap = null; // { companyMemberUuid: { employeeUuid, employeeJobUuid, current } }
  let draftPayrollId = null;
  let isDraft = false;

  // ── fetch hook: capture headers + the inputs query + (if the app fires it) a real save template ──────
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && url.indexOf(GQL_HOST) >= 0) {
        let parsed = null;
        try { parsed = init && init.body ? JSON.parse(init.body) : null; } catch (e) { /* non-JSON */ }
        const op = parsed && parsed.operationName;
        // Grab the header set from ANY graphql request (they all carry the required x-gusto-*/csrf/apollo headers).
        if (!headerTemplate && init && init.headers) {
          const h = {};
          try { new Headers(init.headers).forEach((v, k) => { h[k] = v; }); } catch (e) { /* ignore */ }
          if (h["x-csrf-token"] || h["x-gusto-view-name"]) headerTemplate = { url, headers: h };
        }
        if (op === INPUTS_OP) {
          const json = await res.clone().json().catch(() => null);
          if (json) ingestInputs(json);
        } else if (op === SAVE_OP && parsed) {
          // The app saved hours itself — capture its query doc + a VALID session id for the captured fallback.
          try {
            const sid = parsed.variables && parsed.variables.input && parsed.variables.input.payrollActivitySessionId;
            saveTemplate = { query: parsed.query || SAVE_DOC, payrollActivitySessionId: sid || null };
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* never break the app's fetch */ }
    return res;
  };

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  // Are we sitting on a Gusto sign-in / MFA page (expired session) rather than the app?
  function onAuthPage() {
    try {
      if (AUTH_RE.test(location.pathname)) return true;
      if (document.querySelector('input[type="password"]')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  // Ask the background (via the isolated-world bridge) to bring THIS hidden push tab to the front + focus its
  // window, so the operator can sign in. The bridge also DETACHES the tab from the push watchdog, so the
  // login tab is left open (never reaped) — the operator signs in, then clicks "Push" again on a fresh session.
  function revealTab() {
    try { window.postMessage({ __zoeGustoPush: true, type: "reveal" }, location.origin); } catch (e) { /* no-op */ }
  }

  // Parse PayrollInputStepDraftEmployeePayrollsByIds → member→{employeeUuid, employeeJobUuid, current hours}.
  // The presence of data.company.draftPayroll (NOT processedPayroll) is our DRAFT signal.
  function ingestInputs(json) {
    try {
      const draft = json && json.data && json.data.company && json.data.company.draftPayroll;
      if (!draft) return; // not a draft payroll response — leave isDraft false (we will abort)
      isDraft = true;
      draftPayrollId = draft.id || draftPayrollId;
      const list = Array.isArray(draft.draftEmployeePayrollsByIds) ? draft.draftEmployeePayrollsByIds : [];
      const map = {};
      for (const dp of list) {
        const emp = (dp && dp.employee) || {};
        const companyMemberUuid = emp.companyMemberUuid || (emp.companyMember && emp.companyMember.id);
        const employeeUuid = emp.uuid;
        const job = dp && dp.primaryJobApplicableCompensation && dp.primaryJobApplicableCompensation.employeeJob;
        const employeeJobUuid = job && job.uuid;
        if (!companyMemberUuid || !employeeUuid || !employeeJobUuid) continue;
        map[companyMemberUuid] = {
          employeeUuid,
          employeeJobUuid,
          current: currentHours(dp.allWorkedHours, employeeJobUuid),
        };
      }
      memberMap = map;
    } catch (e) { /* defensive — a shape change just leaves memberMap null → abort cleanly */ }
  }

  // The worker's CURRENT draft hours for the primary job (for the idempotency skip). null when absent.
  function currentHours(allWorkedHours, jobUuid) {
    try {
      const list = Array.isArray(allWorkedHours) ? allWorkedHours : [];
      const wh = list.find((h) => h && (h.employeeJobUuid === jobUuid || (h.employeeJob && h.employeeJob.uuid === jobUuid)));
      if (!wh) return null;
      return { regularHours: num(wh.regularHours), overtimeHours: num(wh.overtimeHours), doubleOvertimeHours: num(wh.doubleOvertimeHours) };
    } catch (e) { return null; }
  }

  // ── client-generated correlation ids (HYPOTHESIS — see the module header + the PR notes) ─────────────
  // payrollActivitySessionId + uniqueIdentifier are NOT in the load queries; they appear to be client ids.
  // We GENERATE them. If Gusto rejects a generated session, the fallback is to reuse the session id captured
  // from the app's OWN AutoSaveWorkedHours (saveTemplate.payrollActivitySessionId). `sessionMode` records
  // which path we used, so the integrator can confirm the hypothesis from the result.
  function uuid() {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* fall through */ }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0; const v = c === "x" ? r : (r & 0x3) | 0x8; return v.toString(16);
    });
  }
  function uniqueIdentifier() {
    // ~92 chars, unique per request.
    let s = (uuid() + uuid() + uuid()).replace(/-/g, "") + Date.now().toString(36);
    while (s.length < 92) s += Math.random().toString(36).slice(2);
    return s.slice(0, 92);
  }

  // ── drive the hidden tab to the DRAFT run's inputs step (best-effort, DOM-driven) ────────────────────
  // UNVERIFIED navigation: Gusto's exact run-page URLs/slug aren't known to this build, so we DRIVE the app
  // by clicking its own controls (resilient to URL scheme) and WAIT for the inputs query (INPUTS_OP) to be
  // captured by the fetch hook above. If the operator already has the draft's inputs page open in this tab,
  // capture happens immediately with no clicks. We NEVER click a submit/approve/run control.
  const SAFE_CLICK_TEXT = [/continue to payroll/i, /default weekly payroll/i, /review (hours|time)/i, /enter hours/i, /payroll inputs/i];
  const UNSAFE_CLICK_TEXT = /(submit|run payroll|approve|process|pay employees|cancel)/i;

  function clickCandidates() {
    try {
      const nodes = Array.from(document.querySelectorAll("a,button,[role=button],[ng-click]"));
      for (const re of SAFE_CLICK_TEXT) {
        const el = nodes.find((n) => {
          const t = (n.textContent || "").trim();
          return t && re.test(t) && !UNSAFE_CLICK_TEXT.test(t) && n.offsetParent !== null;
        });
        if (el) { el.click(); return true; }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // Resolves with WHY we stopped waiting: "inputs" (captured the draft), "auth" (signed out → reveal + abort),
  // or "timeout". Give the auth check a beat to settle (the hidden tab may still be redirecting to login on
  // the first ticks), so we only trust it after a short grace period.
  function waitForInputs(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (memberMap) return resolve("inputs");
        if (Date.now() - start > 4000 && onAuthPage()) return resolve("auth");
        if (Date.now() - start > timeoutMs) return resolve("timeout");
        clickCandidates(); // nudge the flow forward one safe step, then re-poll
        setTimeout(tick, 1500);
      };
      tick();
    });
  }

  // ── the write: AutoSaveWorkedHours per matched worker ────────────────────────────────────────────────
  function buildVariables(ids, entry, session) {
    return {
      employeeUuid: ids.employeeUuid,
      input: {
        payrollActivitySessionId: session.payrollActivitySessionId,
        uniqueIdentifier: session.uniqueIdentifier,
        workedHours: [
          {
            employeeUuid: ids.employeeUuid,
            workedHours: [
              {
                employeeJobUuid: ids.employeeJobUuid,
                regularHours: num(entry.regularHours),
                overtimeHours: num(entry.overtimeHours),
                doubleOvertimeHours: num(entry.doubleOvertimeHours),
                missedBreakHours: "0.0",
              },
            ],
          },
        ],
      },
    };
  }

  function hoursMatch(target, current) {
    if (!current) return false;
    const e = 0.001;
    return Math.abs(num(target.regularHours) - current.regularHours) < e
      && Math.abs(num(target.overtimeHours) - current.overtimeHours) < e
      && Math.abs(num(target.doubleOvertimeHours) - current.doubleOvertimeHours) < e;
  }

  async function postSave(ids, entry, sharedSessionId) {
    const query = saveTemplate && saveTemplate.query ? saveTemplate.query : SAVE_DOC;
    const session = {
      payrollActivitySessionId: sharedSessionId, // shared across the batch (captured real id, or one generated uuid)
      uniqueIdentifier: uniqueIdentifier(), // fresh per request
    };
    const variables = buildVariables(ids, entry, session);
    // FINAL SAFETY CHECK before the only write we ever make.
    if (FORBIDDEN_OP.test(SAVE_OP)) throw new Error("refused: op name failed safety check");
    const res = await origFetch(headerTemplate.url, {
      method: "POST",
      headers: headerTemplate.headers,
      body: JSON.stringify({ operationName: SAVE_OP, query, variables }),
      credentials: "include",
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error("http_" + res.status);
    if (json && json.errors && json.errors.length) throw new Error((json.errors[0] && json.errors[0].message) || "graphql_error");
    return json;
  }

  async function runPush(job) {
    const entries = (job && Array.isArray(job.entries)) ? job.entries : [];
    const period = (job && job.period) || {};
    const result = {
      ok: false,
      aborted: null,
      draftPayrollId: null,
      periodStart: period.start || null,
      periodEnd: period.end || null,
      sessionMode: null,
      workers: [],
    };
    if (!entries.length) { result.aborted = "no_entries"; return result; }

    // 1) Reach the inputs step + capture the member map (and thereby confirm DRAFT). Never submits.
    const reached = await waitForInputs(45000);
    if (reached === "auth") {
      // Expired Gusto session — reveal this tab so the operator can sign in, then re-run the push.
      revealTab();
      result.aborted = "not_logged_in";
      return result;
    }
    if (reached !== "inputs" || !memberMap) { result.aborted = "could_not_reach_inputs"; return result; }
    if (!isDraft) { result.aborted = "not_a_draft"; return result; } // HARD SAFETY: only ever a DRAFT run
    if (!headerTemplate) { result.aborted = "no_graphql_headers"; return result; }
    result.draftPayrollId = draftPayrollId;

    // 2) Session-id strategy (HYPOTHESIS): prefer a captured real session if the app fired a save; else generate.
    const sessionMode = saveTemplate && saveTemplate.payrollActivitySessionId ? "captured" : "generated";
    const sharedSessionId = sessionMode === "captured" ? saveTemplate.payrollActivitySessionId : uuid();
    result.sessionMode = sessionMode;

    // 3) Write each matched worker's hours. Skip unmatched + idempotent-no-change. One failure never aborts
    //    the batch (DRAFT writes are independent per worker).
    for (const entry of entries) {
      const ids = memberMap[entry.gustoMemberId];
      const row = { gustoMemberId: entry.gustoMemberId, name: entry.name || null, regularHours: num(entry.regularHours), overtimeHours: num(entry.overtimeHours) };
      if (!ids) { result.workers.push({ ...row, outcome: "skipped", reason: "not in draft (no matching employee)" }); continue; }
      if (hoursMatch(entry, ids.current)) { result.workers.push({ ...row, outcome: "skipped", reason: "already set (idempotent)" }); continue; }
      try {
        await postSave(ids, entry, sharedSessionId);
        result.workers.push({ ...row, outcome: "pushed" });
      } catch (e) {
        result.workers.push({ ...row, outcome: "failed", reason: (e && e.message) || "error" });
      }
    }
    result.ok = result.workers.every((w) => w.outcome !== "failed");
    return result;
  }

  // ── POST the outcome to Zoe + signal done ────────────────────────────────────────────────────────────
  async function sendResult(job, result) {
    try {
      await origFetch(API + "/api/payroll/gusto/push-result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: result.ok,
          aborted: result.aborted,
          draftPayrollId: result.draftPayrollId,
          periodStart: result.periodStart,
          periodEnd: result.periodEnd,
          sessionMode: result.sessionMode,
          initiatedBy: (job && job.initiatedBy) || null,
          workers: result.workers,
        }),
      });
    } catch (e) { /* best-effort — the tab still closes via the done relay/watchdog */ }
  }

  function signalDone(ok) {
    try { window.postMessage({ __zoeGustoPush: true, type: "done", ok: !!ok }, location.origin); } catch (e) { /* no-op */ }
  }

  // ── job intake: the isolated-world bridge claims the job for THIS tab and posts the entries here ──────
  let started = false;
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__zoeGustoPush !== true || d.type !== "job" || !d.job) return;
    if (started) return;
    started = true;
    // Mark the push active so gusto.js (read sync, same MAIN world) does NOT seed-navigate this tab away.
    window.__zoeGustoPushActive = true;
    (async () => {
      let result;
      try { result = await runPush(d.job); }
      catch (err) { result = { ok: false, aborted: "exception:" + ((err && err.message) || "error"), workers: [], sessionMode: null, draftPayrollId: null, periodStart: null, periodEnd: null }; }
      await sendResult(d.job, result);
      // On a signed-out abort we've already asked the background to REVEAL + detach this tab for sign-in — do
      // NOT signal done, which would close it. Every other outcome closes the dedicated hidden tab as usual.
      if (result.aborted !== "not_logged_in") signalDone(result.ok && !result.aborted);
    })();
  });

  // Ask the bridge whether there's a push job for this tab (mirrors the read path's handshake direction).
  try { window.postMessage({ __zoeGustoPush: true, type: "ready" }, location.origin); } catch (e) { /* no-op */ }
})();

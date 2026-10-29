// Zoe Auto-Pull — Gusto payroll SUBMIT + wire-CONFIRM content script (manifest content_scripts, world: MAIN
// so it can see + replay the app's own fetches, using the page's session CSRF/cookies). This is the
// IRREVERSIBLE side of the Gusto integration: it RUNS REAL PAYROLL (SubmitDraftPayroll) and records the
// funding wire (ConfirmWireIn) by replaying Gusto's internal GraphQL from the logged-in tab (Gusto has no
// public API; Cloudflare blocks server calls — same browser-replay pattern as gusto.js + gusto-push.js).
//
// ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ HIGH STAKES — this is NOT the DRAFT-only hours push. SubmitDraftPayroll COMMITS the run and creates a  ║
// ║ wire obligation; it is IRREVERSIBLE. NON-NEGOTIABLE rules:                                             ║
// ║  • The ONLY mutations this ever POSTs are SubmitDraftPayroll and ConfirmWireIn (+ the WireInInstructions║
// ║    read). No other mutation, ever.                                                                     ║
// ║  • WIRE ONLY — SubmitDraftPayroll input ALWAYS has requestedPayoutRail:null and                        ║
// ║    subscribeAndRunWithNextDayAch:false. It REFUSES to POST if that invariant is violated. Never an     ║
// ║    ACH/expedite rail.                                                                                   ║
// ║  • Human-triggered only (the office app arms the job on an Admin click); idempotent (reports           ║
// ║    already_submitted / already_confirmed without repeating).                                           ║
// ║  • If signed out, it ABORTS (not_logged_in) and reveals the tab for sign-in — it never submits.        ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝
//
// Lifecycle mirrors gusto-push.js: the background opens ONE hidden app.gusto.com tab and arms a job
// ({kind:"submit"|"confirm_wire", ...}). gusto-bridge.js (isolated world) CLAIMS it for this exact tab and
// postMessages it into this MAIN world. This script discovers what it needs from the page + the app's own
// captured GraphQL, does the one write, POSTs the result to Zoe, then tells the bridge "done".

(function () {
  if (window.__zoeGustoSubmit) return;
  window.__zoeGustoSubmit = true;

  const API = "https://zoe-dispatch.fly.dev";
  const GQL_HOST = "graphql.app.gusto.com";
  const SUBMIT_OP = "SubmitDraftPayroll";
  const WIRE_READ_OP = "WireInInstructions";
  const CONFIRM_OP = "ConfirmWireIn";
  const WIRE_BANK_NAME = "Mercury / Choice Financial Group";
  const AUTH_RE = /\/(login|sign[_-]?in|signin|session|sso|saml|oauth|mfa|two[_-]?factor)\b/i;
  // The only two mutation ops this script is EVER allowed to POST. Anything else is refused.
  const ALLOWED_OPS = { [SUBMIT_OP]: true, [CONFIRM_OP]: true };

  // Fallback GraphQL docs (the app's OWN captured query is preferred — see the fetch hook).
  const SUBMIT_DOC =
    "mutation SubmitDraftPayroll($input: SubmitDraftPayrollInput!) { submitDraftPayroll(input: $input) { result { __typename ... on SubmitDraftPayrollSuccess { draftPayroll { id payroll { id } } } ... on SubmitDraftPayrollFailure { errors { argument message } } } } }";
  const CONFIRM_DOC =
    "mutation ConfirmWireIn($input: ConfirmWireInInput!) { confirmWireIn(input: $input) { success errors { argument message } } }";

  const origFetch = window.fetch;
  if (!origFetch) return;

  // ── captured state (from hooking the app's own graphql traffic) ──────────────────────────────────────
  let headerTemplate = null; // { url, headers } carrying x-csrf-token / x-gusto-* / apollo headers
  let submitDoc = null; // the app's own SubmitDraftPayroll query doc, if it fired one
  let confirmDoc = null; // the app's own ConfirmWireIn query doc, if it fired one
  let wireInfo = null; // { wireId, amount } parsed from a WireInInstructions response
  let runLinkUniqueId = null; // uniqueIdentifier discovered from a captured graphql request (fallback to DOM)

  window.fetch = async function (input) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input && input.url;
      const init = arguments[1];
      if (url && url.indexOf(GQL_HOST) >= 0) {
        let parsed = null;
        try { parsed = init && init.body ? JSON.parse(init.body) : null; } catch (e) { /* non-JSON */ }
        const op = parsed && parsed.operationName;
        if (!headerTemplate && init && init.headers) {
          const h = {};
          try { new Headers(init.headers).forEach((v, k) => { h[k] = v; }); } catch (e) { /* ignore */ }
          if (h["x-csrf-token"] || h["x-gusto-view-name"]) headerTemplate = { url, headers: h };
        }
        if (op === SUBMIT_OP && parsed) {
          submitDoc = parsed.query || submitDoc;
          const uid = parsed.variables && parsed.variables.input && parsed.variables.input.uniqueIdentifier;
          if (uid) runLinkUniqueId = uid;
        } else if (op === CONFIRM_OP && parsed) {
          confirmDoc = parsed.query || confirmDoc;
        } else if (op === WIRE_READ_OP) {
          const json = await res.clone().json().catch(() => null);
          if (json) wireInfo = parseWireInstructions(json) || wireInfo;
        }
      }
    } catch (e) { /* never break the app's fetch */ }
    return res;
  };

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

  function onAuthPage() {
    try {
      if (AUTH_RE.test(location.pathname)) return true;
      if (document.querySelector('input[type="password"]')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }
  function revealTab() {
    try { window.postMessage({ __zoeGustoSubmit: true, type: "reveal" }, location.origin); } catch (e) { /* no-op */ }
  }
  function signalDone(ok) {
    try { window.postMessage({ __zoeGustoSubmit: true, type: "done", ok: !!ok }, location.origin); } catch (e) { /* no-op */ }
  }

  // ── uniqueIdentifier discovery (DOM "Run payroll" link, matched to the target check date) ─────────────
  // Shape: regular.<paySchedule-uuid>.<payGroup-uuid>.<YYYY-MM-DD>. We scan anchors/attrs for the token and
  // prefer the one whose trailing date == the requested check date (never submit a wrong week). If a single
  // draft is present and no check date matches, we use it only when exactly one candidate exists.
  const UNIQUE_ID_RE = /regular\.[0-9a-f][0-9a-f-]{7,}\.[0-9a-f][0-9a-f-]{7,}\.\d{4}-\d{2}-\d{2}/i;
  function uidCheckDate(uid) { const m = String(uid || "").match(/(\d{4}-\d{2}-\d{2})$/); return m ? m[1] : null; }
  function discoverUniqueIds() {
    const found = new Set();
    if (runLinkUniqueId && UNIQUE_ID_RE.test(runLinkUniqueId)) found.add(runLinkUniqueId.match(UNIQUE_ID_RE)[0]);
    try {
      const nodes = Array.from(document.querySelectorAll("a[href], [data-href], [href]"));
      for (const n of nodes) {
        const href = n.getAttribute("href") || n.getAttribute("data-href") || "";
        const m = String(href).match(UNIQUE_ID_RE);
        if (m) found.add(m[0]);
      }
      // Also scan the raw HTML as a last resort (some links are built in JS state).
      const html = document.documentElement ? document.documentElement.innerHTML : "";
      const all = html.match(new RegExp(UNIQUE_ID_RE.source, "ig")) || [];
      for (const u of all) found.add(u);
    } catch (e) { /* ignore */ }
    return Array.from(found);
  }
  function pickUniqueId(checkDate) {
    const ids = discoverUniqueIds();
    if (!ids.length) return null;
    if (checkDate) {
      const exact = ids.find((u) => uidCheckDate(u) === checkDate);
      if (exact) return exact;
    }
    return ids.length === 1 ? ids[0] : null; // ambiguous without a matching check date → refuse (null)
  }

  // Safe clicks to reach the run/review page (resilient to URL scheme). NEVER a submit/approve control —
  // the actual submit is the explicit SubmitDraftPayroll POST we make, not a page button.
  const SAFE_CLICK_TEXT = [/run payroll/i, /review (and )?submit/i, /continue to review/i, /payroll summary/i];
  const UNSAFE_CLICK_TEXT = /(cancel|delete|skip|approve timesheets)/i;
  // The "Safe expedite" (past-deadline) step: choose the wire option before submitting.
  const WIRE_CONTINUE_TEXT = /continue with pay by wire transfer|pay by wire/i;

  function clickByText(reList) {
    try {
      const nodes = Array.from(document.querySelectorAll("a,button,[role=button]"));
      for (const re of reList) {
        const el = nodes.find((n) => {
          const t = (n.textContent || "").trim();
          return t && re.test(t) && !UNSAFE_CLICK_TEXT.test(t) && n.offsetParent !== null;
        });
        if (el) { el.click(); return true; }
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  // If the "Safe expedite" step is present, choose wire. Returns true if we clicked it.
  function chooseWireIfExpedite() {
    try {
      const nodes = Array.from(document.querySelectorAll("a,button,[role=button]"));
      const el = nodes.find((n) => {
        const t = (n.textContent || "").trim();
        return t && WIRE_CONTINUE_TEXT.test(t) && n.offsetParent !== null;
      });
      if (el) { el.click(); return true; }
    } catch (e) { /* ignore */ }
    return false;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Wait until we discover a uniqueIdentifier for the target check date (or time out). Nudges the flow with
  // safe clicks. Resolves "ready" | "auth" | "timeout".
  async function waitForRun(checkDate, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (Date.now() - start > 3000 && onAuthPage()) return "auth";
      const uid = pickUniqueId(checkDate);
      if (uid && headerTemplate) return "ready";
      clickByText(SAFE_CLICK_TEXT);
      await sleep(1200);
    }
    return "timeout";
  }

  // Wait until a WireInInstructions response has been captured (wireId + amount). Nudges to the wire page.
  async function waitForWireInfo(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (Date.now() - start > 3000 && onAuthPage()) return "auth";
      if (wireInfo && wireInfo.wireId) return "ready";
      clickByText([/wire/i, /fund|funding/i, /payment/i]);
      await sleep(1200);
    }
    return "timeout";
  }

  function parseWireInstructions(json) {
    // Defensive: find a wireId-ish uuid + an amount somewhere in the WireInInstructions response. Prefer an
    // explicit wireInInstructions / wireIn node; fall back to a deep scan. Honest: the EXACT shape is
    // confirmed live; this reads the obvious fields first.
    try {
      const d = json && json.data;
      const node =
        (d && (d.wireInInstructions || d.wireIn || (d.company && (d.company.wireInInstructions || d.company.wireIn)))) || null;
      const pick = node || d || {};
      const wireId = pick.wireId || pick.id || (pick.wire && (pick.wire.id || pick.wire.wireId)) || null;
      let amount = pick.amount != null ? Number(pick.amount) : null;
      if (amount == null && pick.amount && pick.amount.amount != null) amount = Number(pick.amount.amount);
      if ((wireId == null || amount == null)) {
        // Deep scan fallback.
        const found = deepFindWire(d);
        if (found) return found;
      }
      if (wireId == null) return null;
      return { wireId: String(wireId), amount: Number.isFinite(amount) ? amount : null };
    } catch (e) { return null; }
  }
  function deepFindWire(obj) {
    try {
      const stack = [obj];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur || typeof cur !== "object") continue;
        const id = cur.wireId || (typeof cur.id === "string" && /wire/i.test(JSON.stringify(cur.__typename || "")) ? cur.id : null);
        if (id && (cur.amount != null)) {
          const amt = typeof cur.amount === "object" ? Number(cur.amount.amount) : Number(cur.amount);
          return { wireId: String(id), amount: Number.isFinite(amt) ? amt : null };
        }
        for (const k in cur) { const v = cur[k]; if (v && typeof v === "object") stack.push(v); }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // ── the writes ─────────────────────────────────────────────────────────────────────────────────────
  async function gqlPost(op, query, variables) {
    if (!ALLOWED_OPS[op]) throw new Error("refused: op not allowed (" + op + ")");
    const res = await origFetch(headerTemplate.url, {
      method: "POST",
      headers: headerTemplate.headers,
      body: JSON.stringify({ operationName: op, query, variables }),
      credentials: "include",
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error("http_" + res.status);
    return json;
  }

  const ALREADY_SUBMIT_RE = /already\s+(submitted|processed|run|paid)|not\s+(a\s+)?draft|no\s+draft|already\s+in\s+progress/i;
  function parseSubmitResponse(json) {
    const out = { outcome: "failed", draftPayrollId: null, payrollId: null, errors: [] };
    if (!json || typeof json !== "object") return out;
    const top = Array.isArray(json.errors) ? json.errors.map((e) => ({ argument: null, message: String((e && e.message) || "error") })) : [];
    const result = json.data && json.data.submitDraftPayroll && json.data.submitDraftPayroll.result;
    if (!result) {
      if (top.length) return { outcome: top.some((e) => ALREADY_SUBMIT_RE.test(e.message)) ? "already_submitted" : "failed", draftPayrollId: null, payrollId: null, errors: top };
      return out;
    }
    const typename = String(result.__typename || "");
    const draft = result.draftPayroll || null;
    const fail = Array.isArray(result.errors) ? result.errors.map((e) => ({ argument: (e && typeof e.argument === "string") ? e.argument : null, message: String((e && e.message) || "error") })) : [];
    if (/Success/i.test(typename) || (draft && (draft.id != null || (draft.payroll && draft.payroll.id != null)))) {
      return { outcome: "submitted", draftPayrollId: draft && draft.id != null ? String(draft.id) : null, payrollId: draft && draft.payroll && draft.payroll.id != null ? String(draft.payroll.id) : null, errors: [] };
    }
    const errs = fail.length ? fail : top;
    return { outcome: errs.some((e) => ALREADY_SUBMIT_RE.test(e.message)) ? "already_submitted" : "failed", draftPayrollId: null, payrollId: null, errors: errs };
  }

  // ── job runners ────────────────────────────────────────────────────────────────────────────────────
  async function runSubmit(job) {
    const period = (job && job.period) || {};
    const checkDate = (job && job.checkDate) || null;
    const result = {
      kind: "submit", ok: false, aborted: null, submitted: false, alreadySubmitted: false,
      draftPayrollId: null, payrollId: null,
      periodStart: period.start || null, periodEnd: period.end || null, checkDate: checkDate,
      uniqueIdentifier: null, expectedTotal: (job && job.expectedTotal != null) ? job.expectedTotal : null,
      headcount: (job && job.headcount != null) ? job.headcount : null, wirePathTaken: false, errors: [],
    };

    const reached = await waitForRun(checkDate, 45000);
    if (reached === "auth") { revealTab(); result.aborted = "not_logged_in"; return result; }
    if (reached !== "ready") { result.aborted = "could_not_find_run"; return result; }
    if (!headerTemplate) { result.aborted = "no_graphql_headers"; return result; }

    const uid = pickUniqueId(checkDate);
    if (!uid) { result.aborted = "no_unique_identifier"; return result; }
    result.uniqueIdentifier = uid;

    // Past-deadline runs first show a "Safe expedite" step — choose WIRE. On-time runs skip straight to submit.
    result.wirePathTaken = chooseWireIfExpedite();
    if (result.wirePathTaken) await sleep(1200);

    // WIRE ONLY — build the exact input and HARD-ASSERT the invariant before the irreversible POST.
    const input = { requestedPayoutRail: null, subscribeAndRunWithNextDayAch: false, uniqueIdentifier: uid };
    if (input.requestedPayoutRail !== null || input.subscribeAndRunWithNextDayAch !== false) {
      result.aborted = "refused_non_wire_rail"; return result; // never submit anything but the wire path
    }

    try {
      const json = await gqlPost(SUBMIT_OP, submitDoc || SUBMIT_DOC, { input });
      const parsed = parseSubmitResponse(json);
      result.errors = parsed.errors;
      result.draftPayrollId = parsed.draftPayrollId;
      result.payrollId = parsed.payrollId;
      if (parsed.outcome === "submitted") { result.submitted = true; result.ok = true; }
      else if (parsed.outcome === "already_submitted") { result.submitted = true; result.alreadySubmitted = true; result.ok = true; }
      else { result.aborted = "submit_failed"; }
    } catch (e) {
      result.aborted = "exception:" + ((e && e.message) || "error");
    }
    return result;
  }

  async function runConfirmWire(job) {
    const period = (job && job.period) || {};
    const result = {
      kind: "confirm_wire", ok: false, aborted: null, confirmed: false, alreadyConfirmed: false,
      periodStart: period.start || null, periodEnd: period.end || null, checkDate: (job && job.checkDate) || null,
      wireId: null, amount: null, gustoAmount: null, wireDate: (job && job.wireDate) || null, errors: [],
    };

    const reached = await waitForWireInfo(45000);
    if (reached === "auth") { revealTab(); result.aborted = "not_logged_in"; return result; }
    if (reached !== "ready" || !wireInfo || !wireInfo.wireId) { result.aborted = "no_wire_instructions"; return result; }
    if (!headerTemplate) { result.aborted = "no_graphql_headers"; return result; }

    result.wireId = wireInfo.wireId;
    result.gustoAmount = wireInfo.amount != null ? Number(wireInfo.amount) : null;

    // Prefer the app-provided amount; verify against Gusto's. Refuse on a mismatch (never confirm a wrong
    // amount). When only one is known, use it.
    const appAmt = (job && job.amount != null && Number.isFinite(Number(job.amount)) && Number(job.amount) > 0) ? Number(job.amount) : null;
    const gusAmt = (result.gustoAmount != null && result.gustoAmount > 0) ? result.gustoAmount : null;
    let amount = null;
    if (appAmt != null && gusAmt != null) {
      if (Math.abs(appAmt - gusAmt) > 0.01) { result.aborted = "amount_mismatch"; return result; }
      amount = appAmt;
    } else {
      amount = appAmt != null ? appAmt : gusAmt;
    }
    if (amount == null) { result.aborted = "no_amount"; return result; }
    result.amount = amount;

    const wireDate = result.wireDate || new Date().toISOString().slice(0, 10);
    result.wireDate = wireDate;
    const input = { amount: amount, bankName: WIRE_BANK_NAME, note: "", wireDate: wireDate, wireId: wireInfo.wireId, wireType: "WIRE_IN_REQUEST" };

    try {
      const json = await gqlPost(CONFIRM_OP, confirmDoc || CONFIRM_DOC, { input });
      const cw = json && json.data && json.data.confirmWireIn;
      const errs = []
        .concat(cw && Array.isArray(cw.errors) ? cw.errors.map((e) => ({ argument: (e && typeof e.argument === "string") ? e.argument : null, message: String((e && e.message) || "error") })) : [])
        .concat(Array.isArray(json && json.errors) ? json.errors.map((e) => ({ argument: null, message: String((e && e.message) || "error") })) : []);
      result.errors = errs;
      if (cw && cw.success === true) { result.confirmed = true; result.ok = true; }
      else if (errs.some((e) => /already\s+(confirmed|recorded|submitted)/i.test(e.message))) { result.confirmed = true; result.alreadyConfirmed = true; result.ok = true; }
      else { result.aborted = "confirm_failed"; }
    } catch (e) {
      result.aborted = "exception:" + ((e && e.message) || "error");
    }
    return result;
  }

  // ── POST the outcome to Zoe ─────────────────────────────────────────────────────────────────────────
  async function sendResult(job, result) {
    const endpoint = result.kind === "confirm_wire" ? "/api/payroll/gusto/confirm-wire-result" : "/api/payroll/gusto/submit-result";
    const body = Object.assign({}, result, { initiatedBy: (job && job.initiatedBy) || null });
    delete body.kind;
    try {
      await origFetch(API + endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) { /* best-effort — the tab still closes via the done relay/watchdog */ }
  }

  // ── job intake (the isolated-world bridge claims the job for THIS tab) ────────────────────────────────
  let started = false;
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__zoeGustoSubmit !== true || d.type !== "job" || !d.job) return;
    if (started) return;
    started = true;
    window.__zoeGustoPushActive = true; // stop gusto.js (read sync) from seed-navigating this tab away
    (async () => {
      let result;
      try {
        result = d.job.kind === "confirm_wire" ? await runConfirmWire(d.job) : await runSubmit(d.job);
      } catch (err) {
        result = { kind: (d.job && d.job.kind) || "submit", ok: false, aborted: "exception:" + ((err && err.message) || "error"), errors: [], periodStart: null, periodEnd: null };
      }
      await sendResult(d.job, result);
      // On a signed-out abort the tab was revealed for sign-in — do NOT close it. Otherwise close as usual.
      if (result.aborted !== "not_logged_in") signalDone(result.ok && !result.aborted);
    })();
  });

  try { window.postMessage({ __zoeGustoSubmit: true, type: "ready" }, location.origin); } catch (e) { /* no-op */ }
})();

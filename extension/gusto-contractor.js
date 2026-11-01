// Zoe Auto-Pull — Gusto CONTRACTOR pay staging (manifest content_scripts on app.gusto.com, world: MAIN so it
// can reuse the app's own session headers). Stages a contractor payment as a Gusto DRAFT from Zoe's
// human-confirmed plan, has Gusto REVIEW it, and reports Gusto's computed debits back to Zoe. It NEVER pays.
//
// ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ DRAFT + REVIEW ONLY. The only GraphQL this script sends is: find/create the contractor draft, read its  ║
// ║ contractors, AutoSaveContractorHours, AutoSaveContractorPaymentPurpose, ReviewPayGroup, and the debit   ║
// ║ read. It REFUSES any operation not on that list, and it has no SubmitPayGroup document at all. Paying   ║
// ║ stays a human click on "Submit payments" on Gusto's own review page (Zoe links to it).                 ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝
//
// Lifecycle mirrors gusto-push.js: the background opens ONE hidden app.gusto.com tab and arms the job;
// gusto-bridge.js (isolated world) CLAIMS it for this exact tab and posts it here; we stage, POST the result to
// Zoe, then tell the bridge "done". All request shapes were captured + replay-verified live 2026-10-31
// (src/lib/payroll/gustoContractorPay.ts holds the same docs + the tested matching rules).

(function () {
  if (window.__zoeGustoContractor) return;
  window.__zoeGustoContractor = true;

  const API = "https://zoe-dispatch.fly.dev";
  const GQL = "https://graphql.app.gusto.com/";
  const AUTH_RE = /\/(login|sign[_-]?in|signin|session|sso|saml|oauth|mfa|two[_-]?factor)\b/i;
  const ALLOWED_OPS = {
    UseUnprocessedContractorPayGroup: true,
    CreateContractorPayGroup: true,
    UseContractorPayPayItemsMetadata: true,
    AutoSaveContractorHours: true,
    AutoSaveContractorPaymentPurpose: true,
    ReviewPayGroup: true,
    UseContractorPayPayItemsByMemberIds: true,
  };

  const origFetch = window.fetch;
  if (!origFetch) return;

  // The app's own session headers (x-csrf-token, x-role-id, x-gusto-*), copied from its first GraphQL call.
  let headerTemplate = null;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (!headerTemplate && url && url.indexOf("graphql.app.gusto.com") >= 0 && init && init.headers) {
        const h = {};
        new Headers(init.headers).forEach((v, k) => { h[k] = v; });
        if (h["x-role-id"] || h["x-csrf-token"]) headerTemplate = h;
      }
    } catch (e) { /* never break the app */ }
    return origFetch.apply(this, arguments);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function post(type, extra) {
    try { window.postMessage(Object.assign({ __zoeGustoContractor: true, type }, extra || {}), location.origin); } catch (e) { /* no-op */ }
  }
  function onAuthPage() {
    try { return AUTH_RE.test(location.pathname) || !!document.querySelector('input[type="password"]'); } catch (e) { return false; }
  }

  async function gql(op, query, variables) {
    if (!ALLOWED_OPS[op]) throw new Error("refused op " + op);
    const headers = Object.assign({}, headerTemplate || {}, { "content-type": "application/json" });
    delete headers["content-length"];
    const r = await origFetch(GQL + "?operationName=" + encodeURIComponent(op), {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ operationName: op, query, variables }),
    });
    const json = await r.json().catch(() => null);
    if (!json) throw new Error(op + " HTTP " + r.status);
    return json;
  }

  // ── name matching (JS mirror of matchEntriesToMembers in gustoContractorPay.ts) ──────────────────────
  function tokens(name) {
    return String(name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z\s]/g, " ")
      .split(/\s+/).filter((t) => t.length > 1).sort();
  }
  function match(entries, members) {
    const byId = new Map(members.map((m) => [m.memberUuid, m]));
    const used = new Set();
    const matched = [];
    const unmatched = [];
    for (const e of entries) {
      const viaId = e.gustoId ? byId.get(e.gustoId) : null;
      if (viaId && !used.has(viaId.memberUuid)) { matched.push({ entry: e, member: viaId, by: "id" }); used.add(viaId.memberUuid); continue; }
      const et = tokens(e.name);
      const cands = members.filter((m) => {
        if (used.has(m.memberUuid)) return false;
        const mt = tokens(m.name);
        const short = et.length <= mt.length ? et : mt;
        const long = et.length <= mt.length ? mt : et;
        return short.length > 0 && short.every((t) => long.includes(t));
      });
      if (cands.length === 1) { matched.push({ entry: e, member: cands[0], by: "name" }); used.add(cands[0].memberUuid); }
      else unmatched.push(e);
    }
    return { matched, unmatched };
  }

  function parseMembers(json) {
    const rows = json && json.data && json.data.company && json.data.company.payGroupInterface && json.data.company.payGroupInterface.payItemsMetadata;
    if (!Array.isArray(rows)) return [];
    return rows.filter((r) => r && typeof r.memberUuid === "string").map((r) => {
      const first = String(r.preferredFirstName || r.legalFirstName || "").trim();
      const name = [first, String(r.lastName || "").trim()].filter(Boolean).join(" ") || String(r.businessName || "").trim();
      const country = typeof r.country === "string" ? r.country : null;
      return { memberUuid: r.memberUuid, name, country, international: !!country && !/^(us|usa|united states)$/i.test(country) };
    });
  }
  function memberErrors(result) {
    const out = [];
    const details = (result && result.memberErrorDetails) || [];
    for (const d of details) for (const e of (d && d.errors) || []) if (e && e.message) out.push({ memberUuid: d.member && d.member.id, message: String(e.message) });
    if (result && result.error && result.error.message) out.push({ memberUuid: null, message: String(result.error.message) });
    return out;
  }

  async function report(body) {
    try {
      await origFetch(API + "/api/payroll/gusto/contractor-result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) { /* the app shows "no report" honestly */ }
  }

  async function run(job) {
    const docs = job.docs || {};
    const base = { periodStart: job.periodStart || null, periodEnd: job.periodEnd || null, initiatedBy: job.initiatedBy || null };
    if (onAuthPage()) { post("reveal"); await report(Object.assign({}, base, { aborted: "not_logged_in" })); return false; }

    // Wait for the app's own GraphQL traffic so we have its session headers.
    for (let i = 0; i < 40 && !headerTemplate; i++) await sleep(500);
    if (!headerTemplate) {
      if (onAuthPage()) post("reveal");
      await report(Object.assign({}, base, { aborted: onAuthPage() ? "not_logged_in" : "no_session_headers" }));
      return false;
    }

    // 1. The open contractor draft (reuse it), else create one. A draft moves no money.
    let payGroupId = null;
    const found = await gql("UseUnprocessedContractorPayGroup", docs.findDraft, { hasPayContractorCapability: true, payTypes: ["CONTRACTOR_ADHOC"] });
    const nodes = found && found.data && found.data.company && found.data.company.unprocessedContractorsPayGroups && found.data.company.unprocessedContractorsPayGroups.nodes;
    if (Array.isArray(nodes) && nodes[0] && nodes[0].uniqueIdentifier) payGroupId = nodes[0].uniqueIdentifier;
    if (!payGroupId) {
      const created = await gql("CreateContractorPayGroup", docs.createDraft, { input: { payGroupType: "contractor_adhoc" } });
      const r = created && created.data && created.data.createContractorPayGroup && created.data.createContractorPayGroup.result;
      payGroupId = r && r.payGroupInterface && r.payGroupInterface.uniqueIdentifier;
    }
    if (!payGroupId) { await report(Object.assign({}, base, { aborted: "no_draft" })); return false; }

    // 2. Who is on the draft, matched to Zoe's confirmed entries.
    const members = parseMembers(await gql("UseContractorPayPayItemsMetadata", docs.members, { payGroupId }));
    if (!members.length) { await report(Object.assign({}, base, { aborted: "no_members", payGroupId })); return false; }
    const { matched, unmatched } = match(job.entries || [], members);

    // 3. Hours: the confirmed contractors get their hours; every OTHER contractor on the draft is set to 0 so the
    //    draft equals exactly what was reviewed in Zoe (no stale hours from an earlier manual edit).
    const plannedIds = new Set(matched.map((m) => m.member.memberUuid));
    const hoursUpdates = matched.map((m) => ({ memberUuid: m.member.memberUuid, hours: String(Math.round(m.entry.hours * 100) / 100) }))
      .concat(members.filter((m) => !plannedIds.has(m.memberUuid)).map((m) => ({ memberUuid: m.memberUuid, hours: "0" })));
    const saved = await gql("AutoSaveContractorHours", docs.saveHours, { input: { payGroupId, hoursUpdates } });
    const saveResult = saved && saved.data && saved.data.updatePayItemHours && saved.data.updatePayItemHours.result;
    const saveErrs = /Success/.test(String(saveResult && saveResult.__typename)) ? [] : memberErrors(saveResult);

    // 4. Transfer purpose for international contractors (PHP payments require it).
    const intl = matched.filter((m) => m.member.international).map((m) => m.member.memberUuid);
    if (intl.length) {
      await gql("AutoSaveContractorPaymentPurpose", docs.savePurpose, {
        input: { payGroupId, paymentPurposeUpdates: intl.map((memberUuid) => ({ memberUuid, paymentPurpose: job.transferPurpose || "0511300008" })) },
      }).catch(() => null);
    }

    // 5. Gusto's own review (mints the integrity hash the pay step needs; we do not pay).
    const reviewed = await gql("ReviewPayGroup", docs.review, { payGroupId, acknowledgedBlockedMemberIds: null });
    const rv = reviewed && reviewed.data && reviewed.data.reviewPayGroup && reviewed.data.reviewPayGroup.result;
    const reviewOk = !!(rv && /Success/.test(String(rv.__typename)) && rv.dataHash);
    const reviewErrs = reviewOk ? [] : memberErrors(rv).concat((reviewed && reviewed.errors) || []).map((e) => e.message || String(e));

    // 6. Gusto's computed debit per contractor (the numbers the human confirms against).
    const debits = new Map();
    try {
      const d = await gql("UseContractorPayPayItemsByMemberIds", docs.debits, { ids: members.map((m) => m.memberUuid), payGroupId });
      const items = d && d.data && d.data.company && d.data.company.payGroupInterface && d.data.company.payGroupInterface.payItemInterfacesByMemberIds;
      for (const it of items || []) {
        const amt = it && it.calculatedAmounts && it.calculatedAmounts.totalDebitAmount && Number(it.calculatedAmounts.totalDebitAmount.amount);
        if (it && it.member && Number.isFinite(amt)) debits.set(it.member.id, amt);
      }
    } catch (e) { /* debits are informational */ }

    const errFor = (uuid) => saveErrs.filter((e) => e.memberUuid === uuid).map((e) => e.message).join("; ") || null;
    const out = matched.map((m) => ({
      key: m.entry.key, name: m.member.name, memberUuid: m.member.memberUuid, hours: m.entry.hours, matchedBy: m.by,
      outcome: errFor(m.member.memberUuid) ? "failed" : "staged", debit: debits.has(m.member.memberUuid) ? debits.get(m.member.memberUuid) : null,
      reason: errFor(m.member.memberUuid),
    })).concat(unmatched.map((e) => ({ key: e.key, name: e.name, memberUuid: null, hours: e.hours, matchedBy: null, outcome: "unmatched", debit: null, reason: "No contractor with this name or Gusto id on the Gusto draft." })));
    let total = 0;
    for (const v of debits.values()) total += v;

    await report(Object.assign({}, base, {
      payGroupId,
      reviewOk,
      reviewErrors: reviewErrs.concat(saveErrs.filter((e) => !e.memberUuid).map((e) => e.message)),
      totalDebit: Math.round(total * 100) / 100,
      achSpeed: rv && rv.riskResult ? rv.riskResult.achSpeed || null : null,
      wireInFunded: rv && rv.riskResult && typeof rv.riskResult.wireInFunded === "boolean" ? rv.riskResult.wireInFunded : null,
      members: out,
    }));
    return reviewOk;
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || !e.data || e.data.__zoeGustoContractor !== true || e.data.type !== "job") return;
    let ok = false;
    try { ok = await run(e.data.job || {}); } catch (err) {
      await report({ aborted: "error: " + String((err && err.message) || err).slice(0, 160) });
    }
    post("done", { ok });
  });

  // Ask the bridge for a job once the page settles (it only answers for the tab the background opened).
  setTimeout(() => post("ready"), 1500);
})();

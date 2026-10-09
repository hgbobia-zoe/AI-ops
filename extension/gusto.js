// Zoe Auto-Pull — Gusto content script (manifest content_scripts, world: MAIN so it can see the app's own
// fetches). Gusto's official API is pending approval, so — like Goodshuffle/Instawork — we replay the
// product's internal GraphQL calls from the logged-in tab (POST graphql.app.gusto.com, cookie auth).
// Rather than hardcode Gusto's versioned queries + CSRF headers, this HOOKS the app's own reads and replays
// them: MembersTable (roster), TimeTrackingDashboard (pay periods), and — as a TEMPLATE — the per-worker
// CompanyMemberDashboardPeopleShowPay (compensation), which it loops over every member id to pull pay
// rates. It POSTs { members, timeTracking, pay } to the Zoe ingest. Read-only: it only replays the app's
// own READ queries (swapping the member id on the pay query) — it never issues a payroll write.

(function () {
  const API = "https://zoe-dispatch.fly.dev";
  const cap = Object.create(null); // operationName → { url, headers, body, response } (MembersTable/TimeTrackingDashboard)
  let payTemplate = null; // { url, headers, body } for CompanyMemberDashboardPeopleShowPay, replayed per member
  let postTimer = null;

  const origFetch = window.fetch;
  if (!origFetch || window.__zoeGustoHook) return;
  window.__zoeGustoHook = true;

  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : (input && input.url);
      if (url && url.indexOf("graphql.app.gusto.com") >= 0) {
        let parsed = null;
        try { parsed = init && init.body ? JSON.parse(init.body) : null; } catch (e) { /* non-JSON body */ }
        const op = parsed && parsed.operationName;
        const headers = {};
        try { if (init && init.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; }); } catch (e) { /* ignore */ }
        if (op === "MembersTable" || op === "TimeTrackingDashboard") {
          const json = await res.clone().json().catch(() => null);
          if (json) { cap[op] = { url, headers, body: init && init.body, response: json }; schedulePost(); }
        } else if (op === "CompanyMemberDashboardPeopleShowPay") {
          payTemplate = { url, headers, body: init && init.body }; // seed the template; loop it on send
          schedulePost();
        }
      }
    } catch (e) { /* never break the app's fetch */ }
    return res;
  };

  function memberIds() {
    try {
      return (cap.MembersTable.response.data.company.members.nodes || []).map((n) => n && n.id).filter(Boolean);
    } catch (e) { return []; }
  }

  // Replay the captured pay query once per member id → { memberId: payResponse }. Sequential + best-effort.
  async function pullPay(ids) {
    if (!payTemplate || !ids.length) return null;
    let tmpl;
    try { tmpl = JSON.parse(payTemplate.body); } catch (e) { return null; }
    const out = {};
    for (const id of ids) {
      try {
        const body = JSON.stringify({ ...tmpl, variables: { ...(tmpl.variables || {}), companyMemberId: id } });
        const res = await origFetch(payTemplate.url, { method: "POST", headers: payTemplate.headers, body, credentials: "include" });
        const json = await res.json().catch(() => null);
        if (json && !json.errors) out[id] = json;
      } catch (e) { /* skip this worker's rate */ }
    }
    return out;
  }

  // If we're a BACKGROUND (hidden) tab — i.e. the one the Auto-Pull worker keeps alive, which lands on the
  // dashboard — hop to the People page so the roster/pay queries actually fire (the hook is passive; it
  // needs the app to run them). Never on a visible tab (that would yank the operator's page). Once only.
  function maybeSeedNavigate() {
    try {
      if (!document.hidden || window.__zoeGustoNav) return;
      const p = location.pathname;
      if (/\/people(\/|$)/.test(p) || /\/pay(\/|$|\?)/.test(p)) return; // already where queries fire
      if (cap.MembersTable) return; // already captured
      const slug = p.split("/").filter(Boolean)[0];
      if (!slug) return;
      window.__zoeGustoNav = true;
      location.assign(location.origin + "/" + slug + "/people/all");
    } catch (e) { /* ignore */ }
  }
  setTimeout(maybeSeedNavigate, 5000);

  function schedulePost() { clearTimeout(postTimer); postTimer = setTimeout(sendToZoe, 3000); }

  async function sendToZoe() {
    if (!cap.MembersTable && !cap.TimeTrackingDashboard) return;
    let pay = null;
    if (cap.MembersTable && payTemplate) pay = await pullPay(memberIds());
    let posted = false;
    try {
      const res = await origFetch(API + "/api/payroll/gusto/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          members: cap.MembersTable ? cap.MembersTable.response : null,
          timeTracking: cap.TimeTrackingDashboard ? cap.TimeTrackingDashboard.response : null,
          pay,
        }),
      });
      posted = !!(res && res.ok);
    } catch (e) { /* best-effort — next on-demand sync retries */ }
    // Tell the background (via the isolated-world gusto-bridge.js, since this MAIN-world script has no
    // chrome.* messaging) that an on-demand sync has posted, so it can close the dedicated Gusto tab.
    try { window.postMessage({ __zoeGusto: true, type: "posted", ok: posted }, location.origin); } catch (e) { /* no-op */ }
  }

  // NOTE: no self-refresh timer. Gusto is now an ON-DEMAND pull (payroll is not a continuous job). The
  // Auto-Pull worker opens one hidden tab per sync request; this script captures + posts once on load
  // (maybeSeedNavigate → the app's reads → the fetch hook → sendToZoe), then the worker closes the tab.
})();

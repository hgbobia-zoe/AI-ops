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
      // Gusto moved MembersTable from a plain nodes[] list to a Relay edges[].node connection (2026-10-26);
      // read edges, falling back to nodes so an older/cached response still works.
      const members = cap.MembersTable.response.data.company.members;
      const list = Array.isArray(members.nodes) ? members.nodes
        : Array.isArray(members.edges) ? members.edges.map((e) => e && e.node) : [];
      return list.map((n) => n && n.id).filter(Boolean);
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
      // Never hop this tab to the People page if a DRAFT hours PUSH is running in it (gusto-push.js sets this
      // flag the moment it claims a job) — that would yank the push off the payroll run mid-write.
      if (window.__zoeGustoPushActive) return;
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

  // ── New in Gusto (People): the on-demand new-hire delta ─────────────────────────────────────────────
  // Trimmed READ queries (captured + tested live 2026-11-05). The roster includes pending hires still
  // onboarding (MembersTable filters them out) and draft offers. Zoe answers with the ids that are NOT in
  // People yet; only for those do we read personal details (birthday, phone, email, legal name, start
  // date). The details query never asks for tax ids, bank info or addresses. Read-only.
  const Q_ROSTER = "query ZoeNewHireRoster($after: String) { company { id members(first: 100, after: $after, employmentStatus: CURRENT_OR_PENDING_HIRE) { edges { node { id legalFirstName lastName preferredFullName personType jobTitle latestEmployment { startDate endDate setupStatus workerType } upcomingEmployment { startDate setupStatus workerType } } } pageInfo { hasNextPage endCursor } } draftTeamMembers { nodes { id legalFirstName lastName preferredFirstName startDate step sendOffer teamMemberType } } } }";
  const Q_ONBOARDING = "query ZoeNewHireOnboarding { company { id onboarding: membersForPeoplePage(first: 50, limit: 50, tab: \"onboarding\") { nodes { id legalFirstName lastName preferredFullName jobTitle latestEmployment { startDate setupStatus workerType } upcomingEmployment { startDate setupStatus workerType } offer { status } } } } }";
  const Q_DETAILS = "query ZoeNewHireDetails($companyMemberId: ID!) { member { id company { id person: memberById(id: $companyMemberId) { id birthday email phoneNumber { callingCode countryCode number } currentLegalName { firstName lastName } latestEmployment { startDate } upcomingEmployment { startDate } } } } }";

  async function gql(operationName, query, variables) {
    const src = cap.MembersTable; // reuse the app's own endpoint + headers (CSRF etc.) from its roster read
    if (!src) return null;
    const res = await origFetch(src.url, { method: "POST", headers: src.headers, credentials: "include", body: JSON.stringify({ operationName, query, variables: variables || {} }) });
    const json = await res.json().catch(() => null);
    return json && !json.errors ? json : null;
  }

  async function postNewHires(payload) {
    const res = await origFetch(API + "/api/payroll/gusto/new-hires", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    return res && res.ok ? res.json().catch(() => null) : null;
  }

  async function newHireDelta() {
    try {
      const roster = await gql("ZoeNewHireRoster", Q_ROSTER, { after: null });
      if (!roster) return;
      const onboarding = await gql("ZoeNewHireOnboarding", Q_ONBOARDING, {});
      const r = await postNewHires({ kind: "roster", roster, onboarding });
      const ids = (r && Array.isArray(r.needDetails) ? r.needDetails : []).slice(0, 25);
      if (!ids.length) return;
      const details = {};
      for (const id of ids) {
        const d = await gql("ZoeNewHireDetails", Q_DETAILS, { companyMemberId: id });
        if (d) details[id] = d;
      }
      if (Object.keys(details).length) await postNewHires({ kind: "details", details });
    } catch (e) { /* best effort: the payroll sync already posted */ }
  }

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
    // New in Gusto: runs before we tell the background to close this tab.
    if (cap.MembersTable) await newHireDelta();
    // Tell the background (via the isolated-world gusto-bridge.js, since this MAIN-world script has no
    // chrome.* messaging) that an on-demand sync has posted, so it can close the dedicated Gusto tab.
    try { window.postMessage({ __zoeGusto: true, type: "posted", ok: posted }, location.origin); } catch (e) { /* no-op */ }
  }

  // NOTE: no self-refresh timer. Gusto is now an ON-DEMAND pull (payroll is not a continuous job). The
  // Auto-Pull worker opens one hidden tab per sync request; this script captures + posts once on load
  // (maybeSeedNavigate → the app's reads → the fetch hook → sendToZoe), then the worker closes the tab.
})();

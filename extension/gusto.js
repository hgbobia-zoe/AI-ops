// Zoe Auto-Pull — Gusto content script (manifest content_scripts, world: MAIN so it can see the app's own
// fetches). Gusto's official API is pending approval, so — like Goodshuffle/Instawork — we replay the
// product's internal calls from the logged-in tab. Gusto is a GraphQL app (POST graphql.app.gusto.com),
// cookie-authenticated. Rather than hardcode Gusto's versioned query documents + CSRF headers, this hooks
// the app's own MembersTable (roster) + TimeTrackingDashboard (pay periods) requests, forwards their raw
// responses to the Zoe ingest (/api/payroll/gusto/import), and REPLAYS the exact captured request on a
// timer so the snapshot stays fresh without the operator re-navigating. The Zoe server never calls Gusto.
// Read-only: it only captures/replays the app's own read queries — it never issues a payroll write.

(function () {
  const API = "https://zoe-dispatch.fly.dev";
  const WANT = { MembersTable: "members", TimeTrackingDashboard: "timeTracking" };
  const cap = Object.create(null); // operationName → { url, headers, body, response }
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
        if (op && WANT[op]) {
          const headers = {};
          try { if (init && init.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; }); } catch (e) { /* ignore */ }
          const json = await res.clone().json().catch(() => null);
          if (json) { cap[op] = { url, headers, body: init && init.body, response: json }; schedulePost(); }
        }
      }
    } catch (e) { /* never break the app's fetch */ }
    return res;
  };

  function schedulePost() { clearTimeout(postTimer); postTimer = setTimeout(sendToZoe, 2500); }

  async function sendToZoe() {
    if (!cap.MembersTable && !cap.TimeTrackingDashboard) return;
    try {
      await origFetch(API + "/api/payroll/gusto/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          members: cap.MembersTable ? cap.MembersTable.response : null,
          timeTracking: cap.TimeTrackingDashboard ? cap.TimeTrackingDashboard.response : null,
        }),
      });
    } catch (e) { /* best-effort — next capture/refresh retries */ }
  }

  // Self-refresh: replay each captured GraphQL request verbatim (same url + headers + body, cookies via
  // credentials:include) so the snapshot stays fresh even if the operator doesn't revisit those pages.
  async function refresh() {
    const ops = Object.keys(cap);
    if (!ops.length) return;
    for (const op of ops) {
      const c = cap[op];
      try {
        const res = await origFetch(c.url, { method: "POST", headers: c.headers, body: c.body, credentials: "include" });
        const json = await res.json().catch(() => null);
        if (json && !json.errors) c.response = json;
      } catch (e) { /* keep the last good response */ }
    }
    schedulePost();
  }
  setInterval(refresh, 10 * 60 * 1000);
})();

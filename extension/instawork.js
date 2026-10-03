// Zoe Auto-Pull — Instawork content script. Declared to run on app.instawork.com (manifest content_scripts),
// so it loads automatically with host access granted at install. It fetches the business dashboard's gig
// groups IN this tab (same-origin, carrying the operator's Instawork session cookies) and POSTs them to the
// Zoe ingest (/api/instawork/import), which parses + snapshots them. The Zoe server NEVER calls Instawork
// itself (datacenter-IP block risk) — this browser pull is the only path. Mirrors content.js (the GS one):
// scheduling lives in the background service worker; this runs on load and whenever the worker nudges it.

(function () {
  const DEFAULTS = { apiBase: "https://zoe-dispatch.fly.dev", enabled: true };
  let running = false;

  async function cfg() {
    const c = await chrome.storage.local.get(DEFAULTS);
    return {
      apiBase: (c.apiBase || DEFAULTS.apiBase).replace(/\/+$/, ""),
      enabled: c.enabled !== false,
    };
  }

  async function cycle() {
    if (running) return;
    running = true;
    try {
      const { apiBase, enabled } = await cfg();
      if (!enabled) return;
      const url = location.origin + "/api/partner/gigs/groups/?timeframe=in_progress_upcoming&page=1&page_size=100";
      let json;
      try {
        const res = await fetch(url, { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
        if (!res.ok) return; // signed out / blocked — the app's freshness state covers it
        json = await res.json();
      } catch (e) {
        return; // network/parse error — swallow; the snapshot just goes stale
      }
      const results = (json && json.results) || [];
      try {
        await fetch(apiBase + "/api/instawork/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ results }),
        });
      } catch (e) {
        /* best-effort — try again next cycle */
      }
    } finally {
      running = false;
    }
  }

  // Run shortly after the page settles (covers a tab the worker just opened, and normal navigation).
  setTimeout(cycle, 4000);

  // The worker nudges a pull by flipping storage.pullNow (reliable across tabs even when the SW slept).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.pullNow) cycle();
  });
  // Also honor a direct message if the worker/popup sends one.
  chrome.runtime.onMessage.addListener((m, _s, resp) => {
    if (m && m.type === "zoe-pull-now") { cycle().then(() => resp && resp({ ok: true })); return true; }
    return false;
  });
})();

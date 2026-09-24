// Zoe Auto-Pull — content script. Declared to run on pro.goodshuffle.com (manifest content_scripts),
// so it loads automatically with host access granted at install. It runs the read-pull IN this tab
// (same-origin fetches carry the operator's Goodshuffle cookies), posts the heartbeat directly (that
// endpoint is CORS-open), records lastRun, and tells the background worker the status for the badge.
//
// As of v1.3.0 SCHEDULING lives in the background service worker (chrome.alarms) — NOT a setInterval
// here (the alarm also ENSURES this tab exists, so the operator no longer has to keep a GS tab open).
// This script runs the pull on load and whenever the worker nudges it (storage.pullNow / a message).

(function () {
  const DEFAULTS = { apiBase: "https://zoe-dispatch.fly.dev", intervalMin: 10, enabled: true };
  let running = false;

  async function cfg() {
    const c = await chrome.storage.local.get(DEFAULTS);
    return {
      apiBase: (c.apiBase || DEFAULTS.apiBase).replace(/\/+$/, ""),
      intervalMin: Math.max(1, Number(c.intervalMin) || DEFAULTS.intervalMin),
      enabled: c.enabled !== false,
    };
  }

  async function heartbeat(apiBase, status, detail) {
    try {
      await fetch(apiBase + "/api/pull/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "extension", status, detail: detail ?? null, at: new Date().toISOString() }),
      });
    } catch (e) {
      /* best-effort; the pull already ran */
    }
  }

  function badge(status, detail) {
    try { chrome.runtime.sendMessage({ type: "zoe-badge", status, detail }, () => void chrome.runtime.lastError); } catch (e) { /* worker asleep */ }
  }

  async function cycle(reason) {
    if (running) return;
    running = true;
    try {
      const { apiBase, intervalMin, enabled } = await cfg();
      if (!enabled) { badge("off"); return; }

      // Cross-tab throttle: if another GSPRO tab pulled successfully very recently, don't duplicate the
      // work. A manual/handshake "Pull now" always runs.
      if (reason !== "manual") {
        const { lastRun } = await chrome.storage.local.get("lastRun");
        if (lastRun && lastRun.status === "ok" && Date.now() - lastRun.at < intervalMin * 60000 * 0.5) return;
      }

      let res;
      try { res = await zoePull(apiBase); } catch (e) { res = { ok: false, loggedIn: true, error: "pull error: " + String(e).slice(0, 120) }; }
      if (!res) res = { ok: false, loggedIn: true, error: "no result" };

      const status = res.loggedIn === false ? "not_logged_in" : res.ok ? "ok" : "error";
      const detail = status === "ok" ? `${res.stops || 0} stops · ${res.bookings || 0} bookings` : res.error || "pull error";
      await heartbeat(apiBase, status, detail);
      await chrome.storage.local.set({ lastRun: { at: Date.now(), status, result: res, reason } });
      badge(status, detail);
    } finally {
      running = false;
    }
  }

  // Run shortly after the page settles (covers a tab the worker just opened, and normal navigation).
  setTimeout(() => cycle("load"), 4000);

  // The worker nudges a pull by flipping storage.pullNow (reliable across tabs even when the SW slept).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.pullNow) cycle("manual");
  });
  // Also honor a direct message if the worker/popup sends one.
  chrome.runtime.onMessage.addListener((m, _s, resp) => {
    if (m && m.type === "zoe-pull-now") { cycle("manual").then(() => resp && resp({ ok: true })); return true; }
    return false;
  });
})();

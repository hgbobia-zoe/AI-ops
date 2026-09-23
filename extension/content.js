// Zoe Auto-Pull — content script. Declared to run on pro.goodshuffle.com (manifest content_scripts),
// so it loads automatically with host access granted at install. It self-schedules the pull (no
// background injection for Chrome to revoke), calls zoePull() from pull-injected.js (same content
// world), posts the heartbeat directly (that endpoint is CORS-open), records lastRun, and tells the
// background worker the status for the toolbar badge. A signed-in GSPRO tab must stay open — same as
// before — but there is no per-site permission to re-grant after Chrome updates.

(function () {
  const DEFAULTS = { apiBase: "https://zoe-dispatch.fly.dev", intervalMin: 10, enabled: true };
  let running = false;
  let timer = null;
  let curIntervalMin = DEFAULTS.intervalMin;

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
      curIntervalMin = intervalMin;
      if (!enabled) { badge("off"); return; }

      // Cross-tab throttle: if another GSPRO tab pulled successfully very recently, don't duplicate the
      // work. A manual "Pull now" always runs.
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

  function schedule(intervalMin) {
    if (timer) clearInterval(timer);
    curIntervalMin = intervalMin;
    timer = setInterval(() => cycle("interval"), intervalMin * 60000);
  }

  // Kick off shortly after the page settles, then on the interval.
  cfg().then(({ intervalMin }) => {
    schedule(intervalMin);
    setTimeout(() => cycle("load"), 4000);
  });

  // Manual "Pull now" from the popup flips storage.pullNow; react immediately. Also honor a direct
  // message if the popup/background sends one.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.pullNow) cycle("manual");
    if (changes.intervalMin) {
      const v = Math.max(1, Number(changes.intervalMin.newValue) || DEFAULTS.intervalMin);
      if (v !== curIntervalMin) schedule(v);
    }
  });
  chrome.runtime.onMessage.addListener((m, _s, resp) => {
    if (m && m.type === "zoe-pull-now") { cycle("manual").then(() => resp && resp({ ok: true })); return true; }
    return false;
  });
})();

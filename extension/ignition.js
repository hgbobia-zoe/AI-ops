// Zoe Auto-Pull — Ignition content script. Declared to run on ignition.zonarsystems.com (manifest
// content_scripts), so it loads automatically with host access granted at install. It is the office-
// machine mint path for Zonar's live-tracking ETA links (etaLink/<code>), mirroring how content.js +
// pull-injected.js drive Goodshuffle:
//
//   • It injects ignition-injected.js into the page's MAIN WORLD (a web_accessible_resource), which does
//     the appsync calls (reads the logged-in IdToken, searchUnits, createEtaLink) in the page's own
//     origin/session — the same context as Ignition's own successful calls.
//   • It polls OUR server (/api/etalink/pending) on a short timer so a departure mint lands PROMPTLY
//     (~15s), independent of the 10-min read-pull cadence. For each pending request it asks the injected
//     script to mint, then posts the minted code (or an honest error) to /api/etalink/result.
//   • `ready` (whether an IdToken is present → a mint can succeed) is sent on each poll so the server's
//     departure flow only blocks the "on the way" SMS when a signed-in Ignition tab is actually minting.
//
// Those POSTs to our Fly server run from the content-script context (host_permission granted), so they
// are not subject to the Ignition page's CSP. We never transmit the IdToken itself — only mint results.

(function () {
  const DEFAULTS = { apiBase: "https://zoe-dispatch.fly.dev", enabled: true };
  const POLL_MS = 15000; // short cadence so a departure mint lands promptly
  const PENDING = {}; // id -> resolver for an in-flight main-world mint
  let injectedReady = false;
  let running = false;

  // Inject the main-world bridge once.
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("ignition-injected.js");
    s.onload = function () {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    /* injection blocked — cycle() will no-op via the readiness timeout */
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d) return;
    if (d.__zoe === "eta-inject-ready") {
      injectedReady = true;
      return;
    }
    if (d.__zoe === "eta-mint-res" && d.id && PENDING[d.id]) {
      const resolve = PENDING[d.id];
      delete PENDING[d.id];
      resolve(d.res || { error: "empty_result" });
    }
  });

  function mintViaPage(req) {
    return new Promise((resolve) => {
      const id = Date.now() + "-" + Math.random().toString(36).slice(2);
      PENDING[id] = resolve;
      window.postMessage({ __zoe: "eta-mint-req", id, req }, "*");
      setTimeout(() => {
        if (PENDING[id]) {
          delete PENDING[id];
          resolve({ error: "mint_timeout" });
        }
      }, 30000);
    });
  }

  async function cfg() {
    const c = await chrome.storage.local.get(DEFAULTS);
    return {
      apiBase: (c.apiBase || DEFAULTS.apiBase).replace(/\/+$/, ""),
      enabled: c.enabled !== false,
    };
  }

  // Signed-in only when an IdToken is present (same token the mint reads). A boolean presence check —
  // the token value itself never leaves the page.
  function hasIdToken() {
    try {
      return !!localStorage.getItem("IdToken");
    } catch (e) {
      return false;
    }
  }

  async function cycle() {
    if (running) return;
    running = true;
    try {
      const { apiBase, enabled } = await cfg();
      if (!enabled) return;
      const ready = hasIdToken();
      let reqs = [];
      try {
        const r = await fetch(apiBase + "/api/etalink/pending?ready=" + (ready ? "1" : "0"), {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!r.ok) return;
        const j = await r.json();
        reqs = (j && j.requests) || [];
      } catch (e) {
        return; // server unreachable — try again next cycle
      }
      if (!reqs.length) return;
      if (!ready) {
        // Signed out: report each as an error so the departure flow stops waiting (no fabricated link).
        for (const req of reqs) await postResult(apiBase, { id: req.id, error: "not_signed_in" });
        return;
      }
      // Wait briefly for the injected bridge to be live.
      for (let i = 0; i < 20 && !injectedReady; i++) await new Promise((r) => setTimeout(r, 100));
      for (const req of reqs) {
        let res;
        try {
          res = await mintViaPage(req);
        } catch (e) {
          res = { error: "mint_error" };
        }
        const body =
          res && res.code
            ? { id: req.id, code: res.code }
            : { id: req.id, error: (res && res.error) || "mint_failed" };
        await postResult(apiBase, body);
      }
    } finally {
      running = false;
    }
  }

  async function postResult(apiBase, body) {
    try {
      await fetch(apiBase + "/api/etalink/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      /* best-effort; a failed POST leaves the request pending for the next cycle */
    }
  }

  // Run shortly after load, then on a short self-timer (prompt mints), plus the shared pullNow nudge.
  setTimeout(cycle, 3000);
  setInterval(cycle, POLL_MS);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.pullNow) cycle();
  });
  chrome.runtime.onMessage.addListener((m, _s, resp) => {
    if (m && m.type === "zoe-pull-now") {
      cycle().then(() => resp && resp({ ok: true }));
      return true;
    }
    return false;
  });
})();

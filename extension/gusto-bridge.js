// Zoe Auto-Pull — Gusto bridge (isolated-world content script on app.gusto.com).
//
// gusto.js runs in world MAIN (it must hook the app's own window.fetch to capture Gusto's versioned
// GraphQL operations + CSRF headers), and world-MAIN scripts have no access to the chrome.* messaging
// APIs. So when gusto.js finishes POSTing the payroll snapshot to Zoe it emits a window message; this
// bridge — a normal isolated-world content script, which DOES have chrome.runtime — relays that to the
// background service worker. The background uses it to close the dedicated on-demand Gusto tab it opened
// (so a payroll sync never leaves a lingering app.gusto.com tab). One-way, best-effort.

(function () {
  if (window.__zoeGustoBridge) return;
  window.__zoeGustoBridge = true;

  window.addEventListener("message", (e) => {
    try {
      // Only trust same-window messages carrying our marker (ignore anything the page posts).
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.__zoeGusto !== true || d.type !== "posted") return;
      chrome.runtime.sendMessage({ type: "zoe-gusto-posted", ok: !!d.ok });
    } catch (err) {
      /* extension context gone / message channel closed — nothing to do */
    }
  });
})();

// Zoe Auto-Pull — Gusto bridge (isolated-world content script on app.gusto.com).
//
// The MAIN-world Gusto scripts (gusto.js = read sync, gusto-push.js = DRAFT hours push) must hook the app's
// own window.fetch, so they run in world MAIN — which has NO access to the chrome.* messaging APIs. This
// bridge is a normal isolated-world content script (it DOES have chrome.runtime), so it relays between those
// MAIN-world scripts and the background service worker. One-way, best-effort.
//
// READ sync (gusto.js): on its "posted" window message, relay {type:"zoe-gusto-posted"} so the background
// closes the dedicated on-demand sync tab.
//
// HOURS PUSH (gusto-push.js): when gusto-push posts "ready", CLAIM the push job for THIS exact tab from the
// background (it only hands the job to the tab it opened — a user's own Gusto tab never gets it). If a job
// comes back, post it into the MAIN world for gusto-push to execute. On gusto-push's "done" message, relay
// {type:"zoe-gusto-push-done"} so the background closes the dedicated push tab (watchdog reaps it otherwise).

(function () {
  if (window.__zoeGustoBridge) return;
  window.__zoeGustoBridge = true;

  function claimPushJob() {
    try {
      chrome.runtime.sendMessage({ type: "zoe-gusto-push-claim" }, (resp) => {
        try {
          if (chrome.runtime && chrome.runtime.lastError) return; // not our tab / channel closed
          const job = resp && resp.job;
          if (job) window.postMessage({ __zoeGustoPush: true, type: "job", job }, location.origin);
        } catch (e) { /* no-op */ }
      });
    } catch (e) { /* extension context gone */ }
  }

  window.addEventListener("message", (e) => {
    try {
      // Only trust same-window messages carrying our markers (ignore anything else the page posts).
      if (e.source !== window) return;
      const d = e.data;
      if (!d) return;

      // READ sync completed → close the dedicated sync tab.
      if (d.__zoeGusto === true && d.type === "posted") {
        chrome.runtime.sendMessage({ type: "zoe-gusto-posted", ok: !!d.ok });
        return;
      }

      // HOURS PUSH handshakes.
      if (d.__zoeGustoPush === true) {
        if (d.type === "ready") { claimPushJob(); return; }
        if (d.type === "done") { chrome.runtime.sendMessage({ type: "zoe-gusto-push-done", ok: !!d.ok }); return; }
      }
    } catch (err) {
      /* extension context gone / message channel closed — nothing to do */
    }
  });
})();

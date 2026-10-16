// Zoe Auto-Pull — Instawork content script. Declared to run on app.instawork.com (manifest content_scripts),
// so it loads automatically with host access granted at install. It fetches the business dashboard's gig
// groups IN this tab (same-origin, carrying the operator's Instawork session cookies) and POSTs them to the
// Zoe ingest (/api/instawork/import), which parses + snapshots them. It ALSO captures each booked pro's phone
// — the gig-groups list has none, but the per-group timesheet view does — and POSTs those to
// /api/instawork/contacts so a shift debrief can actually reach an Instawork worker. The Zoe server NEVER
// calls Instawork itself (datacenter-IP block risk) — this browser pull is the only path.
//
// Scheduling mirrors content.js (GS) BUT with one critical addition: a self-timer. GS stays fresh because
// the operator keeps the pro.goodshuffle.com tab open all day and the service-worker alarm nudges it. The
// Instawork tab is a BACKGROUND tab the worker opens (ensureInstaworkTab); Chrome can discard it and the SW
// can sleep, so relying on the worker's nudge alone let the snapshot silently go stale (the symptom we hit:
// signed in, yet "not connected"). So this tab ALSO re-pulls on its own cadence — matching the documented
// intent in background.js ("its content script polls our server on its own short timer"). A cross-tab
// throttle keeps the self-timer and the worker nudge from double-pulling.

(function () {
  const DEFAULTS = { apiBase: "https://zoe-dispatch.fly.dev", intervalMin: 10, enabled: true };
  let running = false;
  let timer = null;

  async function cfg() {
    const c = await chrome.storage.local.get(DEFAULTS);
    return {
      apiBase: (c.apiBase || DEFAULTS.apiBase).replace(/\/+$/, ""),
      intervalMin: Math.max(1, Number(c.intervalMin) || DEFAULTS.intervalMin),
      enabled: c.enabled !== false,
    };
  }

  // Capture booked-pro phone numbers. The gig-groups list carries worker_id + name but NO phone; the
  // per-group timesheet view (GET /api/partner/shifts/timesheet-v2/shift-group/<id>) DOES expose
  // shifts[].worker_phone_number (confirmed live). For each BOOKED group we fetch that view same-origin
  // (the operator's session) and collect {worker_id, worker, worker_phone_number}, then POST them to the Zoe
  // contacts ingest. BEST-EFFORT: any failure here NEVER fails the main gig-groups pull. Returns a short
  // detail suffix (", N contact(s)") on success, else "".
  async function pullContacts(results, apiBase) {
    const groups = (results || []).filter((g) => g && g.id && Number(g.filled_shifts_count) > 0).slice(0, 60);
    if (!groups.length) return "";
    const contacts = [];
    for (const g of groups) {
      try {
        const r = await fetch(location.origin + "/api/partner/shifts/timesheet-v2/shift-group/" + encodeURIComponent(g.id), {
          credentials: "include",
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!r.ok) continue;
        const j = await r.json();
        const shifts = (j && j.shifts) || [];
        for (const s of shifts) {
          if (s && s.worker_phone_number) {
            contacts.push({ worker_id: s.worker_id, worker: s.worker, worker_phone_number: s.worker_phone_number });
          }
        }
      } catch (e) {
        /* skip this group; keep going */
      }
    }
    if (!contacts.length) return "";
    try {
      const imp = await fetch(apiBase + "/api/instawork/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contacts }),
      });
      return imp.ok ? ", " + contacts.length + " contact(s)" : "";
    } catch (e) {
      return "";
    }
  }

  async function cycle(reason) {
    if (running) return;
    running = true;
    try {
      const { apiBase, intervalMin, enabled } = await cfg();
      if (!enabled) return;

      // Cross-tab/timer throttle: if a pull succeeded very recently, don't duplicate it. A manual/handshake
      // "Pull now" (the worker's storage.pullNow nudge, or a direct message) always runs.
      if (reason !== "manual") {
        const { instaworkLastRun } = await chrome.storage.local.get("instaworkLastRun");
        if (instaworkLastRun && instaworkLastRun.status === "ok" && Date.now() - instaworkLastRun.at < intervalMin * 60000 * 0.5) return;
      }

      const url = location.origin + "/api/partner/gigs/groups/?timeframe=in_progress_upcoming&page=1&page_size=100";
      let status = "error";
      let detail = "";
      try {
        const res = await fetch(url, { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
        if (!res.ok) {
          // 401/403 = signed out; anything else non-OK is a transient block. Either way, record it so the
          // throttle doesn't suppress the next attempt (a failed run is NOT "ok"), and retry next tick.
          status = res.status === 401 || res.status === 403 ? "not_logged_in" : "error";
          detail = "http " + res.status;
        } else {
          const json = await res.json();
          const results = (json && json.results) || [];
          try {
            const imp = await fetch(apiBase + "/api/instawork/import", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ results }),
            });
            status = imp.ok ? "ok" : "error";
            detail = imp.ok ? results.length + " gig group(s)" : "import http " + imp.status;
            // After the gig-groups snapshot lands, capture booked-pro phone numbers (best-effort; never
            // flips the pull to error). Lets a shift debrief reach Instawork workers.
            if (imp.ok) {
              try {
                detail += await pullContacts(results, apiBase);
              } catch (e) {
                /* best-effort — contacts capture never fails the main pull */
              }
            }
          } catch (e) {
            status = "error";
            detail = "import error";
          }
        }
      } catch (e) {
        status = "error";
        detail = "fetch error";
      }
      await chrome.storage.local.set({ instaworkLastRun: { at: Date.now(), status, detail, reason } });
    } finally {
      running = false;
    }
  }

  // Self-timer: re-pull on our own cadence so an open tab stays fresh even if the service worker sleeps or
  // never re-nudges this background tab. Re-reads intervalMin so a config change takes effect next tick.
  async function startTimer() {
    const { intervalMin } = await cfg();
    if (timer) clearInterval(timer);
    timer = setInterval(() => cycle("timer"), intervalMin * 60000);
  }

  // Run shortly after the page settles (covers a tab the worker just opened, and normal navigation), then
  // keep pulling on the self-timer.
  setTimeout(() => cycle("load"), 4000);
  startTimer();

  // The worker nudges a pull by flipping storage.pullNow (reliable across tabs even when the SW slept). A
  // change to intervalMin re-arms the self-timer at the new period.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.pullNow) cycle("manual");
    if (changes.intervalMin) startTimer();
  });
  // Also honor a direct message if the worker/popup sends one.
  chrome.runtime.onMessage.addListener((m, _s, resp) => {
    if (m && m.type === "zoe-pull-now") { cycle("manual").then(() => resp && resp({ ok: true })); return true; }
    return false;
  });
})();

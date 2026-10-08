// Zoe Auto-Pull — service worker. As of v1.3.0 this worker OWNS scheduling and tab lifecycle so the
// operator never has to keep a Goodshuffle tab open:
//
//   • chrome.alarms (NOT setInterval — the SW sleeps) fires every `intervalMin`. On each alarm (and on
//     install/startup) it ensures a signed-in pro.goodshuffle.com tab EXISTS (a single pinned,
//     background tab it opens once and keeps alive), then nudges the DECLARED content script
//     (content.js + pull-injected.js) in that tab to run the read-pull. The content script still does
//     the actual same-origin fetches with the operator's GS cookies — that robust model is unchanged.
//   • Handshake: logging into Zoe Ops posts {type:"zoe-sync-now"} via externally_connectable; we ensure
//     the tab + pull immediately, and if GS is signed out we open a login tab (active) so the user can
//     sign in.
//   • create_project drain (default ON — toggle off in Options via createDrainEnabled): background-orchestrated. We
//     fetch the outbox (background fetch, no CORS gate), and for each create op open a background tab to
//     createNewProject; the declared create.js content script claims the op for that exact tab, runs the
//     populate sequence, and asks us to close the tab. One create tab at a time. A stuck tab is reaped
//     by a watchdog and the op is left pending — the read-pull is never disturbed.
//
// SW lifecycle: no long-lived in-memory state is relied upon across sleeps — everything needed
// (config, lastRun, pendingCreate) lives in chrome.storage.local; alarms, not timers, drive work.

const DEFAULTS = { apiBase: "https://zoe-dispatch.fly.dev", intervalMin: 10, enabled: true, createDrainEnabled: true };
const PULL_ALARM = "zoe-pull";
const CREATE_WATCHDOG = "zoe-create-watchdog";
const GS_MATCH = "https://pro.goodshuffle.com/*";
const GS_DASHBOARD = "https://pro.goodshuffle.com/app/dashboard";
const GS_CREATE = "https://pro.goodshuffle.com/app/project/createNewProject";
const GS_LOGIN = "https://pro.goodshuffle.com/app/login";
const IW_MATCH = "https://app.instawork.com/*";
const IW_HOME = "https://app.instawork.com/";
const IGN_MATCH = "https://ignition.zonarsystems.com/*";
const IGN_HOME = "https://ignition.zonarsystems.com/";
const GUSTO_MATCH = "https://app.gusto.com/*";
const GUSTO_HOME = "https://app.gusto.com/";
const CREATE_TIMEOUT_MS = 90_000; // reap an unclaimed/stuck create tab after this

// ── Badge ─────────────────────────────────────────────────────────────────────
async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {
    /* no-op */
  }
}
function badgeFor(status) {
  if (status === "ok") return setBadge("ok", "#15803d");
  if (status === "not_logged_in") return setBadge("!", "#b91c1c");
  if (status === "off") return setBadge("off", "#6b7280");
  return setBadge("!", "#b45309"); // no_tab / error / unknown
}

// ── Config ──────────────────────────────────────────────────────────────────────
async function cfg() {
  const c = await chrome.storage.local.get(DEFAULTS);
  return {
    apiBase: (c.apiBase || DEFAULTS.apiBase).replace(/\/+$/, ""),
    intervalMin: Math.max(1, Number(c.intervalMin) || DEFAULTS.intervalMin),
    enabled: c.enabled !== false,
    createDrainEnabled: c.createDrainEnabled !== false,
  };
}

async function seedDefaults() {
  const cur = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({
    apiBase: cur.apiBase || DEFAULTS.apiBase,
    intervalMin: cur.intervalMin || DEFAULTS.intervalMin,
    enabled: cur.enabled !== false,
    createDrainEnabled: cur.createDrainEnabled !== false,
  });
}

// ── Alarm scheduling (replaces the old content-script setInterval) ────────────────
async function ensureAlarm() {
  const { intervalMin } = await cfg();
  // chrome.alarms enforces a 0.5-min floor for unpacked; clamp to >= 1.
  const period = Math.max(1, intervalMin);
  const existing = await chrome.alarms.get(PULL_ALARM).catch(() => null);
  if (!existing || existing.periodInMinutes !== period) {
    await chrome.alarms.create(PULL_ALARM, { periodInMinutes: period, delayInMinutes: 0.1 });
  }
}

// ── GS tab lifecycle ──────────────────────────────────────────────────────────
/** Return a live pro.goodshuffle.com tab, creating a single pinned background one if none exists.
 *  We never close it — one tab kept alive avoids per-cycle flicker. `justOpened` says we created it
 *  (its content script will auto-run the pull on load, so we don't also need to nudge it). */
async function ensureGsTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: GS_MATCH });
  } catch (e) {
    tabs = [];
  }
  const live = tabs.find((t) => t.id != null);
  if (live) return { tab: live, justOpened: false };
  try {
    const tab = await chrome.tabs.create({ url: GS_DASHBOARD, pinned: true, active: false });
    return { tab, justOpened: true };
  } catch (e) {
    return { tab: null, justOpened: false };
  }
}

/** Return a live app.instawork.com tab, creating a single pinned background one if none exists. Same
 *  find-or-create logic as ensureGsTab: Instawork now pulls the same way (its declared content script,
 *  instawork.js, does the same-origin fetch + POST). We never close it. `justOpened` says we created it
 *  (its content script auto-runs on load, so we don't also need to nudge it). */
async function ensureInstaworkTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: IW_MATCH });
  } catch (e) {
    tabs = [];
  }
  const live = tabs.find((t) => t.id != null);
  if (live) return { tab: live, justOpened: false };
  try {
    const tab = await chrome.tabs.create({ url: IW_HOME, pinned: true, active: false });
    return { tab, justOpened: true };
  } catch (e) {
    return { tab: null, justOpened: false };
  }
}

/** Return a live ignition.zonarsystems.com tab, creating a single pinned background one if none exists.
 *  Same find-or-create logic as the GS/Instawork tabs: the Ignition content script (ignition.js) mints
 *  Zonar ETA links from this office-machine session, polling our server on its own short timer. We never
 *  close it. `justOpened` says we created it (its content script auto-runs on load). */
async function ensureIgnitionTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: IGN_MATCH });
  } catch (e) {
    tabs = [];
  }
  const live = tabs.find((t) => t.id != null);
  if (live) return { tab: live, justOpened: false };
  try {
    const tab = await chrome.tabs.create({ url: IGN_HOME, pinned: true, active: false });
    return { tab, justOpened: true };
  } catch (e) {
    return { tab: null, justOpened: false };
  }
}

/** Return a live app.gusto.com tab, creating a single pinned background one if none exists. Same
 *  find-or-create logic as the Instawork/Ignition tabs: the Gusto content script (gusto.js, world MAIN)
 *  replays the app's GraphQL reads + POSTs them, and self-refreshes on its own 10-min timer. We never
 *  close it. A freshly-opened background tab lands on the dashboard; gusto.js then navigates it to the
 *  People page (only when hidden) so the roster/pay queries actually fire. */
async function ensureGustoTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: GUSTO_MATCH });
  } catch (e) {
    tabs = [];
  }
  const live = tabs.find((t) => t.id != null);
  if (live) return { tab: live, justOpened: false };
  try {
    const tab = await chrome.tabs.create({ url: GUSTO_HOME, pinned: true, active: false });
    return { tab, justOpened: true };
  } catch (e) {
    return { tab: null, justOpened: false };
  }
}

/** Nudge the content script in existing GS tab(s) to run a pull now. The content script watches
 *  storage.pullNow and also accepts a direct message; storage is the reliable cross-tab trigger. The
 *  Instawork content script watches the SAME storage.pullNow, so this one nudge pulls both. */
async function triggerPull() {
  await chrome.storage.local.set({ pullNow: Date.now() });
}

/** Full cycle used by the alarm, install/startup, the popup, and the handshake: make sure a GS tab
 *  exists, then either let a freshly-opened tab auto-run or nudge an existing one; then (opt-in) drain
 *  creates. */
async function runPullCycle(reason) {
  const { enabled } = await cfg();
  if (!enabled) {
    badgeFor("off");
    return { ok: true, enabled: false };
  }
  const { tab, justOpened } = await ensureGsTab();
  // Keep a signed-in Instawork tab alive too, so one alarm cycle pulls both. Instawork's own content
  // script does the fetch + POST; a freshly-opened tab auto-runs on load, an existing one gets the same
  // storage.pullNow nudge below. Best-effort — never let it block or break the GS read-pull.
  const iw = await ensureInstaworkTab().catch(() => ({ justOpened: false }));
  // Keep a signed-in Ignition tab alive too, so Zonar ETA links can be minted from this office machine.
  // Its content script polls our server on its own short timer; the shared pullNow nudge also pokes it.
  const ign = await ensureIgnitionTab().catch(() => ({ justOpened: false }));
  // Keep a signed-in Gusto tab alive too, so HR/Payroll pulls the roster + pay rates on the same 10-min
  // cadence. gusto.js (world MAIN) can't read chrome.storage, so it isn't nudged via pullNow — it self-
  // refreshes on its own 10-min timer in whatever Gusto tab stays open. Best-effort.
  await ensureGustoTab().catch(() => ({ justOpened: false }));
  if (!tab) {
    badgeFor("no_tab");
    return { ok: false, reason: "no_tab" };
  }
  // A newly created tab's content script auto-runs on load; an existing one needs a nudge. One
  // storage.pullNow nudges ALL content scripts, so fire it if any tab was already open.
  if (!justOpened || !iw.justOpened || !ign.justOpened) await triggerPull();
  // Best-effort, opt-in create drain (never blocks or breaks the read-pull).
  drainCreates(reason).catch(() => {});
  return { ok: true, tabId: tab.id, justOpened };
}

// ── create_project drain (OPT-IN, default OFF) ────────────────────────────────────
// Background-orchestrated, one create tab at a time. State in storage.pendingCreate so it survives a
// SW sleep between opening the tab and the content script's claim/report.
async function getPending() {
  const { pendingCreate } = await chrome.storage.local.get("pendingCreate");
  return pendingCreate || null;
}
async function setPending(p) {
  if (p) await chrome.storage.local.set({ pendingCreate: p });
  else await chrome.storage.local.remove("pendingCreate");
}

async function drainCreates(reason) {
  const { apiBase, enabled, createDrainEnabled } = await cfg();
  if (!enabled || !createDrainEnabled) return;

  // Concurrency cap: one create in flight. If one is pending, let the watchdog/claim finish it.
  const pending = await getPending();
  if (pending) {
    if (Date.now() - pending.startedAt > CREATE_TIMEOUT_MS) await reapPending(pending, "stale");
    return;
  }

  let ops = [];
  try {
    const r = await fetch(apiBase + "/api/gs/outbox", { headers: { accept: "application/json" } });
    const j = await r.json();
    ops = ((j && j.ops) || []).filter((o) => o && o.op === "create_project" && o.payload && o.payload.intakeId);
  } catch (e) {
    return; // outbox unreachable — try again next cycle
  }
  if (!ops.length) return;

  const op = { id: ops[0].id, payload: ops[0].payload };
  let tab;
  try {
    tab = await chrome.tabs.create({ url: GS_CREATE, active: false });
  } catch (e) {
    return;
  }
  await setPending({ tabId: tab.id, op, startedAt: Date.now(), claimed: false });
  // Watchdog to reap a tab that never claims/finishes (e.g. GS signed out → redirect to auth, where
  // create.js doesn't run). Leaves the op pending for a later cycle.
  chrome.alarms.create(CREATE_WATCHDOG, { delayInMinutes: CREATE_TIMEOUT_MS / 60000 });
}

async function reapPending(pending, why) {
  try {
    if (pending && pending.tabId != null) await chrome.tabs.remove(pending.tabId);
  } catch (e) {
    /* tab already gone */
  }
  await setPending(null);
  try {
    await chrome.alarms.clear(CREATE_WATCHDOG);
  } catch (e) {
    /* no-op */
  }
}

// ── Login probe (for the handshake) ───────────────────────────────────────────────
// Decide whether GS looks signed out. We prefer the content script's own probe (lastRun.status), which
// is authoritative (it hit searchProjects). If we have no recent signal, we treat it as unknown and do
// NOT pop a login tab (avoid nagging); the pull itself will report not_logged_in and the app banner
// covers it.
async function lastRunStatus() {
  const { lastRun } = await chrome.storage.local.get("lastRun");
  if (!lastRun || !lastRun.at) return { status: "unknown", ageMs: Infinity };
  return { status: lastRun.status || "unknown", ageMs: Date.now() - lastRun.at };
}

async function openLoginTab() {
  try {
    await chrome.tabs.create({ url: GS_LOGIN, active: true });
  } catch (e) {
    /* no-op */
  }
}

// ── Live subtotal (on-demand, for the Delivery Pricing calculator) ──────────────────
// The Zoe app page asks (externally_connectable) for a project's CURRENT pre-discount subtotal. We run a
// same-origin fetch IN the signed-in GS tab via chrome.scripting.executeScript (the tab carries the
// operator's GS cookies) and return the live value. Reads the SAME field the pull captures —
// searchProjects results' `contract_subtotal` (CENTS) — and returns it in DOLLARS so it matches the
// calculator's expectation. Never server-side (GS is Cloudflare-blocked there).

/** Resolve once the given tab reports status "complete", or after timeoutMs. */
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (e) { /* no-op */ }
      resolve(v);
    };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(true); };
    try { chrome.tabs.onUpdated.addListener(listener); } catch (e) { finish(false); return; }
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === "complete") finish(true); }).catch(() => {});
    setTimeout(() => finish(false), timeoutMs);
  });
}

/** Injected INTO the GS tab (runs in its page origin). Pages searchProjects (newest-logistics first, all
 *  statuses incl. archived) with early-exit on the matching project id, and returns its pre-discount
 *  contract_subtotal in dollars. Fully self-contained — executeScript serializes this function. */
async function gsReadSubtotal(projectId) {
  const H = { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include" };
  const AUTH_RE = /\/(ui\/auth|app\/login|login|signin|auth)\b/i;
  const target = String(projectId);
  try {
    for (let pg = 0; pg < 12; pg++) {
      const r = await fetch(
        "/app/project/searchProjects?page=" + pg + "&pageSize=500&allProjects=true&sortColumn=logistics_start_date&sortDirection=desc&useV2DateHandling=true",
        H,
      );
      if (r.redirected && AUTH_RE.test(r.url)) return { ok: false, reason: "signed_out" };
      if (!r.ok) return { ok: false, reason: "http_" + r.status };
      const b = await r.json();
      const ps = b && b.projectSearch;
      if (!ps) return { ok: false, reason: "no_search" };
      const results = ps.results || [];
      const hit = results.find((p) => p && String(p.id) === target);
      if (hit) {
        const cents = hit.contract_subtotal;
        if (cents == null || isNaN(Number(cents))) return { ok: false, reason: "no_subtotal" };
        return { ok: true, subtotal: Math.round(Number(cents)) / 100, pulledAt: new Date().toISOString() };
      }
      if (results.length < 500) break; // last page reached without a match
    }
    return { ok: false, reason: "not_found" };
  } catch (e) {
    return { ok: false, reason: "fetch_error" };
  }
}

async function fetchLiveSubtotal(projectId) {
  const pid = String(projectId || "").trim();
  if (!pid) return { ok: false, reason: "no_project" };
  const { tab, justOpened } = await ensureGsTab();
  if (!tab || tab.id == null) return { ok: false, reason: "no_tab" };
  if (justOpened) {
    const ready = await waitForTabComplete(tab.id, 6000);
    if (!ready) return { ok: false, reason: "tab_loading" };
  }
  try {
    const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: gsReadSubtotal, args: [pid] });
    const res = out && out[0] && out[0].result;
    return res || { ok: false, reason: "no_result" };
  } catch (e) {
    return { ok: false, reason: "inject_failed" };
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────────────
async function boot() {
  await seedDefaults();
  await ensureAlarm();
  await runPullCycle("startup");
}
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PULL_ALARM) {
    runPullCycle("alarm").catch(() => {});
  } else if (alarm.name === CREATE_WATCHDOG) {
    getPending().then((p) => {
      if (p && Date.now() - p.startedAt > CREATE_TIMEOUT_MS - 1000) reapPending(p, "watchdog");
    });
  }
});

// Reconfigure the alarm when the interval changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.intervalMin) ensureAlarm().catch(() => {});
});

// Internal messages (popup + content scripts).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  // From the content script every cycle → toolbar badge.
  if (msg.type === "zoe-badge") {
    badgeFor(msg.status);
    sendResponse({ ok: true });
    return true;
  }

  // From the popup → ensure a GS tab exists and pull now.
  if (msg.type === "zoe-pull-now") {
    runPullCycle("manual").then((r) => sendResponse(r || { ok: true }));
    return true;
  }

  // From the popup → last run to display.
  if (msg.type === "zoe-status") {
    chrome.storage.local.get(["lastRun"]).then((s) => sendResponse(s.lastRun || null));
    return true;
  }

  // Options saved (interval/apiBase/enabled/createDrainEnabled). Realign the alarm; content script reads
  // storage live for the rest.
  if (msg.type === "zoe-config-changed") {
    ensureAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }

  // create.js on a detail page → "am I a create tab? which op?" Return the op only for the exact tab we
  // opened, and only once (claim atomically to avoid double-processing).
  if (msg.type === "zoe-create-claim") {
    (async () => {
      const p = await getPending();
      if (p && sender.tab && sender.tab.id === p.tabId && !p.claimed) {
        p.claimed = true;
        await setPending(p);
        sendResponse({ op: p.op });
      } else {
        sendResponse({ op: null });
      }
    })();
    return true;
  }

  // create.js finished (ok or not) → close its tab, clear pending, then try the next create op.
  if (msg.type === "zoe-create-done") {
    (async () => {
      const p = await getPending();
      await reapPending(p, msg.ok ? "done" : "failed");
      sendResponse({ ok: true });
      // Chain to the next pending create op (still one-at-a-time).
      drainCreates("chain").catch(() => {});
    })();
    return true;
  }

  return false;
});

// External messages from Zoe Ops (externally_connectable zoe-dispatch.fly.dev):
//   • {type:"zoe-sync-now"}        — handshake: ensure the GS tab + pull immediately; if GS looks signed
//                                    out, open a login tab. Reply with the last known status.
//   • {type:"zoe-fetch-subtotal", projectId} — on-demand: read the project's CURRENT pre-discount subtotal
//                                    live from the signed-in GS tab. Reply {ok, subtotal, pulledAt} | {ok:false, reason}.
chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: "unknown_message" });
    return true;
  }

  if (msg.type === "zoe-fetch-subtotal") {
    (async () => {
      const r = await fetchLiveSubtotal(msg.projectId).catch(() => ({ ok: false, reason: "error" }));
      sendResponse(r);
    })();
    return true; // keep the channel open for the async fetch
  }

  if (msg.type === "zoe-sync-now") {
    (async () => {
      const r = await runPullCycle("handshake");
      const ls = await lastRunStatus();
      // Only nudge a login when we have a RECENT, authoritative signed-out reading — never on unknown.
      if (ls.status === "not_logged_in" && ls.ageMs < 60 * 60 * 1000) await openLoginTab();
      sendResponse({ ok: true, pull: r, last: ls });
    })();
    return true;
  }

  sendResponse({ ok: false, error: "unknown_message" });
  return true;
});

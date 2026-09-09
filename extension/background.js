// Zoe Auto-Pull — service worker. On a timer (chrome.alarms), it finds a logged-in
// pro.goodshuffle.com tab and injects the pull (pull-injected.js) into it. The pull runs in the
// page's origin, so it uses the operator's Goodshuffle cookies and posts results to Zoe. The worker
// then reports a heartbeat to Zoe (so Dispatch can banner when the pull stops or GSPRO is signed
// out) and reflects status on the toolbar badge.
//
// This is the office-machine automation of the proven "Pull Zoe Routes" bookmarklet — no per-session
// click. It needs a GSPRO tab open in this browser; if none is open (or it's signed out), it reports
// that instead of pulling.

import { zoePull } from "./pull-injected.js";

const DEFAULTS = { apiBase: "https://zoe-dispatch.fly.dev", intervalMin: 10, enabled: true };
const ALARM = "zoe-pull";
const GS_MATCH = "https://pro.goodshuffle.com/*";

async function config() {
  const c = await chrome.storage.local.get(DEFAULTS);
  return { apiBase: (c.apiBase || DEFAULTS.apiBase).replace(/\/+$/, ""), intervalMin: Math.max(1, Number(c.intervalMin) || DEFAULTS.intervalMin), enabled: c.enabled !== false };
}

async function scheduleAlarm() {
  const { intervalMin } = await config();
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { periodInMinutes: intervalMin, delayInMinutes: 0.1 });
}

async function setBadge(text, color) {
  try { await chrome.action.setBadgeText({ text }); await chrome.action.setBadgeBackgroundColor({ color }); } catch (e) { /* no-op */ }
}

async function heartbeat(apiBase, status, detail) {
  try {
    await fetch(apiBase + "/api/pull/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "extension", status, detail: detail ?? null, at: new Date().toISOString() }),
    });
  } catch (e) { /* best-effort — the pull already ran; heartbeat is just for the banner */ }
}

async function findGsproTab() {
  const tabs = await chrome.tabs.query({ url: GS_MATCH });
  // Prefer a fully-loaded tab.
  return tabs.find((t) => t.status === "complete") || tabs[0] || null;
}

let running = false;
async function runPull(reason) {
  if (running) return;
  running = true;
  const { apiBase, enabled } = await config();
  try {
    if (!enabled) { await setBadge("off", "#6b7280"); return; }
    const tab = await findGsproTab();
    if (!tab || !tab.id) {
      await setBadge("!", "#b45309");
      await heartbeat(apiBase, "no_tab", "No pro.goodshuffle.com tab open in this browser");
      await chrome.storage.local.set({ lastRun: { at: Date.now(), status: "no_tab", reason } });
      return;
    }
    await setBadge("…", "#334155");
    let result;
    try {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: zoePull, args: [apiBase] });
      result = inj && inj.result;
    } catch (e) {
      result = { ok: false, loggedIn: true, error: "inject failed: " + String(e).slice(0, 100) };
    }
    if (!result) result = { ok: false, loggedIn: true, error: "no result" };

    if (result.loggedIn === false) {
      await setBadge("!", "#b91c1c");
      await heartbeat(apiBase, "not_logged_in", "Goodshuffle session signed out");
    } else if (result.ok) {
      await setBadge("ok", "#15803d");
      await heartbeat(apiBase, "ok", `${result.stops || 0} stops · ${result.bookings || 0} bookings`);
    } else {
      await setBadge("!", "#b45309");
      await heartbeat(apiBase, "error", result.error || "pull error");
    }
    await chrome.storage.local.set({ lastRun: { at: Date.now(), status: result.loggedIn === false ? "not_logged_in" : result.ok ? "ok" : "error", result, reason } });
  } finally {
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(async () => { await chrome.storage.local.set(await mergeDefaults()); await scheduleAlarm(); runPull("installed"); });
chrome.runtime.onStartup.addListener(async () => { await scheduleAlarm(); runPull("startup"); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) runPull("alarm"); });

// Options page saves → reschedule + immediate run so changes take effect at once.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "zoe-config-changed") { scheduleAlarm().then(() => runPull("config")); sendResponse({ ok: true }); return true; }
  if (msg && msg.type === "zoe-pull-now") { runPull("manual").then(() => sendResponse({ ok: true })); return true; }
  if (msg && msg.type === "zoe-status") { chrome.storage.local.get(["lastRun"]).then((s) => sendResponse(s.lastRun || null)); return true; }
  return false;
});

async function mergeDefaults() {
  const cur = await chrome.storage.local.get(DEFAULTS);
  return { apiBase: cur.apiBase || DEFAULTS.apiBase, intervalMin: cur.intervalMin || DEFAULTS.intervalMin, enabled: cur.enabled !== false };
}

// Cold-start (worker woke): make sure the alarm exists.
scheduleAlarm();

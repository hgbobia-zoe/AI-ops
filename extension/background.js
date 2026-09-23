// Zoe Auto-Pull — service worker (badge + popup bridge only). The pull itself now runs as a DECLARED
// content script on pro.goodshuffle.com (content.js + pull-injected.js), which loads with host access
// granted at install — so there is no background injection for Chrome's per-site permission model to
// revoke. This worker just: seeds defaults, reflects the content script's status on the toolbar badge,
// and bridges the popup's "Pull now" / "status" to the content script via chrome.storage.
//
// (Opportunity Radar capture stays in the popup and is unaffected.)

const DEFAULTS = { apiBase: "https://zoe-dispatch.fly.dev", intervalMin: 10, enabled: true };

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

async function seedDefaults() {
  const cur = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({
    apiBase: cur.apiBase || DEFAULTS.apiBase,
    intervalMin: cur.intervalMin || DEFAULTS.intervalMin,
    enabled: cur.enabled !== false,
  });
}

chrome.runtime.onInstalled.addListener(seedDefaults);
chrome.runtime.onStartup.addListener(seedDefaults);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  // From the content script every cycle → reflect on the toolbar badge.
  if (msg.type === "zoe-badge") { badgeFor(msg.status); sendResponse({ ok: true }); return true; }

  // From the popup → trigger an immediate pull in any open GSPRO tab (its content script watches this).
  if (msg.type === "zoe-pull-now") { chrome.storage.local.set({ pullNow: Date.now() }).then(() => sendResponse({ ok: true })); return true; }

  // From the popup → the last run it should display.
  if (msg.type === "zoe-status") { chrome.storage.local.get(["lastRun"]).then((s) => sendResponse(s.lastRun || null)); return true; }

  // Options page saved (interval/apiBase/enabled). The content script reads storage live; nothing to do.
  if (msg.type === "zoe-config-changed") { sendResponse({ ok: true }); return true; }

  return false;
});

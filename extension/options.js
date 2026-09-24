const DEFAULTS = { apiBase: "https://zoe-dispatch.fly.dev", intervalMin: 10, enabled: true, createDrainEnabled: false, radarToken: "" };

async function load() {
  const c = await chrome.storage.local.get(DEFAULTS);
  document.getElementById("apiBase").value = c.apiBase || DEFAULTS.apiBase;
  document.getElementById("intervalMin").value = c.intervalMin || DEFAULTS.intervalMin;
  document.getElementById("enabled").checked = c.enabled !== false;
  document.getElementById("createDrainEnabled").checked = c.createDrainEnabled === true;
  document.getElementById("radarToken").value = c.radarToken || "";
}

document.getElementById("save").addEventListener("click", async () => {
  const apiBase = (document.getElementById("apiBase").value || DEFAULTS.apiBase).trim().replace(/\/+$/, "");
  const intervalMin = Math.max(1, Math.min(120, Number(document.getElementById("intervalMin").value) || DEFAULTS.intervalMin));
  const enabled = document.getElementById("enabled").checked;
  const createDrainEnabled = document.getElementById("createDrainEnabled").checked;
  const radarToken = (document.getElementById("radarToken").value || "").trim();
  await chrome.storage.local.set({ apiBase, intervalMin, enabled, createDrainEnabled, radarToken });
  try { await chrome.runtime.sendMessage({ type: "zoe-config-changed" }); } catch (e) { /* worker will pick it up on next alarm */ }
  const saved = document.getElementById("saved");
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 1800);
});

load();

// Popup: Goodshuffle auto-pull status + on-demand Opportunity Radar capture.

const COLORS = { ok: "#22c55e", no_tab: "#f59e0b", not_logged_in: "#ef4444", error: "#f59e0b", unknown: "#6b7280" };
const LABELS = {
  ok: "Pulling on schedule",
  no_tab: "No Goodshuffle tab open",
  not_logged_in: "Signed out of Goodshuffle",
  error: "Last pull had an issue",
  unknown: "Not run yet",
};
const DEFAULTS = { apiBase: "https://zoe-dispatch.fly.dev", radarToken: "" };

function fmtAgo(ts) {
  if (!ts) return "";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  return Math.round(m / 60) + "h ago";
}

// ── Goodshuffle status ──────────────────────────────────────────────────────────
async function refresh() {
  let last = null;
  try { last = await chrome.runtime.sendMessage({ type: "zoe-status" }); } catch (e) { /* worker asleep */ }
  const status = (last && last.status) || "unknown";
  document.getElementById("dot").style.background = COLORS[status] || COLORS.unknown;
  document.getElementById("label").textContent = LABELS[status] || LABELS.unknown;
  const r = last && last.result;
  const bits = [];
  if (last && last.at) bits.push("Last run " + fmtAgo(last.at));
  if (r && status === "ok") bits.push(`${r.stops || 0} stops · ${r.bookings || 0} bookings`);
  if (status === "no_tab") bits.push("Open pro.goodshuffle.com in this browser");
  if (status === "not_logged_in") bits.push("Sign in to Goodshuffle to resume");
  if (r && r.error && status === "error") bits.push(r.error);
  document.getElementById("meta").textContent = bits.join(" · ");
}

document.getElementById("pull").addEventListener("click", async () => {
  document.getElementById("label").textContent = "Pulling…";
  try { await chrome.runtime.sendMessage({ type: "zoe-pull-now" }); } catch (e) { /* no-op */ }
  setTimeout(refresh, 1500);
});
document.getElementById("opts").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ── Opportunity Radar capture ─────────────────────────────────────────────────────
// Injected into the active tab. Self-contained (cannot reference popup scope). Heuristically pulls
// solicitation rows out of tables on a portal listing page.
function pageScrape() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const abs = (href) => { try { return new URL(href, location.href).href; } catch (e) { return null; } };
  const ymd = (t) => { if (!t) return undefined; const d = new Date(t.replace(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/, "$1/$2/$3")); return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10); };
  const HEAD = {
    name: /(title|description|solicitation\s*(name|title)?|project|opportunity|name|summary|subject)/i,
    deadline: /(due|clos(e|ing)|deadline|response|end\s*date|submission|bid\s*date)/i,
    id: /(number|no\.?|\bid\b|solicitation\s*#|bid\s*#|reference|ref)/i,
    agency: /(agency|department|dept|owner|buyer|organization|entity)/i,
    status: /(status|stage|state)/i,
  };
  const records = [];
  const seen = new Set();
  for (const table of Array.from(document.querySelectorAll("table"))) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length < 2) continue;
    let headerCells = null, headerIdx = 0;
    for (let i = 0; i < Math.min(rows.length, 3); i++) {
      const ths = rows[i].querySelectorAll("th");
      if (ths.length > 1) { headerCells = Array.from(ths).map((c) => clean(c.textContent)); headerIdx = i; break; }
    }
    if (!headerCells) { const cells = rows[0].querySelectorAll("td,th"); if (cells.length > 1) { headerCells = Array.from(cells).map((c) => clean(c.textContent)); headerIdx = 0; } }
    if (!headerCells) continue;
    const col = {};
    headerCells.forEach((h, idx) => { for (const k in HEAD) { if (col[k] == null && HEAD[k].test(h)) col[k] = idx; } });
    if (col.name == null) continue;
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const cells = Array.from(rows[i].querySelectorAll("td"));
      if (cells.length === 0) continue;
      const get = (k) => (col[k] != null && cells[col[k]] ? clean(cells[col[k]].textContent) : "");
      const name = get("name");
      if (!name || name.length < 4) continue;
      const a = rows[i].querySelector("a[href]");
      const key = (name + "|" + get("id")).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({
        name,
        agency: get("agency") || undefined,
        deadline: ymd(get("deadline")),
        status: get("status") || undefined,
        solicitationNumber: get("id") || undefined,
        sourceUrl: (a && abs(a.getAttribute("href"))) || location.href,
      });
    }
  }
  return { url: location.href, title: document.title, records };
}

let captured = [];
const radarMeta = document.getElementById("radarMeta");
const sendBtn = document.getElementById("send");

function setSendLabel() { sendBtn.textContent = `Send ${captured.length} to Radar`; sendBtn.disabled = captured.length === 0; }

document.getElementById("capture").addEventListener("click", async () => {
  radarMeta.textContent = "Reading this page…";
  captured = [];
  setSendLabel();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) { radarMeta.textContent = "No active tab."; return; }
    const [inj] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageScrape });
    const out = inj && inj.result;
    captured = (out && out.records) || [];
    setSendLabel();
    radarMeta.className = "radar-meta";
    radarMeta.textContent = captured.length
      ? `Found ${captured.length} rows. Review the portal, then send.`
      : "No table rows found. Make sure you're on the solicitation list (not a detail page).";
  } catch (e) {
    radarMeta.className = "radar-meta warn";
    radarMeta.textContent = "Could not read this page: " + String(e).slice(0, 80);
  }
});

sendBtn.addEventListener("click", async () => {
  if (captured.length === 0) return;
  const sourceId = document.getElementById("source").value;
  const cfg = await chrome.storage.local.get(DEFAULTS);
  const apiBase = (cfg.apiBase || DEFAULTS.apiBase).replace(/\/+$/, "");
  sendBtn.disabled = true;
  radarMeta.className = "radar-meta";
  radarMeta.textContent = `Sending ${captured.length}…`;
  try {
    const res = await fetch(apiBase + "/api/radar/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.radarToken ? { "x-radar-token": cfg.radarToken } : {}) },
      body: JSON.stringify({ sourceId, records: captured, capturedAt: new Date().toISOString() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    radarMeta.className = "radar-meta ok";
    radarMeta.textContent = `Sent. Stored ${data.stored ?? 0}${data.changes ? `, ${data.changes} change(s)` : ""}.`;
    captured = [];
    setSendLabel();
  } catch (e) {
    radarMeta.className = "radar-meta warn";
    radarMeta.textContent = "Send failed: " + String(e.message || e).slice(0, 90);
    sendBtn.disabled = false;
  }
});

refresh();
setSendLabel();

const COLORS = { ok: "#22c55e", no_tab: "#f59e0b", not_logged_in: "#ef4444", error: "#f59e0b", unknown: "#6b7280" };
const LABELS = {
  ok: "Pulling on schedule",
  no_tab: "No Goodshuffle tab open",
  not_logged_in: "Signed out of Goodshuffle",
  error: "Last pull had an issue",
  unknown: "Not run yet",
};

function fmtAgo(ts) {
  if (!ts) return "";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  return Math.round(m / 60) + "h ago";
}

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

refresh();

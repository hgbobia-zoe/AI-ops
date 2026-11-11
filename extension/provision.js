// Account setup in the ONBOARDER's own Chrome (loaded by background.js with importScripts).
//
// The Zoe People page sends {type:"zoe-provision", jobs:[...]} (src/lib/people/chromeJobs.ts). For each job we
// open the site in a VISIBLE tab, wait for the person to be signed in (they can sign in right there), run the
// recorded steps for that site (docs/provisioning-captures.md), stop for their OK on paid seats or broad
// roles, and post the outcome to Zoe with the job's one-time key. Nothing here stores a password or a site
// token: each step uses the session already signed in on that tab.
//
// The page runners are injected with chrome.scripting.executeScript, which serializes each function, so every
// runner below is SELF-CONTAINED (its own helpers, no outer variables).

const PROVISION_LOCK_KEY = "zoeProvisionRun";
const PROVISION_STALE_MS = 45 * 60 * 1000;
const SIGN_IN_WAIT_MS = 10 * 60 * 1000;
const APPROVAL_WAIT_MS = 15 * 60 * 1000;

// Where a signed-in session lands for each site (a login page does not match).
const SIGNED_IN = {
  slack: /^https:\/\/app\.slack\.com\/client\//,
  quo: /^https:\/\/my\.quo\.com\/(?!login|signup)/,
  squarespace_email: /^https:\/\/[a-z0-9-]+\.squarespace\.com\/config\//,
  weddingpro: /^https:\/\/www\.weddingpro\.com\/(?!login)/,
  yelp: /^https:\/\/biz\.yelp\.com\/(?!login)/,
  goodshuffle: /^https:\/\/pro\.goodshuffle\.com\/(?!app\/login)(app|ui)\//,
  whimsical: /^https:\/\/whimsical\.com\/(?!login|signup|pricing)[a-z0-9-]+/,
};

// Jobs for a hire who has not started yet wait here and run on day one (job.runAt), even if Chrome was
// closed in between: the alarm fires when Chrome next starts.
const SCHEDULE_KEY = "zoeProvisionScheduled";
const SCHEDULE_ALARM = "zoe-provision-scheduled";

async function provisionLock() {
  const { [PROVISION_LOCK_KEY]: v } = await chrome.storage.local.get(PROVISION_LOCK_KEY);
  return v || null;
}

async function scheduledJobs() {
  const { [SCHEDULE_KEY]: v } = await chrome.storage.local.get(SCHEDULE_KEY);
  return Array.isArray(v) ? v : [];
}

async function armScheduleAlarm(list) {
  try { await chrome.alarms.clear(SCHEDULE_ALARM); } catch (e) { /* none */ }
  if (!list.length) return;
  const next = Math.min(...list.map((j) => j.runAt));
  chrome.alarms.create(SCHEDULE_ALARM, { when: Math.max(Date.now() + 5000, next) });
}

/** Hold jobs until their day-one time (a newer job for the same step replaces the old one). */
async function scheduleProvision(jobs) {
  const ids = new Set(jobs.map((j) => j.taskId));
  const list = (await scheduledJobs()).filter((j) => !ids.has(j.taskId)).concat(jobs);
  await chrome.storage.local.set({ [SCHEDULE_KEY]: list });
  await armScheduleAlarm(list);
}

/** Run whatever is due now; keep the rest waiting. */
async function runDueProvision() {
  const list = await scheduledJobs();
  if (!list.length) return;
  const due = list.filter((j) => j.runAt <= Date.now() + 30000).sort((a, b) => (a.order || 0) - (b.order || 0));
  const rest = list.filter((j) => j.runAt > Date.now() + 30000);
  if (!due.length) return armScheduleAlarm(rest);
  const cur = await provisionLock();
  if (cur && Date.now() - cur.startedAt < PROVISION_STALE_MS) {
    chrome.alarms.create(SCHEDULE_ALARM, { when: Date.now() + 2 * 60000 });
    return;
  }
  await chrome.storage.local.set({ [SCHEDULE_KEY]: rest });
  await armScheduleAlarm(rest);
  await startProvisionRun(due.map((j) => Object.assign({}, j, { runAt: null })));
}

chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === SCHEDULE_ALARM) runDueProvision().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { runDueProvision().catch(() => {}); });

/** Start a run (returns at once; the jobs run one after another in visible tabs). One run at a time.
 *  Jobs with a future runAt are held and run on day one instead. */
async function startProvisionRun(jobs) {
  const all = Array.isArray(jobs) ? jobs.filter((j) => j && j.taskId && j.token && j.system && j.resultUrl && j.data) : [];
  if (!all.length) return { ok: false, reason: "no_jobs" };
  const later = all.filter((j) => j.runAt && j.runAt > Date.now() + 30000).map((j, i) => Object.assign({}, j, { order: i }));
  const list = all.filter((j) => !(j.runAt && j.runAt > Date.now() + 30000));
  if (later.length) await scheduleProvision(later);
  if (!list.length) return { ok: true, started: 0, scheduled: later.length };
  const cur = await provisionLock();
  if (cur && Date.now() - cur.startedAt < PROVISION_STALE_MS) return { ok: true, already: true };
  await chrome.storage.local.set({ [PROVISION_LOCK_KEY]: { startedAt: Date.now(), count: list.length } });
  (async () => {
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    try {
      for (const job of list) {
        await runProvisionJob(job).catch((e) => reportProvision(job, "failed", "Extension error: " + String(e && e.message || e).slice(0, 160)));
      }
    } finally {
      clearInterval(keepAlive);
      await chrome.storage.local.remove(PROVISION_LOCK_KEY);
    }
  })();
  return { ok: true, started: list.length, scheduled: later.length };
}

async function reportProvision(job, outcome, detail, createdEmail) {
  try {
    await fetch(job.resultUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: job.taskId, token: job.token, outcome, detail: detail || "", createdEmail: createdEmail || undefined }),
    });
  } catch (e) {
    /* Zoe unreachable: the step stays "waiting for Chrome" and can be run again */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tabUrl(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return { url: t.url || t.pendingUrl || "", status: t.status, alive: true };
  } catch (e) {
    return { url: "", status: "gone", alive: false };
  }
}

async function waitLoaded(tabId, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const t = await tabUrl(tabId);
    if (!t.alive) return false;
    if (t.status === "complete") return true;
    await sleep(400);
  }
  return true;
}

async function inPage(tabId, func, args, world) {
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId }, world: world || "MAIN", func, args: args || [] });
    return res && res[0] ? res[0].result : undefined;
  } catch (e) {
    return { outcome: "failed", detail: "Could not run in the page: " + String(e && e.message || e).slice(0, 140) };
  }
}

/** Wait until the tab is signed in to the site (they can sign in right there), then make sure it is on the
 *  start page. Returns false if the tab closed or nobody signed in within the wait. */
async function ensureSignedIn(tabId, job) {
  const re = SIGNED_IN[job.system];
  const until = Date.now() + SIGN_IN_WAIT_MS;
  let nudged = false;
  while (Date.now() < until) {
    const t = await tabUrl(tabId);
    if (!t.alive) return false;
    if (t.status === "complete" && re && re.test(t.url)) {
      if (!t.url.startsWith(job.data.startUrl)) {
        await chrome.tabs.update(tabId, { url: job.data.startUrl });
        await sleep(800);
        await waitLoaded(tabId, 30000);
      }
      return true;
    }
    if (t.status === "complete" && !nudged) {
      nudged = true;
      await inPage(tabId, zoeBanner, ["Zoe: sign in to " + job.systemName + " here. Setting up " + job.employeeName + " continues by itself.", "info"], "ISOLATED");
    }
    if (t.status === "complete" && nudged && Math.random() < 0.2) {
      await inPage(tabId, zoeBanner, ["Zoe: sign in to " + job.systemName + " here. Setting up " + job.employeeName + " continues by itself.", "info"], "ISOLATED");
    }
    await sleep(2500);
  }
  return false;
}

const RUNNERS = {
  whimsical: zoeRunWhimsical,
  goodshuffle: zoeRunGoodshuffle,
  slack: zoeRunSlack,
  squarespace_email: zoeRunSquarespace,
  yelp: zoeRunYelp,
  quo: zoeRunQuo,
  weddingpro: zoeRunWeddingPro,
};

async function runProvisionJob(job) {
  const runner = RUNNERS[job.system];
  if (!runner) return reportProvision(job, "failed", "This extension version cannot set up " + job.systemName + ". Update Auto-Pull.");
  const tab = await chrome.tabs.create({ url: job.data.startUrl, active: true });
  await sleep(600);
  await waitLoaded(tab.id, 45000);
  if (!(await ensureSignedIn(tab.id, job))) {
    return reportProvision(job, "failed", "Not signed in to " + job.systemName + " within 10 minutes (or the tab was closed).");
  }
  await sleep(2500); // let the site's app finish booting

  let r = await inPage(tab.id, runner, [job.data, "prepare", null]);
  // Yelp asks for the password again before user management: send them to that page, wait, try again.
  if (r && r.needLogin) {
    await chrome.tabs.update(tab.id, { url: r.needLogin });
    await sleep(800);
    await waitLoaded(tab.id, 30000);
    await inPage(tab.id, zoeBanner, [job.systemName + " wants your password again. Enter it here; setup continues by itself.", "info"], "ISOLATED");
    const until = Date.now() + SIGN_IN_WAIT_MS;
    let ok = false;
    while (Date.now() < until) {
      const t = await tabUrl(tab.id);
      if (!t.alive) break;
      if (t.status === "complete" && t.url.startsWith(job.data.startUrl)) { ok = true; break; }
      await sleep(2500);
    }
    if (!ok) return reportProvision(job, "failed", job.systemName + " password check was not finished.");
    await sleep(2500);
    r = await inPage(tab.id, runner, [job.data, "prepare", null]);
  }
  if (!r) r = { outcome: "failed", detail: "No answer from the page." };

  if (r.approval) {
    // Approved in Zoe ahead of a day-one run: no one may be at this Chrome, so do not ask again.
    const choice = job.preApproved ? "approve" : await inPage(tab.id, zoeAskApproval, [r.approval.title, r.approval.lines || [], APPROVAL_WAIT_MS], "ISOLATED");
    if (choice !== "approve") {
      if (r.cancelable) await inPage(tab.id, runner, [job.data, "cancel", r.ctx || null]);
      await reportProvision(job, "declined", choice === "timeout" ? "No answer in Chrome." : "Not approved in Chrome.");
      try { await chrome.tabs.remove(tab.id); } catch (e) { /* closed */ }
      return;
    }
    r = await inPage(tab.id, runner, [job.data, "commit", r.ctx || null]);
    if (!r) r = { outcome: "failed", detail: "No answer from the page." };
  }

  await reportProvision(job, r.outcome || "failed", r.detail, r.createdEmail);
  const good = r.outcome === "done" || r.outcome === "invited" || r.outcome === "already";
  await inPage(tab.id, zoeBanner, [good ? "Zoe: " + job.systemName + " is set up for " + job.employeeName + "." : "Zoe could not finish " + job.systemName + ": " + (r.detail || "unknown") + " Finish it here, then mark it done in Zoe.", good ? "ok" : "bad"], "ISOLATED");
  if (good) {
    await sleep(2500);
    try { await chrome.tabs.remove(tab.id); } catch (e) { /* closed */ }
  }
}

// ── Isolated-world UI (banner + approval box) ───────────────────────────────────────────────────────
function zoeBanner(text, tone) {
  let el = document.getElementById("zoe-provision-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "zoe-provision-banner";
    el.style.cssText = "position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);max-width:640px;padding:10px 16px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)";
    document.documentElement.appendChild(el);
  }
  const bg = tone === "ok" ? "#0f5132" : tone === "bad" ? "#842029" : "#1f2937";
  el.style.background = bg;
  el.style.color = "#fff";
  el.textContent = text;
  return true;
}

function zoeAskApproval(title, lines, waitMs) {
  return new Promise((resolve) => {
    const old = document.getElementById("zoe-provision-approval");
    if (old) old.remove();
    const wrap = document.createElement("div");
    wrap.id = "zoe-provision-approval";
    wrap.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font:14px/1.45 system-ui,sans-serif";
    const box = document.createElement("div");
    box.style.cssText = "background:#fff;color:#111;max-width:460px;width:calc(100% - 32px);border-radius:10px;padding:20px;box-shadow:0 12px 40px rgba(0,0,0,.3)";
    const h = document.createElement("div");
    h.style.cssText = "font-weight:600;font-size:16px;margin-bottom:8px";
    h.textContent = title;
    box.appendChild(h);
    for (const l of lines) {
      const p = document.createElement("div");
      p.style.cssText = "margin:4px 0;color:#333";
      p.textContent = l;
      box.appendChild(p);
    }
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:16px";
    const no = document.createElement("button");
    no.textContent = "Not now";
    no.style.cssText = "padding:8px 14px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer";
    const yes = document.createElement("button");
    yes.textContent = "Approve";
    yes.style.cssText = "padding:8px 14px;border-radius:6px;border:0;background:#111;color:#fff;cursor:pointer";
    row.appendChild(no);
    row.appendChild(yes);
    box.appendChild(row);
    wrap.appendChild(box);
    document.documentElement.appendChild(wrap);
    let done = false;
    const finish = (v) => { if (done) return; done = true; wrap.remove(); resolve(v); };
    yes.addEventListener("click", () => finish("approve"));
    no.addEventListener("click", () => finish("decline"));
    setTimeout(() => finish("timeout"), waitMs || 900000);
  });
}

// ── Page runners (MAIN world, self-contained) ───────────────────────────────────────────────────────
// Each returns { outcome: "done"|"invited"|"already"|"failed"|"by_hand", detail, createdEmail } or, from
// "prepare", { approval: { title, lines }, ctx, cancelable } / { needLogin: url }.

async function zoeRunSlack(data, phase) {
  if (phase !== "prepare") return { outcome: "failed", detail: "unexpected step" };
  let team = null;
  try { team = (JSON.parse(localStorage.getItem("localConfig_v2") || "{}").teams || {})[data.teamId]; } catch (e) { team = null; }
  if (!team || !team.token) return { outcome: "failed", detail: "Slack in this Chrome is not signed in to the Zoe workspace." };
  const fd = new FormData();
  fd.append("token", team.token);
  fd.append("invites", JSON.stringify([{ email: data.email, type: "regular", mode: "manual" }]));
  fd.append("team_id", data.teamId);
  fd.append("restricted", "false");
  fd.append("ultra_restricted", "false");
  fd.append("campaign", "team_menu");
  fd.append("_x_reason", "submit-invite-to-workspace-invites");
  fd.append("_x_mode", "online");
  fd.append("_x_sonic", "true");
  fd.append("_x_app_name", "client");
  let j = {};
  try {
    const r = await fetch("/api/users.admin.inviteBulk", { method: "POST", body: fd, credentials: "include" });
    j = await r.json();
  } catch (e) {
    return { outcome: "failed", detail: "Slack did not answer." };
  }
  if (!j.ok) return { outcome: "failed", detail: "Slack said: " + (j.error || "error") };
  const inv = (j.invites || [])[0] || {};
  if (inv.ok) return { outcome: "invited", detail: "Slack emailed the invite.", createdEmail: data.email };
  const e = String(inv.error || "");
  if (e === "already_in_team") return { outcome: "already", detail: "Already in Slack.", createdEmail: data.email };
  if (/already_invited|already_in_team_invited_user/.test(e)) return { outcome: "invited", detail: "Already invited to Slack.", createdEmail: data.email };
  return { outcome: "failed", detail: "Slack said: " + (e || "error") };
}

async function zoeRunSquarespace(data, phase, ctx) {
  const crumb = (document.cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("crumb=")) || "").slice(6);
  const H = { "content-type": "application/json", accept: "application/json, text/plain, */*", "X-CSRF-Token": crumb };
  const base = "/api/google-email-product/subscriptions/" + data.subscriptionId;
  const userBody = (idem) => ({
    contractId: data.contractId,
    changeType: "add",
    requestApiMetadata: {
      productType: "google-apps",
      changeType: "add",
      newGoogleAppsUser: { firstName: data.firstName, lastName: data.lastName, userName: data.userName, asAdmin: "", email: data.newEmail, welcomeEmailRecipient: data.loginTo, idempotencyKey: idem },
    },
  });
  const exists = async () => {
    const r = await fetch(base + "/users", { credentials: "include" });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.results || []).some((u) => String(u.email || "").toLowerCase() === data.newEmail.toLowerCase());
  };
  if (!crumb) return { outcome: "failed", detail: "Squarespace is not signed in here." };
  if (phase === "prepare") {
    if (await exists()) return { outcome: "already", detail: data.newEmail + " already exists.", createdEmail: data.newEmail };
    const v = await fetch(base + "/users/validate", { method: "POST", credentials: "include", headers: H, body: JSON.stringify({ email: data.newEmail }) });
    if (v.status !== 204 && v.status !== 200) {
      const t = await v.text();
      let msg = t.slice(0, 120);
      try { const j = JSON.parse(t); msg = (j.errors && Object.values(j.errors).join(" ")) || j.error || msg; } catch (e) { /* plain */ }
      return { outcome: "failed", detail: "Squarespace refused " + data.newEmail + ": " + msg };
    }
    const idem = crypto.randomUUID();
    const p = await fetch("/api/billing/contracts/preview-quantity-change", { method: "PUT", credentials: "include", headers: H, body: JSON.stringify(userBody(idem)) });
    if (!p.ok) return { outcome: "failed", detail: "Squarespace price check failed (HTTP " + p.status + ")." };
    const pj = await p.json();
    const today = pj && pj.invoice && pj.invoice.total ? pj.invoice.total.value : "?";
    const monthly = pj && pj.contract && pj.contract.plan && pj.contract.plan.price ? pj.contract.plan.price.value : "?";
    return {
      approval: {
        title: "Create " + data.newEmail + "?",
        lines: [
          "Squarespace charges the card on file $" + today + " today,",
          "then $" + monthly + " a month for this Google Workspace seat.",
          "Google sends the login to " + data.loginTo + ".",
        ],
      },
      ctx: { idem },
    };
  }
  if (phase === "commit") {
    const r = await fetch("/api/billing/billing-requests/quantity-change", { method: "POST", credentials: "include", headers: H, body: JSON.stringify(userBody((ctx && ctx.idem) || crypto.randomUUID())) });
    if (!r.ok) return { outcome: "failed", detail: "Squarespace purchase failed (HTTP " + r.status + ")." };
    const j = await r.json();
    const id = j && j.id;
    const until = Date.now() + 120000;
    let state = j && j.state;
    while (id && state !== "completed" && state !== "failed" && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 1500));
      try { const s = await (await fetch("/api/billing/billing-requests/" + id + "/", { credentials: "include" })).json(); state = s.state; } catch (e) { /* retry */ }
    }
    if (state === "failed") return { outcome: "failed", detail: "Squarespace could not complete the purchase." };
    await new Promise((res) => setTimeout(res, 3000));
    if (await exists()) return { outcome: "done", detail: "Created " + data.newEmail + ".", createdEmail: data.newEmail };
    return { outcome: "by_hand", detail: "Paid, but " + data.newEmail + " is not listed yet. Check the Users list here." };
  }
  return { outcome: "failed", detail: "unexpected step" };
}

async function zoeRunYelp(data, phase) {
  const gql = async (op) => {
    const r = await fetch("/gql/batch", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify([op]) });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (e) { j = null; }
    return { status: r.status, j: Array.isArray(j) ? j[0] : j, t };
  };
  if (phase === "prepare") {
    const f = await gql({ operationName: "GetFreshLoginSessionStatus", variables: {}, extensions: { operationType: "query", documentId: data.freshLoginDoc } });
    const fresh = f.j && f.j.data && f.j.data.loggedInBizUser && f.j.data.loggedInBizUser.private && f.j.data.loggedInBizUser.private.hasFreshLoginSession;
    if (!fresh) return { needLogin: "https://biz.yelp.com/login/verify_password?return_url=" + encodeURIComponent(data.startUrl) };
    return {
      approval: {
        title: "Invite " + data.email + " to Yelp for Business?",
        lines: ["Yelp only offers full owner access.", "They can manage the Zoe page and buy ads on the card on file."],
      },
    };
  }
  if (phase === "commit") {
    const op = {
      operationName: "CreateOrganizationInvite",
      variables: { orgId: data.orgId, inviteeEmail: data.email, inviteeRole: "OWNER", bizEncIds: data.bizEncIds },
      extensions: { operationType: "mutation", documentId: data.createInviteDoc },
    };
    const r = await gql(op);
    const errs = (r.j && r.j.errors) || null;
    if (r.status === 200 && !errs) return { outcome: "invited", detail: "Yelp emailed the invite.", createdEmail: data.email };
    const msg = errs ? errs.map((e) => e.message).join(" ") : "HTTP " + r.status;
    if (/already/i.test(msg)) return { outcome: "already", detail: "Already on the Yelp account.", createdEmail: data.email };
    return { outcome: "failed", detail: "Yelp said: " + msg.slice(0, 160) };
  }
  return { outcome: "failed", detail: "unexpected step" };
}

// Quo's API needs an app version header the page builds at runtime, so this fills Quo's own Invite form.
async function zoeRunQuo(data, phase) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => !!el && el.getClientRects().length > 0;
  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const waitFor = async (fn, ms) => { const until = Date.now() + (ms || 10000); while (Date.now() < until) { const v = fn(); if (v) return v; await sleep(250); } return null; };
  const press = (el) => {
    const o = { bubbles: true, cancelable: true, composed: true, button: 0, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new PointerEvent("pointerup", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.click();
  };
  const setValue = (input, value) => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const buttons = (root, re) => [...(root || document).querySelectorAll("button,[role=button]")].filter((b) => vis(b) && re.test(txt(b)));
  const dialogs = () => [...document.querySelectorAll("[role=dialog],[role=alertdialog]")].filter(vis);
  const email = String(data.email).toLowerCase();
  const fail = (step) => ({ outcome: "by_hand", detail: "Quo: could not " + step + ". Finish the invite in this tab." });

  if (phase === "prepare") {
    await waitFor(() => buttons(document, /^Invite your team$/i)[0], 15000);
    if (document.body.innerText.toLowerCase().includes(email)) return { outcome: "already", detail: "Already a Quo member.", createdEmail: data.email };
    const open = buttons(document, /^Invite your team$/i)[0];
    if (!open) return fail("find Invite your team");
    press(open);
    const dlg = await waitFor(() => dialogs().find((d) => /Invite your team/i.test(txt(d))), 8000);
    if (!dlg) return fail("open the invite window");
    const input = dlg.querySelector("input[type=email],input[placeholder*='email' i],input");
    if (!input) return fail("find the email box");
    input.focus();
    setValue(input, data.email);
    await sleep(300);
    const add = buttons(dlg, /^Add to list$/i)[0];
    if (!add) return fail("find Add to list");
    press(add);
    const row = await waitFor(() => dlg.innerText.toLowerCase().includes(email) && buttons(dlg, /New number|Zoe Events|number/i)[0], 6000);
    if (!row) return fail("add the email to the list");
    // Number assignment: shared line on, "New number" (a paid extra number) off. The list is a grid of rows;
    // pressing a row's cell flips its checkbox (verified live 2026-11-10).
    const trigger = buttons(dlg, /New number/i)[0] || row;
    press(trigger);
    const grid = await waitFor(() => [...document.querySelectorAll("[role=grid],[role=listbox],[role=menu]")].filter(vis).find((m) => m.innerText.includes(data.lineName)), 6000);
    if (!grid) return fail("open the number list");
    const rows = [...grid.querySelectorAll("[role=row],[role=option],[role=menuitemcheckbox]")].filter(vis);
    const rowOf = (re) => rows.find((r) => re.test(txt(r)));
    const box = (r) => r && r.querySelector("input[type=checkbox]");
    const flip = async (r) => { press(r.querySelector("[role=gridcell]") || r); await sleep(300); };
    const lineName = String(data.lineName);
    const line = rows.find((r) => txt(r).includes(lineName));
    if (!line || !box(line)) return fail("find the " + data.lineName + " line");
    if (!box(line).checked) await flip(line);
    const nn = rowOf(/New number/i);
    if (nn && box(nn) && box(nn).checked) await flip(nn);
    if (!box(line).checked || (nn && box(nn) && box(nn).checked)) return fail("set the number to " + data.lineName);
    press(dlg.querySelector("h1,h2,h3") || dlg);
    await sleep(500);
    if (buttons(dlg, /New number/i).length || !dlg.innerText.includes(data.lineName)) return fail("set the number to " + data.lineName);
    if (!new RegExp(data.role, "i").test(dlg.innerText)) return fail("confirm the " + data.role + " role");
    const send = buttons(dlg, /^Send invites?$/i)[0];
    if (!send) return fail("find Send invites");
    if (data.dryRun) return { outcome: "dry", detail: "Quo form filled; stopped before Send invites." };
    press(send);
    const bill = await waitFor(() => dialogs().find((d) => /billed|seat\/month|Add \d+ member/i.test(txt(d))), 8000);
    if (!bill) return fail("see the price");
    const priceLine = (txt(bill).match(/New members are billed[^.]*\.[^.]*\./i) || [txt(bill).slice(0, 200)])[0];
    return {
      approval: { title: "Add " + data.email + " to Quo?", lines: [priceLine, "Line: " + data.lineName + " (no new number). Role: " + data.role + "."] },
      cancelable: true,
    };
  }
  if (phase === "commit") {
    const bill = dialogs().find((d) => /billed|Add \d+ member/i.test(txt(d)));
    const ok = bill && buttons(bill, /^Add member/i)[0];
    if (!ok) return fail("find Add member");
    press(ok);
    const done = await waitFor(() => !dialogs().some((d) => /billed|Invite your team/i.test(txt(d))) && document.body.innerText.toLowerCase().includes(email), 12000);
    if (!done) return fail("confirm the invite went out");
    return { outcome: "invited", detail: "Quo emailed the invite.", createdEmail: data.email };
  }
  if (phase === "cancel") {
    for (const d of dialogs().reverse()) { const c = buttons(d, /^Cancel$/i)[0]; if (c) { press(c); await sleep(400); } }
    return { outcome: "declined" };
  }
  return { outcome: "failed", detail: "unexpected step" };
}

// WeddingPro's API session header is built from protected cookies, so this fills its own Invite user form.
async function zoeRunWeddingPro(data, phase) {
  if (phase !== "prepare") return { outcome: "failed", detail: "unexpected step" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => !!el && el.getClientRects().length > 0;
  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const waitFor = async (fn, ms) => { const until = Date.now() + (ms || 10000); while (Date.now() < until) { const v = fn(); if (v) return v; await sleep(250); } return null; };
  const press = (el) => {
    const o = { bubbles: true, cancelable: true, composed: true, button: 0, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new PointerEvent("pointerup", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.click();
  };
  const setValue = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  };
  const buttons = (root, re) => [...(root || document).querySelectorAll("button,[role=button]")].filter((b) => vis(b) && re.test(txt(b)));
  const email = String(data.email).toLowerCase();
  const fail = (step) => ({ outcome: "by_hand", detail: "WeddingPro: could not " + step + ". Finish the invite in this tab." });
  const inputFor = (root, re) => {
    for (const inp of root.querySelectorAll("input")) {
      if (!vis(inp)) continue;
      const lab = (inp.id && root.querySelector("label[for='" + CSS.escape(inp.id) + "']")) || inp.closest("label") || inp.parentElement;
      const hay = [inp.getAttribute("aria-label"), inp.placeholder, inp.name, lab && txt(lab)].filter(Boolean).join(" ");
      if (re.test(hay)) return inp;
    }
    return null;
  };

  await waitFor(() => buttons(document, /^Invite user$/i)[0], 15000);
  if (document.body.innerText.toLowerCase().includes(email)) return { outcome: "already", detail: "Already on WeddingPro.", createdEmail: data.email };
  const open = buttons(document, /^Invite user$/i)[0];
  if (!open) return fail("find Invite user");
  press(open);
  // The invite window has no dialog role; its fields are named firstName / lastName / email (live 2026-11-10).
  const mail = await waitFor(() => [...document.querySelectorAll("input[name=email]")].find(vis) || inputFor(document, /e-?mail/i), 8000);
  if (!mail) return fail("open the invite window");
  let dlg = mail;
  while (dlg && !buttons(dlg, /^Cancel$/i).length) dlg = dlg.parentElement;
  if (!dlg) return fail("find the invite window");
  const first = dlg.querySelector("input[name=firstName]") || inputFor(dlg, /first/i);
  const last = dlg.querySelector("input[name=lastName]") || inputFor(dlg, /last/i);
  if (!first || !last) return fail("find the name boxes");
  setValue(first, data.firstName || "New");
  setValue(last, data.lastName || "Hire");
  setValue(mail, data.email);
  await sleep(300);
  const roleRe = new RegExp("^" + data.roleLabel + "$", "i");
  const roleBtn = buttons(dlg, /^Role$|Administrator|Storefront manager/i)[0];
  if (!roleBtn) return fail("find the Role list");
  // The form can keep the last role picked; only pick when it is not already the one we want.
  if (!roleRe.test(txt(roleBtn))) {
    press(roleBtn);
    const opt = await waitFor(() => [...document.querySelectorAll("li,label,[role=option],[role=checkbox],div")].filter((el) => vis(el) && new RegExp("^" + data.roleLabel, "i").test(txt(el))).sort((a, b) => txt(a).length - txt(b).length)[0], 5000);
    if (!opt) return fail("pick " + data.roleLabel);
    const box = (opt.closest("li,label,div") || opt).querySelector("input[type=checkbox],input[type=radio],[role=checkbox]") || opt;
    press(box);
    await sleep(300);
    const title = [...dlg.querySelectorAll("*")].find((e) => e.children.length === 0 && /^Invite user$/i.test(txt(e)));
    press(title || dlg);
    await sleep(400);
  }
  if (!roleRe.test(txt(roleBtn))) return fail("set the role to " + data.roleLabel);
  const submit = buttons(dlg, /^Invite user$/i).pop();
  if (!submit || submit.disabled) return fail("send the invite (button not ready)");
  if (data.dryRun) return { outcome: "dry", detail: "WeddingPro form filled; stopped before Invite user." };
  press(submit);
  const ok = await waitFor(() => /invited successfully|invitation email has been sent/i.test(document.body.innerText) || (document.body.innerText.toLowerCase().includes(email) && !vis(dlg)), 12000);
  if (!ok) return fail("confirm the invite went out");
  return { outcome: "invited", detail: "WeddingPro emailed the invite.", createdEmail: data.email };
}

// Goodshuffle: buying the seat IS the invite (same-origin XHR from the signed-in Goodshuffle tab).
async function zoeRunGoodshuffle(data, phase) {
  const H = { accept: "application/json, text/plain, */*", "content-type": "application/json", "x-requested-with": "XMLHttpRequest" };
  const email = String(data.email).toLowerCase();
  const onTeam = async () => {
    const r = await fetch("/app/subscriptionSeat/list", { credentials: "include", headers: H });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.subscriptionSeats || []).some((s) => {
      const e = [s.invitationEmail, s.employee && s.employee.email].filter(Boolean).map((x) => String(x).toLowerCase());
      return e.includes(email) && s.status !== "CANCELED" && s.status !== "CANCELLED";
    });
  };
  if (phase === "prepare") {
    const t = await onTeam();
    if (t === null) return { outcome: "failed", detail: "Goodshuffle is not signed in here." };
    if (t) return { outcome: "already", detail: "Already on the Goodshuffle team.", createdEmail: data.email };
    return { approval: { title: "Add " + data.email + " to Goodshuffle?", lines: [data.priceLine || "Buys a Goodshuffle seat.", "Full user access."] } };
  }
  if (phase === "commit") {
    const body = { seatsToPurchase: [{ invitationEmail: data.email, fullUser: data.fullUser !== false, interval: data.interval || "month" }], stripePromoCodeID: null, addingFromAccountShare: false };
    const r = await fetch("/app/subscriptionSeat/bulkPurchaseSeats", { method: "POST", credentials: "include", headers: H, body: JSON.stringify(body) });
    if (!r.ok) return { outcome: "failed", detail: "Goodshuffle refused the invite (HTTP " + r.status + ")." };
    await new Promise((res) => setTimeout(res, 1500));
    if (await onTeam()) return { outcome: "done", detail: "Goodshuffle seat added; Goodshuffle emailed the invite.", createdEmail: data.email };
    return { outcome: "by_hand", detail: "Goodshuffle took the request but the seat is not listed yet. Check Team Management here." };
  }
  return { outcome: "failed", detail: "unexpected step" };
}

// Whimsical: its web app speaks Transit-JSON; the invite and the pending list replay with the page's cookies.
async function zoeRunWhimsical(data, phase) {
  if (phase !== "prepare") return { outcome: "failed", detail: "unexpected step" };
  const H = { "Content-Type": "application/transit+json", Accept: "application/transit+json" };
  const ws = "~u" + data.workspaceId;
  const email = String(data.email).toLowerCase();
  const pending = await fetch("/api/workspace.get-pending-invitations", { method: "POST", credentials: "include", headers: H, body: JSON.stringify(["^ ", "~:workspace-id", ws]) });
  if (pending.status === 401 || pending.status === 403) return { outcome: "failed", detail: "Whimsical is not signed in here." };
  const pt = pending.ok ? (await pending.text()).toLowerCase() : "";
  if (pt.includes(email)) return { outcome: "invited", detail: "Already invited to Whimsical.", createdEmail: data.email };
  const body = JSON.stringify(["^ ", "~:emails", ["~#list", [data.email]], "~:editor", data.editor !== false, "~:team-ids", ["~#set", []], "~:workspace-id", ws]);
  const r = await fetch("/api/workspace.invite", { method: "POST", credentials: "include", headers: H, body });
  const t = await r.text();
  if (r.ok && /~:invited",\s*[1-9]/.test(t)) return { outcome: "invited", detail: "Whimsical emailed the invite.", createdEmail: data.email };
  if (r.ok && /~:invited",\s*0/.test(t)) return { outcome: "already", detail: "Already in the Whimsical workspace.", createdEmail: data.email };
  return { outcome: "failed", detail: "Whimsical refused the invite (HTTP " + r.status + ")." };
}

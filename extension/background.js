// Zoe Auto-Pull — service worker. As of v1.3.0 this worker OWNS scheduling and tab lifecycle so the
// operator never has to keep a Goodshuffle tab open:
//
//   • chrome.alarms (NOT setInterval — the SW sleeps) drive a TWO-TIER read-pull: ACTIVE_PULL_ALARM every
//     ACTIVE_PULL_MIN (the FAST lane: routes + active bookings + notes + outbox drain) and FULL_PULL_ALARM
//     every FULL_PULL_MIN (the SLOW lane: the full archive-history walk + orphan-prune for Finance). On
//     each alarm (and on install/startup) it ensures a signed-in pro.goodshuffle.com tab EXISTS (a single
//     pinned, background tab it opens once and keeps alive), records the requested tier in
//     storage.pullTier, then nudges the DECLARED content script (content.js + pull-injected.js) in that
//     tab to run that tier's read-pull. The content script still does the actual same-origin fetches with
//     the operator's GS cookies — that robust model is unchanged.
//   • Handshake: logging into Zoe Ops posts {type:"zoe-sync-now"} via externally_connectable; we ensure
//     the tab + pull immediately, and if GS is signed out we open a login tab (active) so the user can
//     sign in.
//   • create_project drain (default ON — toggle off in Options via createDrainEnabled): background-orchestrated. We
//     fetch the outbox (background fetch, no CORS gate), and for each create op open a background tab to
//     createNewProject; the declared create.js content script claims the op for that exact tab, runs the
//     populate sequence, and asks us to close the tab. One create tab at a time. A stuck tab is reaped
//     by a watchdog and the op is left pending — the read-pull is never disturbed.
//   • create_project is ALSO drained ON DEMAND so a guided-intake submit doesn't wait up to `intervalMin`
//     for the next read-pull: (1) a dedicated short CREATE_DRAIN_ALARM (every CREATE_DRAIN_MIN) drains ONLY
//     creates — a cheap outbox GET that opens a tab only when one is pending — decoupling create latency
//     from the read-pull cadence; and (2) the Zoe app pokes us with {type:"zoe-create-now"} right after a
//     submit (externally_connectable) so the common office-machine case fires within ~1s. Both reuse the
//     SAME drainCreates + create.js claim flow (no parallel drain); the one-at-a-time + watchdog guards hold.
//   • The GENERAL outbox (photos / notes / delivery-fee / email / tasks / team adds) is drained INSIDE the
//     read-pull by pull-injected.js's drainOutbox(), so it normally shares the FAST-lane read cadence. It is
//     ALSO drained ON DEMAND by the SAME path (no parallel drain function here): (1) a dedicated short
//     OUTBOX_DRAIN_ALARM (every OUTBOX_DRAIN_MIN) nudges a pull ONLY when the outbox has a pending op this
//     drainer can action — a cheap outbox GET that no-ops when idle; and (2) the Zoe app pokes us with
//     {type:"zoe-drain-now"} right after it queues such a write (e.g. the Delivery Pricing push) so the
//     office-machine case lands within seconds. Both just trigger the existing content-script pull/drain.
//
// SW lifecycle: no long-lived in-memory state is relied upon across sleeps — everything needed
// (config, lastRun, pendingCreate) lives in chrome.storage.local; alarms, not timers, drive work.

const DEFAULTS = { apiBase: "https://zoe-dispatch.fly.dev", intervalMin: 10, enabled: true, createDrainEnabled: true };
// TWO-TIER read-pull cadence (named here so they're easy to tune). The FAST lane refreshes routes +
// ACTIVE projects + notes + outbox every ACTIVE_PULL_MIN; the SLOW lane walks the FULL archive history
// (and runs the orphan-prune) every FULL_PULL_MIN. The full lane is a superset of the active one, so a
// coincident tick needs no special handling — each alarm just asks for its own tier. The legacy
// `intervalMin` config no longer sets the cadence (it only feeds content.js's cross-tab dedup window).
const ACTIVE_PULL_ALARM = "zoe-pull-active";
const ACTIVE_PULL_MIN = 3; // FAST lane: routes + active bookings + notes + outbox
const FULL_PULL_ALARM = "zoe-pull-full";
const FULL_PULL_MIN = 60; // SLOW lane: full archive history + orphan-prune (Finance / intelligence)
const CREATE_DRAIN_ALARM = "zoe-create-drain"; // drains ONLY creates, on a short fixed period (on-demand-ish)
const CREATE_DRAIN_MIN = 1; // keep pending-create latency ≤ ~1 min regardless of the read-pull interval
const OUTBOX_DRAIN_ALARM = "zoe-outbox-drain"; // nudges the general-outbox drain when (and only when) ops are pending
const OUTBOX_DRAIN_MIN = 1; // keep pending general-outbox latency ≤ ~1 min regardless of the read-pull interval
const CREATE_WATCHDOG = "zoe-create-watchdog";
const GS_MATCH = "https://pro.goodshuffle.com/*";
const GS_DASHBOARD = "https://pro.goodshuffle.com/app/dashboard";
const GS_CREATE = "https://pro.goodshuffle.com/app/project/createNewProject";
const GS_LOGIN = "https://pro.goodshuffle.com/app/login";
const IW_MATCH = "https://app.instawork.com/*";
const IW_HOME = "https://app.instawork.com/";
const IGN_MATCH = "https://ignition.zonarsystems.com/*";
const IGN_HOME = "https://ignition.zonarsystems.com/";
const GUSTO_HOME = "https://app.gusto.com/";
const CREATE_TIMEOUT_MS = 90_000; // reap an unclaimed/stuck create tab after this
const GUSTO_SYNC_WATCHDOG = "zoe-gusto-watchdog";
const GUSTO_SYNC_TIMEOUT_MS = 120_000; // reap the dedicated on-demand Gusto tab if it never posts
const GUSTO_PUSH_WATCHDOG = "zoe-gusto-push-watchdog";
const GUSTO_PUSH_TIMEOUT_MS = 180_000; // reap the dedicated DRAFT-hours-push tab if it never reports done
const GUSTO_SUBMIT_WATCHDOG = "zoe-gusto-submit-watchdog";
const GUSTO_SUBMIT_TIMEOUT_MS = 180_000; // reap the dedicated SUBMIT / wire-CONFIRM tab if it never reports done

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
// Two independent read-pull alarms: the FAST lane (active tier) every ACTIVE_PULL_MIN and the SLOW lane
// (full tier) every FULL_PULL_MIN. chrome.alarms enforces a 0.5-min floor for unpacked; both cadences
// clear that comfortably. Each alarm fires its own tier; the full lane is a superset of the active one,
// so no coordination is needed when they land on the same minute.
async function ensureAlarm() {
  const active = await chrome.alarms.get(ACTIVE_PULL_ALARM).catch(() => null);
  if (!active || active.periodInMinutes !== ACTIVE_PULL_MIN) {
    await chrome.alarms.create(ACTIVE_PULL_ALARM, { periodInMinutes: ACTIVE_PULL_MIN, delayInMinutes: 0.1 });
  }
  const full = await chrome.alarms.get(FULL_PULL_ALARM).catch(() => null);
  if (!full || full.periodInMinutes !== FULL_PULL_MIN) {
    // Small initial delay so the first full history sweep seeds the archive shortly after startup.
    await chrome.alarms.create(FULL_PULL_ALARM, { periodInMinutes: FULL_PULL_MIN, delayInMinutes: 0.5 });
  }
  // Retire the old single-tier alarm if it lingers from a prior version.
  await chrome.alarms.clear("zoe-pull").catch(() => {});
  await ensureCreateDrainAlarm();
  await ensureOutboxDrainAlarm();
}

// Dedicated short alarm that nudges the GENERAL-outbox drain (pull-injected.js's drainOutbox, via a normal
// pull), so a queued delivery-fee / note / photo / email / task write is picked up within ~OUTBOX_DRAIN_MIN
// minutes instead of waiting for the next FAST-lane read-pull. drainOutboxNow is cheap when idle (one
// outbox GET → nothing actionable pending → returns without nudging) and honors `enabled` itself, so this
// alarm is a no-op when disabled or when the outbox is empty. Kept separate from the read-pull alarms so it
// never drags the read-pull onto a faster cadence.
async function ensureOutboxDrainAlarm() {
  const existing = await chrome.alarms.get(OUTBOX_DRAIN_ALARM).catch(() => null);
  if (!existing || existing.periodInMinutes !== OUTBOX_DRAIN_MIN) {
    await chrome.alarms.create(OUTBOX_DRAIN_ALARM, { periodInMinutes: OUTBOX_DRAIN_MIN, delayInMinutes: OUTBOX_DRAIN_MIN });
  }
}

// Dedicated short alarm that drains ONLY pending creates, so a queued guided-intake create is picked up
// within ~CREATE_DRAIN_MIN minutes instead of waiting for the next FAST-lane read-pull. drainCreates
// is cheap when idle (one outbox GET → nothing pending → returns) and honors createDrainEnabled itself, so
// this alarm is a no-op when the feature is toggled off. Kept separate from the read-pull alarms so it never
// drags the read-pull onto a faster cadence.
async function ensureCreateDrainAlarm() {
  const existing = await chrome.alarms.get(CREATE_DRAIN_ALARM).catch(() => null);
  if (!existing || existing.periodInMinutes !== CREATE_DRAIN_MIN) {
    await chrome.alarms.create(CREATE_DRAIN_ALARM, { periodInMinutes: CREATE_DRAIN_MIN, delayInMinutes: CREATE_DRAIN_MIN });
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

// ── On-demand Gusto sync (NOT on the 10-min loop) ───────────────────────────────
// Payroll is not a continuous job, so Gusto no longer rides runPullCycle. Instead, when the Zoe app asks
// (externally_connectable {type:"zoe-gusto-sync"}), we open ONE dedicated background app.gusto.com tab.
// gusto.js (world MAIN) auto-runs on that hidden tab: it hops to the People page, the app fires its
// GraphQL reads, gusto.js captures + POSTs the snapshot to Zoe, then emits a window message. The isolated-
// world bridge (gusto-bridge.js) relays that to us as {type:"zoe-gusto-posted"} and we close the exact tab
// we opened — so nothing lingers. A watchdog reaps the tab if it never posts (e.g. Gusto signed out). We
// track the one in-flight sync in storage.gustoSync so it survives a service-worker sleep, and guard
// against concurrent syncs.
async function getGustoSync() {
  const { gustoSync } = await chrome.storage.local.get("gustoSync");
  return gustoSync || null;
}
async function setGustoSync(v) {
  if (v) await chrome.storage.local.set({ gustoSync: v });
  else await chrome.storage.local.remove("gustoSync");
}

/** Close the dedicated on-demand Gusto tab and clear the in-flight marker + watchdog. */
async function reapGustoSync(pending) {
  try {
    if (pending && pending.tabId != null) await chrome.tabs.remove(pending.tabId);
  } catch (e) {
    /* tab already gone */
  }
  await setGustoSync(null);
  try {
    await chrome.alarms.clear(GUSTO_SYNC_WATCHDOG);
  } catch (e) {
    /* no-op */
  }
}

// ── On-demand Gusto DRAFT hours PUSH (the WRITE side; NOT on any loop) ───────────────────────────────
// DRAFT ONLY. The Zoe app sends {type:"zoe-gusto-push", payload:{which, period, entries}}. We open ONE
// dedicated hidden app.gusto.com tab and arm a push job keyed to that exact tab. gusto-bridge.js (isolated)
// CLAIMS the job for that tab and hands the entries to gusto-push.js (MAIN), which drives the draft run's
// inputs step and replays AutoSaveWorkedHours per worker (it ABORTS if the run isn't a DRAFT, and never
// submits payroll). On its "done" relay we close the exact tab; a watchdog reaps it if it stalls. Mirrors
// the read-sync tab lifecycle. One push at a time (guarded) so a user's own Gusto tab is never driven.
async function getGustoPush() {
  const { gustoPush } = await chrome.storage.local.get("gustoPush");
  return gustoPush || null;
}
async function setGustoPush(v) {
  if (v) await chrome.storage.local.set({ gustoPush: v });
  else await chrome.storage.local.remove("gustoPush");
}
async function reapGustoPush(pending) {
  try {
    if (pending && pending.tabId != null) await chrome.tabs.remove(pending.tabId);
  } catch (e) {
    /* tab already gone */
  }
  await setGustoPush(null);
  try {
    await chrome.alarms.clear(GUSTO_PUSH_WATCHDOG);
  } catch (e) {
    /* no-op */
  }
}

/** Clear the in-flight push marker + watchdog WITHOUT closing the tab. Used when a signed-out push reveals
 *  its hidden tab for the operator to sign in: the watchdog must no longer reap that tab (it's now a normal
 *  Gusto tab the operator is using), and the marker must clear so the next "Push" can open a fresh tab. */
async function detachGustoPush() {
  await setGustoPush(null);
  try {
    await chrome.alarms.clear(GUSTO_PUSH_WATCHDOG);
  } catch (e) {
    /* no-op */
  }
}

/** Trigger one on-demand DRAFT hours push. Guards against a concurrent push (one marker, stale after the
 *  timeout). The entries come from Zoe's owner/admin-gated push-payload builder — we only transport them. */
async function startGustoPush(payload) {
  const entries = payload && Array.isArray(payload.entries) ? payload.entries : [];
  if (!entries.length) return { ok: false, reason: "no_entries" };
  const pending = await getGustoPush();
  if (pending) {
    if (Date.now() - pending.startedAt > GUSTO_PUSH_TIMEOUT_MS) {
      await reapGustoPush(pending); // stale — reap and start fresh below
    } else {
      return { ok: true, already: true };
    }
  }
  let tab;
  try {
    tab = await chrome.tabs.create({ url: GUSTO_HOME, pinned: false, active: false });
  } catch (e) {
    return { ok: false, reason: "no_tab" };
  }
  await setGustoPush({
    tabId: tab.id,
    startedAt: Date.now(),
    claimed: false,
    job: { entries, period: (payload && payload.period) || null, initiatedBy: (payload && payload.initiatedBy) || null },
  });
  chrome.alarms.create(GUSTO_PUSH_WATCHDOG, { delayInMinutes: GUSTO_PUSH_TIMEOUT_MS / 60000 });
  return { ok: true, tabId: tab.id };
}

// ── On-demand Gusto SUBMIT + wire CONFIRM (the IRREVERSIBLE side; NOT on any loop) ───────────────────
// REAL PAYROLL. The Zoe app (Admin, after the hard confirm) sends {type:"zoe-gusto-submit", payload:{...}}
// or {type:"zoe-gusto-confirm-wire", payload:{...}}. We open ONE dedicated hidden app.gusto.com tab and arm
// a job keyed to that exact tab (kind "submit" | "confirm_wire"). gusto-bridge.js (isolated) CLAIMS the job
// for that tab and hands it to gusto-submit.js (MAIN), which does the one write (SubmitDraftPayroll WIRE
// ONLY, or WireInInstructions→ConfirmWireIn) and ABORTS if signed out. On its "done" relay we close the exact
// tab; a watchdog reaps it if it stalls. One submit/confirm at a time (guarded). Human-triggered only — no
// alarm/loop ever starts one.
async function getGustoSubmit() {
  const { gustoSubmit } = await chrome.storage.local.get("gustoSubmit");
  return gustoSubmit || null;
}
async function setGustoSubmit(v) {
  if (v) await chrome.storage.local.set({ gustoSubmit: v });
  else await chrome.storage.local.remove("gustoSubmit");
}
async function reapGustoSubmit(pending) {
  try {
    if (pending && pending.tabId != null) await chrome.tabs.remove(pending.tabId);
  } catch (e) {
    /* tab already gone */
  }
  await setGustoSubmit(null);
  try {
    await chrome.alarms.clear(GUSTO_SUBMIT_WATCHDOG);
  } catch (e) {
    /* no-op */
  }
}
/** Clear the submit marker + watchdog WITHOUT closing the tab (signed-out reveal for sign-in). */
async function detachGustoSubmit() {
  await setGustoSubmit(null);
  try {
    await chrome.alarms.clear(GUSTO_SUBMIT_WATCHDOG);
  } catch (e) {
    /* no-op */
  }
}

/** Trigger one on-demand submit OR wire-confirm. `kind` is "submit" | "confirm_wire". Guards against a
 *  concurrent job (one marker, stale after the timeout). The job fields come from Zoe's Admin-gated
 *  submit-payload builder + the confirm control — we only transport them. */
async function startGustoSubmit(kind, payload) {
  const k = kind === "confirm_wire" ? "confirm_wire" : "submit";
  const pending = await getGustoSubmit();
  if (pending) {
    if (Date.now() - pending.startedAt > GUSTO_SUBMIT_TIMEOUT_MS) {
      await reapGustoSubmit(pending); // stale — reap and start fresh below
    } else {
      return { ok: true, already: true };
    }
  }
  let tab;
  try {
    tab = await chrome.tabs.create({ url: GUSTO_HOME, pinned: false, active: false });
  } catch (e) {
    return { ok: false, reason: "no_tab" };
  }
  const p = payload || {};
  await setGustoSubmit({
    tabId: tab.id,
    startedAt: Date.now(),
    claimed: false,
    job: {
      kind: k,
      period: p.period || null,
      checkDate: p.checkDate || null,
      expectedTotal: p.expectedTotal != null ? p.expectedTotal : null,
      headcount: p.headcount != null ? p.headcount : null,
      amount: p.amount != null ? p.amount : null,
      wireDate: p.wireDate || null,
      initiatedBy: p.initiatedBy || null,
    },
  });
  chrome.alarms.create(GUSTO_SUBMIT_WATCHDOG, { delayInMinutes: GUSTO_SUBMIT_TIMEOUT_MS / 60000 });
  return { ok: true, tabId: tab.id };
}

/** Trigger one on-demand Gusto sync. Guards against a concurrent sync: if one is already in flight (and
 *  not stale), we leave it running instead of opening a second tab. */
async function startGustoSync(reason) {
  const pending = await getGustoSync();
  if (pending) {
    if (Date.now() - pending.startedAt > GUSTO_SYNC_TIMEOUT_MS) {
      await reapGustoSync(pending); // stale — reap and start fresh below
    } else {
      return { ok: true, already: true };
    }
  }
  let tab;
  try {
    tab = await chrome.tabs.create({ url: GUSTO_HOME, pinned: false, active: false });
  } catch (e) {
    return { ok: false, reason: "no_tab" };
  }
  await setGustoSync({ tabId: tab.id, startedAt: Date.now(), reason });
  chrome.alarms.create(GUSTO_SYNC_WATCHDOG, { delayInMinutes: GUSTO_SYNC_TIMEOUT_MS / 60000 });
  return { ok: true, tabId: tab.id };
}

/** Nudge the content script in existing GS tab(s) to run a pull now, for the given tier ("active" |
 *  "full"). The content script watches storage.pullNow and reads storage.pullTier to know which lane to
 *  run; storage is the reliable cross-tab (and cross-SW-sleep) trigger. We set both in ONE write so the
 *  single onChanged carries the committed tier. The Instawork content script watches the SAME
 *  storage.pullNow, so this one nudge pulls it too (tier is Goodshuffle-only). */
async function triggerPull(tier) {
  const t = tier === "full" ? "full" : "active";
  await chrome.storage.local.set({ pullTier: t, pullNow: Date.now() });
}

/** Full cycle used by the alarms, install/startup, the popup, and the handshake: make sure a GS tab
 *  exists, then either let a freshly-opened tab auto-run (it reads storage.pullTier) or nudge an existing
 *  one for `tier`; then (opt-in) drain creates. `tier` is "active" (FAST lane) or "full" (SLOW lane). */
async function runPullCycle(reason, tier) {
  const t = tier === "full" ? "full" : "active";
  // Record the tier up front so a GS tab this cycle freshly OPENS (whose content script auto-runs on
  // load without a nudge) reads the correct lane from storage.pullTier.
  await chrome.storage.local.set({ pullTier: t });
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
  // NOTE: Gusto is intentionally NOT pulled here. Payroll is not a continuous job and the old per-cycle
  // ensureGustoTab() piled up app.gusto.com tabs. Gusto now syncs ON DEMAND only (startGustoSync, fired by
  // the app's {type:"zoe-gusto-sync"} handshake), opening one tab and closing it when the pull posts.
  if (!tab) {
    badgeFor("no_tab");
    return { ok: false, reason: "no_tab" };
  }
  // A newly created tab's content script auto-runs on load (reading storage.pullTier, set above); an
  // existing one needs a nudge. One storage.pullNow nudges ALL content scripts, so fire it (with the
  // tier) if any tab was already open.
  if (!justOpened || !iw.justOpened || !ign.justOpened) await triggerPull(t);
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
  // A create tab that timed out WITHOUT being claimed still made a blank Goodshuffle draft. Report the failed
  // attempt so the server's retry budget applies (backoff, then dead-letter) instead of a new blank draft
  // every minute forever (live 2026-10-31). A claimed tab reports its own outcome from create.js.
  if ((why === "stale" || why === "watchdog") && pending && pending.op && !pending.claimed) {
    try {
      const { apiBase } = await cfg();
      await fetch(apiBase + "/api/gs/outbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: pending.op.id, ok: false, error: "create_tab_never_claimed" }),
      });
    } catch (e) {
      /* outbox unreachable: the next timeout reports it */
    }
  }
  await setPending(null);
  try {
    await chrome.alarms.clear(CREATE_WATCHDOG);
  } catch (e) {
    /* no-op */
  }
}

// ── General-outbox drain nudge (ON DEMAND / short alarm) ────────────────────────────
// The general outbox (photos/notes/delivery-fee/email/tasks/team adds) is drained by pull-injected.js's
// drainOutbox(), which only runs as part of a pull. Rather than duplicate that logic here, we TRIGGER the
// existing content-script pull/drain — but only when there's actually an actionable op pending, so an idle
// office machine doesn't run a pull every minute. create_project is excluded (it has its own drainCreates
// path and the content script can't action it). Returns {ok, enabled, pending, nudged} so the external
// handler can tell the app "office browser got it" from "disabled / nothing to do". Never opens a login tab.
async function drainOutboxNow(reason) {
  const { apiBase, enabled } = await cfg();
  if (!enabled) return { ok: true, enabled: false, pending: 0, nudged: false };

  let pending = 0;
  try {
    const r = await fetch(apiBase + "/api/gs/outbox", { headers: { accept: "application/json" } });
    const j = await r.json();
    const ops = (j && j.ops) || [];
    // Everything except create_project is drained by the content-script drainer; count only those.
    pending = ops.filter((o) => o && o.op && o.op !== "create_project").length;
  } catch (e) {
    return { ok: false, enabled: true, pending: 0, nudged: false }; // outbox unreachable — try again next cycle
  }
  if (!pending) return { ok: true, enabled: true, pending: 0, nudged: false };

  // Nudge the existing read-pull/drain in the signed-in GS tab. ensureGsTab opens one if needed; the content
  // script's drainOutbox acks each op, so once applied the next tick finds nothing pending and no-ops. Use
  // the FAST (active) lane — it's the cheapest pull and it carries the outbox drain.
  await ensureGsTab().catch(() => {});
  await triggerPull("active");
  return { ok: true, enabled: true, pending, nudged: true };
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
  // Seed everything on startup with one full history sweep (which also refreshes the active set).
  await runPullCycle("startup", "full");
}
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ACTIVE_PULL_ALARM) {
    runPullCycle("active-alarm", "active").catch(() => {});
  } else if (alarm.name === FULL_PULL_ALARM) {
    runPullCycle("full-alarm", "full").catch(() => {});
  } else if (alarm.name === CREATE_DRAIN_ALARM) {
    drainCreates("create-alarm").catch(() => {});
  } else if (alarm.name === OUTBOX_DRAIN_ALARM) {
    drainOutboxNow("outbox-alarm").catch(() => {});
  } else if (alarm.name === CREATE_WATCHDOG) {
    getPending().then((p) => {
      if (p && Date.now() - p.startedAt > CREATE_TIMEOUT_MS - 1000) reapPending(p, "watchdog");
    });
  } else if (alarm.name === GUSTO_SYNC_WATCHDOG) {
    getGustoSync().then((p) => {
      if (p && Date.now() - p.startedAt > GUSTO_SYNC_TIMEOUT_MS - 1000) reapGustoSync(p);
    });
  } else if (alarm.name === GUSTO_PUSH_WATCHDOG) {
    getGustoPush().then((p) => {
      if (p && Date.now() - p.startedAt > GUSTO_PUSH_TIMEOUT_MS - 1000) reapGustoPush(p);
    });
  } else if (alarm.name === GUSTO_SUBMIT_WATCHDOG) {
    getGustoSubmit().then((p) => {
      if (p && Date.now() - p.startedAt > GUSTO_SUBMIT_TIMEOUT_MS - 1000) reapGustoSubmit(p);
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

  // From the popup → ensure a GS tab exists and pull now. A manual click wants everything, so run the
  // full lane (a superset that also refreshes the active set).
  if (msg.type === "zoe-pull-now") {
    runPullCycle("manual", "full").then((r) => sendResponse(r || { ok: true }));
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

  // gusto-bridge.js (isolated world) relays gusto.js's "posted" window message → close the DEDICATED
  // on-demand sync tab we opened (match by tab id, so a user's own Gusto tab is never closed).
  if (msg.type === "zoe-gusto-posted") {
    (async () => {
      const p = await getGustoSync();
      if (p && sender.tab && sender.tab.id === p.tabId) await reapGustoSync(p);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // gusto-bridge.js (isolated world) claims the DRAFT-push job for ITS tab → return the entries ONLY for the
  // exact tab we opened, and only once (atomic claim), so a user's own Gusto tab is never driven.
  if (msg.type === "zoe-gusto-push-claim") {
    (async () => {
      const p = await getGustoPush();
      if (p && sender.tab && sender.tab.id === p.tabId && !p.claimed) {
        p.claimed = true;
        await setGustoPush(p);
        sendResponse({ job: p.job });
      } else {
        sendResponse({ job: null });
      }
    })();
    return true;
  }

  // gusto-push.js finished the DRAFT write (via the bridge) → close the exact push tab + clear the marker.
  if (msg.type === "zoe-gusto-push-done") {
    (async () => {
      const p = await getGustoPush();
      if (p && sender.tab && sender.tab.id === p.tabId) await reapGustoPush(p);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // gusto-push.js hit a signed-out Gusto → bring ITS hidden tab to the front so the operator can sign in, and
  // DETACH it from the watchdog (so it's never reaped). Only the exact tab we opened. The operator signs in,
  // then clicks "Push" again on a fresh session.
  if (msg.type === "zoe-gusto-push-reveal") {
    (async () => {
      const p = await getGustoPush();
      if (p && sender.tab && sender.tab.id === p.tabId) {
        await detachGustoPush();
        try { await chrome.tabs.update(p.tabId, { active: true }); } catch (e) { /* tab gone */ }
        try { if (sender.tab.windowId != null) await chrome.windows.update(sender.tab.windowId, { focused: true }); } catch (e) { /* no window */ }
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  // gusto-submit.js (via the bridge) claims the SUBMIT / wire-CONFIRM job for ITS tab → return the job ONLY
  // for the exact tab we opened, and only once (atomic claim).
  if (msg.type === "zoe-gusto-submit-claim") {
    (async () => {
      const p = await getGustoSubmit();
      if (p && sender.tab && sender.tab.id === p.tabId && !p.claimed) {
        p.claimed = true;
        await setGustoSubmit(p);
        sendResponse({ job: p.job });
      } else {
        sendResponse({ job: null });
      }
    })();
    return true;
  }

  // gusto-submit.js finished the write (via the bridge) → close the exact tab + clear the marker.
  if (msg.type === "zoe-gusto-submit-done") {
    (async () => {
      const p = await getGustoSubmit();
      if (p && sender.tab && sender.tab.id === p.tabId) await reapGustoSubmit(p);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // gusto-submit.js hit a signed-out Gusto → reveal ITS hidden tab for sign-in + DETACH it from the watchdog.
  if (msg.type === "zoe-gusto-submit-reveal") {
    (async () => {
      const p = await getGustoSubmit();
      if (p && sender.tab && sender.tab.id === p.tabId) {
        await detachGustoSubmit();
        try { await chrome.tabs.update(p.tabId, { active: true }); } catch (e) { /* tab gone */ }
        try { if (sender.tab.windowId != null) await chrome.windows.update(sender.tab.windowId, { focused: true }); } catch (e) { /* no window */ }
      }
      sendResponse({ ok: true });
    })();
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

  // On-demand create drain: the Zoe app just queued a guided-intake create and wants it made NOW, not on
  // the next alarm. Reuse the SAME drainCreates flow; reply so the app can tell "office browser got it" from
  // "extension absent / drain disabled". Never opens a login tab — a signed-out GS leaves the op pending and
  // the read-pull's handshake handles sign-in nudging.
  if (msg.type === "zoe-create-now") {
    (async () => {
      const { createDrainEnabled } = await cfg();
      drainCreates("ondemand").catch(() => {});
      sendResponse({ ok: true, createDrainEnabled });
    })();
    return true;
  }

  // On-demand general-outbox drain: the Zoe app just queued a write (e.g. a delivery-fee push) and wants it
  // applied NOW, not on the next read-pull. Reuse the SAME content-script drain (no parallel drain here) —
  // drainOutboxNow checks the outbox and nudges a pull only when something actionable is pending. Reply with
  // the outcome so the app can show honest state ("office browser got it" vs "extension absent / disabled").
  if (msg.type === "zoe-drain-now") {
    (async () => {
      const r = await drainOutboxNow("ondemand").catch(() => ({ ok: false, enabled: true, pending: 0, nudged: false }));
      sendResponse(r);
    })();
    return true;
  }

  if (msg.type === "zoe-sync-now") {
    (async () => {
      // On login to Zoe Ops the user wants current data now, so run a full sweep (superset of active).
      const r = await runPullCycle("handshake", "full");
      const ls = await lastRunStatus();
      // Only nudge a login when we have a RECENT, authoritative signed-out reading — never on unknown.
      if (ls.status === "not_logged_in" && ls.ageMs < 60 * 60 * 1000) await openLoginTab();
      sendResponse({ ok: true, pull: r, last: ls });
    })();
    return true;
  }

  // On-demand payroll sync: open one Gusto tab, pull once, close it when the snapshot posts. Gusto is NOT
  // on the 10-min loop — this is the only thing that opens an app.gusto.com tab now.
  if (msg.type === "zoe-gusto-sync") {
    (async () => {
      const r = await startGustoSync("handshake").catch(() => ({ ok: false, reason: "error" }));
      sendResponse({ ok: true, sync: r });
    })();
    return true;
  }

  // On-demand DRAFT hours PUSH: the Zoe app (owner/admin, after building the payload) hands us the entries to
  // write into the current Gusto draft. We open one hidden Gusto tab; gusto-push.js writes the DRAFT only and
  // never submits payroll. This is the only thing besides the sync that opens an app.gusto.com tab.
  if (msg.type === "zoe-gusto-push") {
    (async () => {
      const r = await startGustoPush(msg.payload).catch(() => ({ ok: false, reason: "error" }));
      sendResponse({ ok: true, push: r });
    })();
    return true;
  }

  // On-demand payroll SUBMIT (IRREVERSIBLE): the Zoe app (Admin, after the hard confirm) hands us the submit
  // context. We open one hidden Gusto tab; gusto-submit.js runs SubmitDraftPayroll WIRE ONLY and never an
  // ACH rail. Human-triggered only — nothing on a loop ever sends this.
  if (msg.type === "zoe-gusto-submit") {
    (async () => {
      const r = await startGustoSubmit("submit", msg.payload).catch(() => ({ ok: false, reason: "error" }));
      sendResponse({ ok: true, submit: r });
    })();
    return true;
  }

  // On-demand wire CONFIRM: after the human wired the funds from Mercury. We open one hidden Gusto tab;
  // gusto-submit.js runs WireInInstructions then ConfirmWireIn. Human-triggered only.
  if (msg.type === "zoe-gusto-confirm-wire") {
    (async () => {
      const r = await startGustoSubmit("confirm_wire", msg.payload).catch(() => ({ ok: false, reason: "error" }));
      sendResponse({ ok: true, confirmWire: r });
    })();
    return true;
  }

  sendResponse({ ok: false, error: "unknown_message" });
  return true;
});

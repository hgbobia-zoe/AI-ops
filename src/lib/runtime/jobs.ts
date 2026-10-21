// Cloud runtime — the registry of integration jobs and the server-side runner. The goal: run every
// integration UNATTENDED from the cloud (Fly), scheduled by GitHub Actions (an off-machine clock), so
// nothing depends on the office machine being on. Each job declares its "bucket":
//   • server  — the Fly server can reach it directly (API/cookie). The runtime runs these.
//   • browser — blocked from datacenter IPs (Goodshuffle/Cloudflare). Needs a logged-in browser; today
//               the office extension, later a cloud browser behind a residential proxy. The runtime does
//               NOT run these server-side — it only surfaces their freshness so the gap is visible.
//
// Runs are recorded in the existing import ledger (logImport) so status reuses /admin/health's data —
// no new table. HONEST: a job with no credential is skipped and shown as "not configured", never faked.

import { getInstaworkShifts, instaworkConfigured } from "@/lib/instawork/client";
import { INSTAWORK_STALE_MIN } from "@/lib/instawork/store";
import { runInstaworkMonitor } from "@/lib/instawork/monitor";
import { slackNotify } from "@/lib/notify/slack";
import { discover } from "@/lib/seo/discovery";
import { configured as ubersuggestConfigured } from "@/lib/seo/ubersuggest";
import { connecteamConfigured, refreshConnecteamHealth, warmConnecteamCaches } from "@/lib/connecteam";
import { getPayrollConfig } from "@/lib/payroll/config";
import { runScheduledPayrollSyncIfDue, runScheduledPrecheckIfDue } from "@/lib/payroll/scheduler";
import { runShiftLifecycleTick } from "@/lib/scheduling/lifecycleTick";
import { runConnecteamImportTick, connecteamImportEnabled } from "@/lib/scheduling/connecteamReconcile";
import { runRouteAutoSyncTick, connecteamAutosyncEnabled } from "@/lib/scheduling/routeAutoSync";
import { runPeopleLifecycleTick } from "@/lib/people/lifecycleTick";
import { scanImprovementSignals, openFromSignal } from "@/lib/ai/improvement/signals";
import { selfAuditAutoOpen } from "@/lib/ai/improvement/config";
import { runPreCheckAlerts } from "@/lib/scheduling/preCheckNotify";
import { runWorkerPacketsTick } from "@/lib/scheduling/workerPackets";
import { runEtaPreMintTick } from "@/lib/eta/preMintTick";
import { runScan } from "@/lib/risk/scan";
import { runSalesAiJob, salesAiEnabled } from "@/lib/salesos/salesAiJob";
import { syncActiveLeadTextThreads } from "@/lib/comms/openphoneSync";
import { runActionItemsJob, actionItemsConfigured } from "@/lib/salesos/actionItems";
import { openphoneApiKey } from "@/lib/comms/openphone";
import { runEsignCutoffSweep, esignCutoffEnabled } from "@/lib/salesos/esignCutoff";
import { getRiskQueue } from "@/lib/risk/store";
import { responderHealthNow, recordJobAlert, formatAge } from "@/lib/ai/responderHealth";
import { runOutboxHealthTick } from "@/lib/aiorg/outboxHealth";
import { runExceptionResolutionTick } from "@/lib/exceptions/engine";
import { countPendingInstructions } from "@/lib/ai/sessions";
import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import { logImport, getLatestImportBySource, recordInstaworkProbe, type ImportRow } from "@/lib/pull/state";

export type RuntimeBucket = "server" | "browser";

export interface RuntimeJob {
  key: string; // also the import-ledger source key
  label: string;
  bucket: RuntimeBucket;
  configured: () => boolean;
  note?: string;
  /** Present for server jobs; returns a success flag + a short human detail. */
  run?: () => Promise<{ ok: boolean; detail: string }>;
}

export const RUNTIME_JOBS: RuntimeJob[] = [
  {
    key: "instawork",
    label: "Instawork shifts",
    bucket: "server",
    configured: instaworkConfigured,
    note: "Reads booked temp-labor shifts from the browser-pulled snapshot (Auto-Pull extension).",
    run: async () => {
      // Reads the browser-pulled snapshot (no network). Freshness = how recently the extension stored it;
      // once-fresh then stale (or never pulled) → the session likely signed out in the office browser.
      const r = await getInstaworkShifts();
      const ageMin = (Date.now() - Date.parse(r.fetchedAt)) / 60_000;
      const isFresh = r.ok && Number.isFinite(ageMin) && ageMin <= INSTAWORK_STALE_MIN;
      const detail = r.ok
        ? isFresh
          ? `${r.shifts.length} shifts`
          : `snapshot ${Math.round(ageMin)}m old — re-open Instawork in the office browser`
        : "no snapshot yet — log into Instawork in the office browser";
      // Slack once on a fresh→stale flip and once on recovery (2h-deduped in recordInstaworkProbe).
      const { alert } = recordInstaworkProbe(isFresh, detail);
      if (alert) void slackNotify(alert);
      if (!isFresh) return { ok: false, detail };
      // Monitor for no-shows / drop-offs: a booked worker disappearing near/after a gig's start →
      // Slack. (Instawork's API has no no-show field; a removed worker is the signal.)
      const alerts = runInstaworkMonitor(r.shifts);
      for (const a of alerts) await slackNotify(a);
      return { ok: true, detail: `${r.shifts.length} shifts${alerts.length ? ` · ${alerts.length} drop alert${alerts.length === 1 ? "" : "s"}` : ""}` };
    },
  },
  {
    key: "ubersuggest",
    label: "Ubersuggest discovery (SEO)",
    bucket: "server",
    configured: ubersuggestConfigured,
    note: "Pulls keyword opportunities for the SEO engine.",
    run: async () => {
      const r = await discover();
      if (!r.configured) return { ok: false, detail: "not configured" };
      return { ok: r.errors === 0, detail: `${r.created} new, ${r.updated} updated${r.errors ? `, ${r.errors} errors` : ""}` };
    },
  },
  {
    key: "connecteam",
    label: "Connecteam crew",
    bucket: "server",
    configured: connecteamConfigured,
    note: "Confirms the crew schedule is reachable and warms the team + scheduler caches so pages and shift publishes serve from cache (no live wait).",
    run: async () => {
      // Warm the read caches (batched) alongside the health probe, so the next render/publish is instant.
      const [h] = await Promise.all([refreshConnecteamHealth(), warmConnecteamCaches()]);
      return { ok: h.ok, detail: h.detail };
    },
  },
  {
    key: "connecteam-sync",
    label: "Connecteam two-way sync (import)",
    bucket: "server",
    configured: connecteamImportEnabled,
    note: "Reconciles Connecteam shifts INTO Dispatch (Lisa's workflow): creates an app shift for each published Connecteam shift with no app copy, updates linked ones when Connecteam changed, and flags a both-sides conflict or a vanished Connecteam copy for review. Idempotent + honest: a Connecteam outage skips the day (never wipes app shifts). No new Connecteam writes — the app->Connecteam push stays the human-gated publish path.",
    run: async () => {
      const r = await runConnecteamImportTick();
      return { ok: r.ok, detail: r.detail };
    },
  },
  {
    key: "connecteam-route-sync",
    label: "Connecteam route auto-sync (assign + create)",
    bucket: "server",
    configured: connecteamAutosyncEnabled,
    note: "Keeps the Dispatch route roster and the Connecteam schedule consistent BOTH ways. Connecteam->route: a person scheduled for a route role is AUTO-ASSIGNED to the matching route when the match is unambiguous (one eligible route); ambiguous matches fall back to the one-click prompt. Route->Connecteam: a route assignee with no Connecteam shift that day gets one created SILENTLY (notifyUsers=false), its id stored so the import reconcile adopts it (no duplicate). Idempotent (dedupe by connecteam_shift_id), outage-safe (unreachable -> skip, never wipe/duplicate), kill-switchable (CONNECTEAM_AUTOSYNC_DISABLED=1). A mixed-presence route shift is flagged needs_review, never auto-written.",
    run: async () => {
      const r = await runRouteAutoSyncTick();
      return { ok: r.ok, detail: r.detail };
    },
  },
  {
    key: "shift-lifecycle",
    label: "Shift lifecycle + exceptions",
    bucket: "server",
    configured: () => true, // app-owned (reads whatever integrations are configured; safe when none are)
    note: "Recomputes shift readiness, advances lifecycle states, mirrors Connecteam timesheets (read-only), reconciles Instawork fills, and persists the exception queue. No sends, no external writes.",
    run: async () => {
      const r = await runShiftLifecycleTick();
      return { ok: r.ok, detail: r.detail };
    },
  },
  {
    key: "payroll-sync",
    label: "Payroll auto-sync (Connecteam → review)",
    bucket: "server",
    configured: () => getPayrollConfig().autoSyncEnabled && connecteamConfigured(),
    note: "On the configured day/hour (default Mondays 8am ET): pull Connecteam hours, reconcile, create the Payroll Review and notify. Never auto-pushes to Gusto; only auto-approves when clean AND policy allows.",
    run: async () => {
      const r = await runScheduledPayrollSyncIfDue();
      return { ok: true, detail: r.detail }; // "waiting"/"already ran" are healthy no-ops, not failures
    },
  },
  {
    key: "payroll-precheck",
    label: "Payroll readiness pre-check",
    bucket: "server",
    configured: () => getPayrollConfig().precheckEnabled && connecteamConfigured(),
    note: "Ahead of the Tuesday payroll deadline (default Mondays 8am ET) and again on payroll day: assesses the just-completed week's readiness — unapproved timesheets, missing punches, schedule discrepancies, missing/duplicate Gusto mappings, stale/unavailable sources — persists exceptions, and posts an idempotent readiness summary to the dedicated payroll Slack channel. READ-ONLY; never submits payroll. UNAVAILABLE/stale data can never read as READY.",
    run: async () => {
      const r = await runScheduledPrecheckIfDue();
      return { ok: true, detail: r.detail }; // "waiting"/"already ran" are healthy no-ops, not failures
    },
  },
  {
    key: "route-precheck",
    label: "Route staffing pre-check",
    bucket: "server",
    configured: () => true, // app-owned; a no-op (and silent) on days with no present routes to staff
    note: "Ahead of the debrief send window, checks each present route has its required crew ASSIGNED in the app (a Connecteam schedule is not coverage). Alerts the ops channel for any gap with the candidates to assign, deduped with a 2h cool-off, and a recovered note when it clears. Additively nudges when crew scheduled in Connecteam aren't on a route yet (assign them in Scheduling), deduped day-level with the same cool-off. Never nags a day with no routes.",
    run: async () => {
      // Look a couple of days ahead so the alert fires with lead time to assign crew (or mark it done).
      const today = todayInOpsTz();
      const days = [today, shiftYmd(today, 1), shiftYmd(today, 2)];
      let checked = 0;
      let gaps = 0;
      let alerted = 0;
      let recovered = 0;
      let scheduledUnrouted = 0;
      let nudged = 0;
      for (const d of days) {
        const r = await runPreCheckAlerts(d);
        checked += r.routesChecked;
        gaps += r.gaps;
        alerted += r.alerted;
        recovered += r.recovered;
        scheduledUnrouted += r.scheduledUnrouted;
        nudged += r.nudged;
      }
      const detail = checked === 0 ? "no routes to staff" : `${checked} routes, ${gaps} gap${gaps === 1 ? "" : "s"}, ${alerted} alerted${recovered ? `, ${recovered} recovered` : ""}${scheduledUnrouted ? `, ${scheduledUnrouted} scheduled-unrouted${nudged ? ` (${nudged} nudged)` : ""}` : ""}`;
      return { ok: true, detail };
    },
  },
  {
    key: "prep-opportunity",
    label: "Tomorrow prep-window sweep",
    bucket: "server",
    configured: () => true, // app-owned; a silent no-op on days with no tomorrow routes
    note: "End-of-day backstop for Operational Opportunity detection: runs the risk scan (which includes the prep-window rule, event/prepOpportunity.ts) with the real clock so a feasible-but-unloaded window for tomorrow's trucks is caught even if no route-completion trigger fired. Distinguishes open vs threatened vs missed. Never asserts a truck is unloaded (no loading telemetry) — flags the UNVERIFIED window.",
    run: async () => {
      const r = await runScan({ force: true });
      const opp = getRiskQueue().filter((x) => x.category === "OPPORTUNITY");
      const n = (t: string) => opp.filter((x) => x.riskType === t).length;
      const open = n("prep_window_open");
      const threatened = n("prep_window_threatened");
      const missed = n("prep_window_missed");
      const detail =
        opp.length === 0
          ? r.throttled
            ? "scan throttled; no open prep windows"
            : "no open prep windows for tomorrow"
          : `${open} open, ${threatened} threatened, ${missed} missed`;
      return { ok: true, detail };
    },
  },
  {
    key: "etalink-premint",
    label: "Live-tracking link pre-mint (Ignition)",
    bucket: "server",
    configured: () => true, // app-owned; a no-op when there's nothing to mint or minting is disabled
    note: "Mints Ignition customer-tracking links for upcoming stops ahead of departure (while the office Ignition session is fresh), and alerts if that session has lapsed. The extension drains the queued mints — no extension change.",
    run: async () => {
      const r = await runEtaPreMintTick();
      return { ok: r.ok, detail: r.detail };
    },
  },
  {
    key: "people-lifecycle",
    label: "People lifecycle (onboarding / offboarding)",
    bucket: "server",
    configured: () => true, // app-owned; a silent no-op when no employee needs onboarding/offboarding today
    note: "Fires start-date onboarding, executes future-dated terminations (auto-revokes the Zoe login only), and escalates overdue manual access tasks to Slack. Never auto-completes a manual revoke — OFFBOARDED never implies access removed.",
    run: async () => {
      const r = await runPeopleLifecycleTick();
      return { ok: r.ok, detail: r.detail };
    },
  },
  {
    key: "self-audit",
    label: "Self-improvement audit",
    bucket: "server",
    configured: () => true, // app-owned; a no-op surfacing 0 candidates when nothing is failing
    note: "Scans the app's OWN failure signals (recurring audit-log failures, failed server jobs) and surfaces improvement candidates. Opens SCOPED, human-supervised improvement runs only when self-audit auto-open is enabled (default OFF). Never ships — the autonomy switches stay off; opening a run just files work for the responder/human, deduped so a re-scan can't double-open.",
    run: async () => {
      const signals = scanImprovementSignals();
      const openable = signals.filter((s) => s.autoOpenable).length;
      if (!selfAuditAutoOpen()) {
        return { ok: true, detail: `${signals.length} candidate${signals.length === 1 ? "" : "s"} (${openable} auto-openable) — auto-open OFF` };
      }
      let opened = 0;
      let skipped = 0;
      for (const s of signals) {
        if (openFromSignal(s).opened) opened++;
        else skipped++;
      }
      return { ok: true, detail: `${signals.length} candidates, ${opened} opened, ${skipped} skipped` };
    },
  },
  {
    key: "sales-ai",
    label: "Sales AI (Jessie's team)",
    bucket: "server",
    configured: () => true, // app-owned; a healthy no-op until SALES_AI_ENABLED is flipped on
    note: "Proactive, LLM-backed sales work on the RUNTIME_TOKEN cadence, gated by SALES_AI_ENABLED (default OFF). When on: the Quote/Opportunity Analyst runs the LLM reviewQuote over the top open quotes (records insights, Slacks flagged ones); Lost Quote + Outreach produce human-gated APPROVAL CARDS from their LLM drafts; Lead Intelligence Slacks a deduped nudge for hot high-value act-now leads; Sales Coach drains the call-recap backlog. ANALYSIS/DRAFTS/PROPOSALS only — every send/price/commit stays behind ai_approvals -> gs_outbox + EMAIL_SEND_ENABLED/SMS_SEND_ENABLED. Bounded (top-N + thresholds), self-throttled to a few runs/day, Slack-deduped (2h). Honest: skips + logs when the LLM is unreachable.",
    run: async () => {
      const r = await runSalesAiJob();
      return { ok: r.ok, detail: salesAiEnabled() ? r.detail : "SALES_AI_ENABLED off — inert" };
    },
  },
  {
    key: "esign-cutoff",
    label: "E-signature cutoff (disable online signing pre-event)",
    bucket: "server",
    configured: () => true, // app-owned; a healthy no-op until ESIGN_CUTOFF_ENABLED is flipped on
    note: "Disables ONLINE signing N business days before the event (default 3, Mon-Fri; holidays out of scope) so contracts sign IN PERSON, not last-minute online. Each UNSIGNED, non-archived project that crosses the business-day window gets ONE Goodshuffle disable_esignature write queued (idempotent, once per project) and a Sales-bot update in sales-ai. OFF BY DEFAULT (ESIGN_CUTOFF_ENABLED): the GS disable endpoint is an uncaptured CAPTURE-NEEDED stub, so the op does NOT execute a fabricated request (it sits pending), and the announcement says the window was entered / signing is being turned off (PENDING) and is reversible / in-person signing still works, never claiming it is already off until the op CONFIRMS. 'online signature enabled' is proxied by signed=0 (unobservable toggle). Outage-safe, dedupes so it only acts as a project crosses the threshold.",
    run: async () => {
      const r = await runEsignCutoffSweep();
      return { ok: r.ok, detail: esignCutoffEnabled() ? r.detail : "ESIGN_CUTOFF_ENABLED off — inert" };
    },
  },
  {
    key: "responder-health",
    label: "AI responder health (fail-loud)",
    bucket: "server",
    configured: () => true, // app-owned; a silent no-op when the responder is healthy or has no pending work
    note: "Backstop for the Slack-reactive alert: each tick, if the office-machine responder has gone stale (no recent heartbeat) AND there is pending Viktor/session work waiting, Slack the ops channel so someone starts it. Deduped with a 2h cool-off, with a one-shot recovered note when it comes back. Never alarms when the queue is empty (nothing is waiting) or the responder is alive.",
    run: async () => {
      const health = responderHealthNow();
      const pending = countPendingInstructions();
      // Only "down" when the responder is not alive AND work is actually waiting — a stale responder with an
      // empty queue is harmless (nothing is being dropped), so we never nag about it.
      const down = !health.alive && pending > 0;
      const { alert } = recordJobAlert(down);
      if (alert === "down") {
        void slackNotify(
          `⚠️ AI responder is DOWN with work waiting: ${pending} instruction${pending === 1 ? "" : "s"} queued and no heartbeat in ${formatAge(health.ageMs)}. Start the responder (a Claude Code session running scripts/responder/loop.md via /loop 60s).`,
        );
      } else if (alert === "recovered") {
        void slackNotify("✅ AI responder is back (heartbeating again). The queued instructions will drain.");
      }
      const detail = health.alive
        ? "responder alive"
        : pending > 0
          ? `responder ${health.state} (last ${formatAge(health.ageMs)}), ${pending} pending`
          : `responder ${health.state} but queue empty`;
      return { ok: health.alive || pending === 0, detail };
    },
  },
  {
    key: "worker-packets",
    label: "Auto worker debriefs (shift packets)",
    bucket: "server",
    configured: () => true, // app-owned; a healthy no-op until AUTO_PACKET_ENABLED is set (see detail)
    note: "Fires the DUE, UNSENT shift-packet touches (on_assign / day_before / refresher) to each live assignment, so a worker's debrief no longer waits on a human tapping Send. OFF BY DEFAULT: requires its own master switch AUTO_PACKET_ENABLED=true ON TOP OF SHIFT_COMMS_ENABLED and SMS_SEND_ENABLED; with any off it sends nothing. Strictly idempotent — each touch is sent at most once ever per assignment (per-(assignment,touch) change_key), so the 15-min tick never re-texts. Respects the Route Staffing Pre-Check (an unstaffed route's debrief is HELD) and only sends when a touch is actually due (on_assign once provisioned; day_before ~18h out; refresher ~1h out), never for past/cancelled shifts. Instawork temps have no captured phone, so they are skipped (never auto-texted, never a silent failure).",
    run: async () => {
      const r = await runWorkerPacketsTick();
      return { ok: r.ok, detail: r.detail };
    },
  },
  {
    key: "outbox-health",
    label: "Write-back outbox health (did-it-land)",
    bucket: "server",
    configured: () => true, // app-owned; a silent no-op when the outbox is clear
    note: "Watches the Goodshuffle write-back outbox (where every approved email/note/task queues until the office Auto-Pull drains it). Alerts the ops channel, deduped with a 2h cool-off + recovered note, when the oldest pending op goes stale (drainer likely down), the queue backs up, an op dead-letters (bounded retries exhausted), or an op of a type no drainer handles is stuck. Deterministic; reconciliation of a delivered op back to its approval happens in the ack path, not here.",
    run: async () => {
      const r = await runOutboxHealthTick();
      return { ok: r.ok, detail: r.detail };
    },
  },
  {
    key: "exception-resolution",
    label: "Exception resolution (cross-agent coordination)",
    bucket: "server",
    configured: () => true, // app-owned; a silent no-op when there are no open exceptions
    note: "Victor's coordination layer over the EXISTING exception surfaces (Event Risk Engine risk_items + the write-back dead-letter backlog). Each tick it dedupes every detected exception into one record, routes a DETERMINISTIC resolution — propose a human-gated Goodshuffle task via the shared approval→outbox path, delegate to the owning team role, or escalate — then VERIFIES any in-flight resolution via WS03's getApprovalLifecycle: a confirmed landing marks it resolved (with evidence), a dead-letter marks it failed, and failed/overdue/repeatedly-failing/high-impact items escalate (team channel first, owner only on defined criteria), all 2h-deduped. It NEVER executes money/schedule/hiring actions (those delegate), never silently marks-done (resolved needs a verified landing or a human disposition), and treats a disappeared signal as unverifiable, not resolved.",
    run: async () => {
      const r = await runExceptionResolutionTick();
      return { ok: r.ok, detail: r.detail };
    },
  },
  {
    key: "openphone-message-sync",
    label: "OpenPhone SMS sync (two-way text history)",
    bucket: "server",
    configured: () => !!openphoneApiKey(),
    note: "Keeps the sales timeline's two-way SMS history complete via the OpenPhone API, independent of the webhook: BACKFILLS past texts a webhook could never recover and captures texts sent/received NATIVELY in Quo that the app never recorded. Syncs the active/open pipeline leads with a phone on file (reuses getPipelineLeads; unsigned leads first, capped per run so we don't hammer the API), one lead at a time. Every message upserts into comms_events keyed by its OpenPhone message id (provider_id UNIQUE), so it dedupes against the webhook, the app's own sender, and prior runs — running both paths never double-counts. FACTS ONLY: inserts exactly what the API returns, never a synthesized message. Key-gated (no-op without an OpenPhone API key), bounded, best-effort (one lead failing never aborts the rest), never throws into the tick.",
    run: async () => {
      const r = await syncActiveLeadTextThreads();
      return { ok: true, detail: `${r.leads} lead${r.leads === 1 ? "" : "s"} synced, ${r.inserted} new message${r.inserted === 1 ? "" : "s"}` };
    },
  },
  {
    key: "sales-action-items",
    label: "Customer action-item detection (open asks)",
    bucket: "server",
    configured: actionItemsConfigured,
    note: "Catches the asks a customer raised that still need a human response (e.g. 'strike paragraph 24 of the T&C', 'difference between a 500 vs 300 lb block?') so the AI's follow-ups stop missing them. Per active/quote-sent lead: syncs the current two-way thread on demand, then an LLM extracts the OPEN customer asks (contract-change / pricing / product / scheduling / decision / objection) — quoting the customer's OWN words, never inventing an ask — and surfaces them as a deduped Slack alert to the sales channel plus a persisted per-lead record the outreach context can read. RULES CALCULATE (gather/dedupe/resolve/gate deterministic), AI INTERPRETS (the extraction). DETECT + SURFACE ONLY: never drafts or sends a reply; an item auto-clears only on a real signal (a later outbound after the ask), else it stays open. Gated by LLM + OpenPhone key, bounded to the busiest conversations, self-throttled (default once/60m), outage-safe (skips + logs when the LLM is unreachable; one lead failing never aborts the run).",
    run: async () => {
      const r = await runActionItemsJob();
      return { ok: r.ok, detail: r.detail };
    },
  },
  {
    key: "route",
    label: "Goodshuffle routes + bookings",
    bucket: "browser",
    configured: () => true,
    note: "Cloudflare blocks datacenter IPs — runs from a logged-in browser (office extension today; cloud browser behind a residential proxy is the planned cloud-runtime path).",
  },
];

export interface JobRunResult {
  key: string;
  ok: boolean;
  detail: string;
  ms: number;
}

/** Run every CONFIGURED server job once, recording each to the import ledger. Never throws. */
export async function runServerJobs(): Promise<JobRunResult[]> {
  const out: JobRunResult[] = [];
  for (const job of RUNTIME_JOBS) {
    if (job.bucket !== "server" || !job.run || !job.configured()) continue;
    const t = Date.now();
    try {
      const r = await job.run();
      logImport(job.key, r.ok, { detail: r.detail });
      out.push({ key: job.key, ok: r.ok, detail: r.detail, ms: Date.now() - t });
    } catch (e) {
      const detail = e instanceof Error ? e.message : "error";
      logImport(job.key, false, { detail });
      out.push({ key: job.key, ok: false, detail, ms: Date.now() - t });
    }
  }
  return out;
}

export type JobState = "ok" | "stale" | "error" | "not_configured" | "browser_pending" | "never";

export interface JobStatus {
  key: string;
  label: string;
  bucket: RuntimeBucket;
  configured: boolean;
  state: JobState;
  lastRunAt: string | null;
  lastDetail: string | null;
  note?: string;
}

/** Hours after which a successful server job is considered stale (for the status view). */
export const RUNTIME_STALE_HOURS = 24;

/**
 * Current status of every job, from the credential state + the import ledger. Pure given `ledger`+`now`,
 * so it's unit-testable. Browser jobs report their own freshness but are flagged browser_pending (the
 * runtime can't run them server-side yet).
 */
export function computeJobStatus(
  ledger: Record<string, ImportRow>,
  now: number = Date.now(),
  jobs: RuntimeJob[] = RUNTIME_JOBS,
): JobStatus[] {
  return jobs.map((job) => {
    const row = ledger[job.key] ?? null;
    const lastRunAt = row?.ts ?? null;
    const lastDetail = row?.detail ?? null;
    const ageH = lastRunAt ? (now - Date.parse(lastRunAt)) / 3_600_000 : Infinity;
    const configured = job.configured();

    let state: JobState;
    if (job.bucket === "browser") state = "browser_pending";
    else if (!configured) state = "not_configured";
    else if (!row) state = "never";
    else if (!row.ok) state = "error";
    else if (ageH > RUNTIME_STALE_HOURS) state = "stale";
    else state = "ok";

    return { key: job.key, label: job.label, bucket: job.bucket, configured, state, lastRunAt, lastDetail, note: job.note };
  });
}

/** Convenience: status from the live ledger. */
export function runtimeStatus(): JobStatus[] {
  return computeJobStatus(getLatestImportBySource());
}

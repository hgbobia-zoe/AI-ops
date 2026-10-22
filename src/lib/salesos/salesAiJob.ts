// Sales AI runtime job — the "real work" layer for Jessie's team. On the RUNTIME_TOKEN cadence it runs
// each sales employee's GENUINE analysis over LIVE data and surfaces it, while every ACTION stays behind
// the EXISTING approval gate (ai_approvals -> gs_outbox) and the send master-switches. It REUSES the
// existing engines — it builds nothing new:
//   • Quote / Opportunity Analyst → runs the LLM reviewQuote over the top open quotes, records each
//     insight (quoteInsights, auditable), and Slacks a deduped nudge for the flagged ones.
//   • Lost Quote → proposeLostQuoteApprovals() (LLM win-back drafts) as APPROVAL CARDS, scheduled.
//   • Outreach → proposeOutreachApprovals() (LLM outreach drafts) as APPROVAL CARDS, scheduled.
//   • Lead Intelligence → deterministic: Slacks a deduped nudge for hot, high-value, act-now leads.
//   • Sales Coach → drains the unanalyzed call backlog (analyzeCall) so LLM recaps actually run.
//
// GOVERNING LAW (non-negotiable): the AI produces ANALYSIS / DRAFTS / PROPOSALS only. It NEVER auto-sends,
// auto-prices, or auto-commits. Approvals/outbox + EMAIL_SEND_ENABLED/SMS_SEND_ENABLED remain the gates.
//
// SAFE BY CONSTRUCTION:
//   • The whole job is gated by SALES_AI_ENABLED (default OFF) — wired + tested but inert until the owner
//     flips it, mirroring SHIFT_COMMS_ENABLED. Flipping it off is also the kill switch.
//   • LLM calls are bounded (top-N by value + value/age thresholds) and the job self-throttles to a few
//     runs/day regardless of tick cadence, so cost stays small (Haiku via llm.ts default).
//   • Slack posts are deduped with a 2h cool-off + content signature (a few high-signal nudges, not noise).
//   • Idempotent: proposers dedupe by changeKey; quote insights dedupe by lead; nudges dedupe by signature.
//   • Honest: when the LLM/integration is unreachable it SKIPS and logs — never fabricates.

import { getJson, setJson } from "@/lib/kv";
import { todayInOpsTz } from "@/lib/dates";
import { getOpenLeads } from "@/lib/db/repo";
import { toLeadView, salesLeads, type LeadView } from "./service";
import type { SalesStage, ActionUrgency } from "./calc";
import { STAGE_LABEL } from "./calc";
import { reviewQuote } from "@/lib/quoteReview";
import { llmConfigured } from "@/lib/llm";
import { proposeLostQuoteApprovals, proposeOutreachApprovals } from "@/lib/aiorg/proposers";
import { listUnanalyzedCoachableCalls } from "@/lib/db/repo";
import { analyzeCall } from "@/lib/coach/analyze";
import { botAnnounce, appUrl } from "@/lib/notify/aiBots";
import { recordQuoteInsight } from "./quoteInsights";
import { logSalesEventBy } from "./audit";
import { getSettings, businessHoursGate } from "@/lib/settings";

// ── Master switch + bounds (env, with safe defaults) ─────────────────────────────

/** The master switch. Mirrors shiftCommsEnabled(): nothing runs until this is explicitly "true". */
export function salesAiEnabled(): boolean {
  return process.env.SALES_AI_ENABLED === "true";
}

function numEnv(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** Bounds — small by default so the LLM spend stays a few cents/day. Tunable without a redeploy. */
export const SALES_AI_BOUNDS = {
  quoteMinValue: () => numEnv("SALES_AI_QUOTE_MIN_VALUE", 5000),
  quoteMinAgeDays: () => numEnv("SALES_AI_QUOTE_MIN_AGE_DAYS", 7),
  quoteTopN: () => numEnv("SALES_AI_QUOTE_TOP_N", 5),
  leadMinValue: () => numEnv("SALES_AI_LEAD_MIN_VALUE", 10000),
  leadTopN: () => numEnv("SALES_AI_LEAD_TOP_N", 5),
  coachBacklogN: () => numEnv("SALES_AI_COACH_BACKLOG", 5),
  /** Self-throttle: LLM work runs at most once per this many minutes, even if the tick fires every 15. */
  minIntervalMin: () => numEnv("SALES_AI_MIN_INTERVAL_MIN", 360),
};

/** Slack dedupe window — matches the repo's other alert producers' 2h cool-off. */
export const SALES_AI_ALERT_COOLOFF_MS = 2 * 60 * 60 * 1000;

// ── Pure selection + dedupe helpers (unit-tested, no DB / no clock dependency) ────

export interface QuoteCandidate {
  id: string;
  value: number | null;
  quoteAgeDays: number | null;
  stage: SalesStage;
  itemCount: number; // captured line-item titles; 0 ⇒ nothing to review (skip)
}

/** Pick the quotes worth an LLM review: above a value floor, with line items to review, and either aged
 *  past the staleness floor or inside the closing window. Biggest first, capped at topN. PURE + total. */
export function selectQuoteReviewTargets(
  cands: QuoteCandidate[],
  opts: { minValue: number; minAgeDays: number; topN: number },
): QuoteCandidate[] {
  return cands
    .filter((c) => c.value != null && c.value >= opts.minValue && c.itemCount > 0)
    .filter((c) => c.stage === "closing" || (c.quoteAgeDays != null && c.quoteAgeDays >= opts.minAgeDays))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, Math.max(0, opts.topN));
}

export interface LeadCandidate {
  id: string;
  clientName: string;
  value: number | null;
  urgency: ActionUrgency;
  quoteAgeDays: number | null;
  stage: SalesStage;
}

/** Deterministic: hot, high-value leads the worklist says to act on NOW. Biggest first, capped. PURE. */
export function selectHotLeads(cands: LeadCandidate[], opts: { minValue: number; topN: number }): LeadCandidate[] {
  return cands
    .filter((c) => c.urgency === "now" && c.value != null && c.value >= opts.minValue)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, Math.max(0, opts.topN));
}

export interface AlertMemo {
  sig?: string;
  lastAlertedAt?: string;
}

/** PURE. Post iff there's something to say AND (the content signature changed OR the cool-off elapsed).
 *  So an unchanged nudge stays quiet for 2h, but a materially different one posts right away. */
export function decideSignatureAlert(
  prev: AlertMemo | undefined,
  sig: string,
  now: number,
  cooloffMs: number = SALES_AI_ALERT_COOLOFF_MS,
): { alert: boolean; next: AlertMemo } {
  if (!sig) return { alert: false, next: prev ?? {} };
  const sameSig = prev?.sig === sig;
  const agoMs = prev?.lastAlertedAt ? now - Date.parse(prev.lastAlertedAt) : Infinity;
  if (sameSig && agoMs <= cooloffMs) return { alert: false, next: prev ?? {} };
  return { alert: true, next: { sig, lastAlertedAt: new Date(now).toISOString() } };
}

/** PURE. Should the LLM work run now, given the last run time + the minimum interval? */
export function decideThrottle(lastRunAt: string | undefined, now: number, minIntervalMs: number): boolean {
  if (!lastRunAt) return true;
  const parsed = Date.parse(lastRunAt);
  if (!Number.isFinite(parsed)) return true;
  return now - parsed >= minIntervalMs;
}

// ── Persistent state (kv — throttle clock + per-nudge dedupe memos) ───────────────

const STATE_KEY = "salesai.state";

interface SalesAiState {
  lastRunAt?: string;
  alerts?: Record<string, AlertMemo>;
}

function agentPaused(id: string): boolean {
  try {
    return (getSettings().aiPaused ?? []).includes(id);
  } catch {
    return false;
  }
}

const money = (n: number | null | undefined): string => (n == null ? "an unknown amount" : "$" + Math.round(n).toLocaleString("en-US"));

// ── The orchestrator ──────────────────────────────────────────────────────────

export interface SalesAiRunResult {
  ok: boolean;
  detail: string;
}

/** Run the whole sales-AI pass once. Never throws (each employee step is guarded so one failure degrades
 *  that line honestly, not the whole job). Returns a short human detail for the import ledger. */
export async function runSalesAiJob(now: number = Date.now()): Promise<SalesAiRunResult> {
  if (!salesAiEnabled()) return { ok: true, detail: "disabled (SALES_AI_ENABLED off)" };

  const state = getJson<SalesAiState>(STATE_KEY, {});
  state.alerts = state.alerts ?? {};
  const parts: string[] = [];

  // Sales Coach — behind-the-scenes call-recap analysis. ALWAYS-ON by the owner's decision: it produces no
  // customer-facing output and no recommendation (it just drains the unanalyzed-call backlog into cached
  // recaps), so it runs on EVERY tick, regardless of business hours and independent of the recommendation
  // throttle. Safe to run each tick — listUnanalyzedCoachableCalls skips analyzed/attempted calls and
  // analyzeCall is idempotent, so a drained backlog is a cheap no-op (no LLM).
  parts.push(await safeStep("sales-coach", runSalesCoachBacklog));

  // The CUSTOMER-FACING RECOMMENDATION pass — the Quote / Opportunity Analyst Slack nudges, the Outreach +
  // Lost-Quote approval cards, and the Lead-Intelligence nudge. The owner's rule: no bot recommendations
  // outside business hours. Checked PER STEP here and BEFORE the throttle is claimed, so a held pass does
  // not burn the throttle slot — it simply re-runs on the next in-hours tick (held, not dropped). Each step
  // logs an honest held line.
  const gate = businessHoursGate(new Date(now));
  if (!gate.open) {
    for (const step of ["quote-analyst", "lost-quote", "outreach", "lead-intelligence"]) parts.push(`${step}: ${gate.heldDetail}`);
    setJson(STATE_KEY, state);
    return { ok: true, detail: parts.join(" · ") };
  }

  // In hours: the LLM-heavy recommendation pass self-throttles (cost control) to a few runs/day.
  if (!decideThrottle(state.lastRunAt, now, SALES_AI_BOUNDS.minIntervalMin() * 60_000)) {
    parts.push(`recommendations: throttled (min interval ${SALES_AI_BOUNDS.minIntervalMin()}m)`);
    setJson(STATE_KEY, state);
    return { ok: true, detail: parts.join(" · ") };
  }
  // Claim the throttle slot immediately so an overlapping tick can't double-run the recommendation LLM work.
  state.lastRunAt = new Date(now).toISOString();
  setJson(STATE_KEY, state);

  parts.push(await safeStep("quote-analyst", () => runQuoteAnalyst(state, now)));
  parts.push(await safeStep("lost-quote", runLostQuote));
  parts.push(await safeStep("outreach", runOutreach));
  parts.push(await safeStep("lead-intelligence", () => runLeadIntelligence(state, now)));

  // Persist any alert-memo updates the steps made.
  setJson(STATE_KEY, state);
  return { ok: true, detail: parts.join(" · ") };
}

async function safeStep(label: string, fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    return `${label}: error (${e instanceof Error ? e.message : "unknown"})`;
  }
}

// ── Quote / Opportunity Analyst — the LLM reviewQuote pass over the top open quotes ──
async function runQuoteAnalyst(state: SalesAiState, now: number): Promise<string> {
  if (agentPaused("quote-analyst")) return "quote-analyst: paused";
  if (!llmConfigured()) return "quote-analyst: LLM not configured (skipped)";

  const today = todayInOpsTz();
  const bookings = getOpenLeads(today);
  const byId = new Map(bookings.map((b) => [b.bookingId, b]));
  const cands: QuoteCandidate[] = bookings.map((b) => {
    const lv = toLeadView(b, today);
    return { id: b.bookingId, value: lv.value, quoteAgeDays: lv.signals.quoteAgeDays, stage: lv.stage, itemCount: b.lineItems?.length ?? 0 };
  });

  const targets = selectQuoteReviewTargets(cands, {
    minValue: SALES_AI_BOUNDS.quoteMinValue(),
    minAgeDays: SALES_AI_BOUNDS.quoteMinAgeDays(),
    topN: SALES_AI_BOUNDS.quoteTopN(),
  });
  if (targets.length === 0) return "quote-analyst: no quotes over threshold";

  let reviewed = 0;
  let flaggedCount = 0;
  const flaggedForSlack: { id: string; name: string; value: number | null; risk: string }[] = [];

  for (const t of targets) {
    const b = byId.get(t.id);
    if (!b) continue;
    const items = (b.lineItems ?? []).map((name) => ({ name }));
    const review = await reviewQuote({ eventName: b.eventName, eventDate: b.eventDate ?? undefined, venue: b.venue ?? undefined, items });
    const risks = review.llm?.risks ?? [];
    const flagged = risks.length > 0;
    reviewed += 1;
    if (flagged) flaggedCount += 1;

    recordQuoteInsight({
      leadId: b.bookingId,
      clientName: b.clientName,
      eventName: b.eventName,
      value: t.value,
      eventDate: b.eventDate,
      quoteAgeDays: t.quoteAgeDays,
      stage: t.stage,
      flagged,
      risks,
      notes: review.llm?.notes ?? (review.llm ? "" : review.llmError ? `model unavailable: ${review.llmError}` : "rules only"),
      crew: review.crew,
      model: review.llmModel ?? null,
      at: new Date(now).toISOString(),
    });
    // Auditable trail, attributed to the AI (honest actor label; never a person).
    logSalesEventBy("QUOTE_AI_REVIEWED", b.bookingId, "Quote / Opportunity Analyst (AI)", {
      flagged,
      risks: risks.slice(0, 5),
      crew: review.crew,
      value: t.value,
      model: review.llmModel ?? null,
    });
    if (flagged) flaggedForSlack.push({ id: b.bookingId, name: b.clientName || b.bookingId, value: t.value, risk: risks[0] });
  }

  // One aggregated, deduped Slack nudge for the flagged quotes (not one per quote).
  if (flaggedForSlack.length > 0) {
    const sig = flaggedForSlack.map((f) => f.id).sort().join(",");
    const memo = state.alerts![`quote-analyst`];
    const { alert, next } = decideSignatureAlert(memo, sig, now);
    state.alerts![`quote-analyst`] = next;
    if (alert) {
      const lines = flaggedForSlack
        .map((f) => `• ${f.name} (${money(f.value)}): ${f.risk}`)
        .join("\n");
      void botAnnounce("sales", {
        emoji: "🔎",
        title: `${flaggedForSlack.length} high-value quote${flaggedForSlack.length === 1 ? "" : "s"} to review`,
        body: lines,
        link: { text: "Open Sales OS", url: appUrl("/salesos") },
        context: "Quote Analyst · analysis only, no change was made",
      }).catch(() => {});
    }
  }

  return `quote-analyst: reviewed ${reviewed}, flagged ${flaggedCount}`;
}

// ── Lost Quote + Outreach — scheduled runs of the EXISTING, human-gated proposers ──
async function runLostQuote(): Promise<string> {
  const r = await proposeLostQuoteApprovals();
  return `lost-quote: ${r.created} new win-back${r.created === 1 ? "" : "s"} (${r.candidates} considered)`;
}

async function runOutreach(): Promise<string> {
  const r = await proposeOutreachApprovals();
  return `outreach: ${r.created} new draft${r.created === 1 ? "" : "s"} (${r.candidates} considered)`;
}

// ── Lead Intelligence — deterministic nudge (no LLM), deduped ────────────────────
async function runLeadIntelligence(state: SalesAiState, now: number): Promise<string> {
  if (agentPaused("lead-intelligence")) return "lead-intelligence: paused";
  const overview = salesLeads();
  const minValue = SALES_AI_BOUNDS.leadMinValue();
  const hot = selectHotLeads(
    overview.leads.map((l: LeadView) => ({ id: l.id, clientName: l.clientName, value: l.value, urgency: l.action.urgency, quoteAgeDays: l.signals.quoteAgeDays, stage: l.stage })),
    { minValue, topN: SALES_AI_BOUNDS.leadTopN() },
  );
  if (hot.length === 0) return "lead-intelligence: no hot leads over threshold";

  const sig = hot.map((h) => h.id).sort().join(",");
  const memo = state.alerts![`lead-intelligence`];
  const { alert, next } = decideSignatureAlert(memo, sig, now);
  state.alerts![`lead-intelligence`] = next;
  if (alert) {
    const lines = hot
      .map((h) => `• ${h.clientName || h.id} (${money(h.value)})${h.quoteAgeDays != null ? `, untouched ${h.quoteAgeDays}d` : ""} — ${STAGE_LABEL[h.stage]}`)
      .join("\n");
    void botAnnounce("sales", {
      emoji: "🔥",
      title: `${hot.length} hot lead${hot.length === 1 ? "" : "s"} to act on now`,
      body: lines,
      link: { text: "Open Sales OS", url: appUrl("/salesos") },
      context: `Lead Intelligence · over ${money(minValue)}`,
    }).catch(() => {});
  }
  return `lead-intelligence: ${hot.length} hot lead${hot.length === 1 ? "" : "s"}`;
}

// ── Sales Coach — drain the unanalyzed call backlog so LLM recaps actually run ───
async function runSalesCoachBacklog(): Promise<string> {
  if (agentPaused("sales-coach")) return "sales-coach: paused";
  if (!llmConfigured()) return "sales-coach: LLM not configured (skipped)";
  const batch = listUnanalyzedCoachableCalls(SALES_AI_BOUNDS.coachBacklogN());
  if (batch.length === 0) return "sales-coach: no backlog";
  let analyzed = 0;
  let other = 0;
  for (const c of batch) {
    const r = await analyzeCall(c.id);
    if (r === "analyzed") analyzed += 1;
    else other += 1;
  }
  return `sales-coach: ${analyzed} recap${analyzed === 1 ? "" : "s"}${other ? `, ${other} skipped` : ""}`;
}

// Payroll Slack workflow — routes the readiness pre-check into a DEDICATED payroll channel. This file only
// CALLS the shared Victor/Slack infrastructure (src/lib/notify/*): it builds Block Kit cards with the shared
// cardBlocks() and posts with the shared slackPostAs(), falling back to the ops webhook via slackNotify().
// It does NOT redesign or duplicate that layer, and it never submits payroll.
//
// Channel is resolved from config (never a hard-coded id, spec §Phase-4): SLACK_CHANNEL_PAYROLL env →
// the payroll Settings `slackChannel` → null (then we fall back to the ops webhook). Idempotent (§5): each
// card's content is hashed and we skip a re-post when nothing changed, so a repeated scheduled run does not
// flood the channel.

import { createHash } from "node:crypto";
import { getJson, setJson } from "@/lib/kv";
import { slackPostAs, slackBotConfigured, slackNotify, type BotPersona, type SlackResult } from "@/lib/notify/slack";
import { cardBlocks, appUrl, type BotCard } from "@/lib/notify/aiBots";
import { getPayrollConfig } from "./config";
import { READINESS_STATUS_LABEL, type PayrollReadiness, type ReadinessException } from "./types";

export const PAYROLL_PERSONA: BotPersona = { name: "Payroll Bot", icon: ":money_with_wings:" };

/** The dedicated payroll channel: env override → Settings value → null (no hard-coded id). */
export function payrollChannel(): string | null {
  const env = process.env.SLACK_CHANNEL_PAYROLL?.trim();
  if (env) return env;
  return getPayrollConfig().slackChannel || null;
}

const STATUS_EMOJI: Record<PayrollReadiness["status"], string> = {
  READY: "✅", ACTION_REQUIRED: "⚠️", BLOCKED: "⛔", UNAVAILABLE: "🚫",
};

export type ReadinessPhase = "precheck" | "deadline" | "manual";
const PHASE_LABEL: Record<ReadinessPhase, string> = {
  precheck: "Payroll readiness pre-check",
  deadline: "Final Tuesday payroll check",
  manual: "Payroll readiness",
};

/** The readiness summary as a designed card (built with the shared cardBlocks). */
export function readinessSummaryCard(r: PayrollReadiness, phase: ReadinessPhase): BotCard {
  const fields: { label: string; value: string }[] = [
    { label: "Status", value: READINESS_STATUS_LABEL[r.status] },
    { label: "Pay period", value: r.period.label },
    { label: "Workers", value: `${r.counts.workers} (${r.counts.ready} ready, ${r.counts.actionRequired} review, ${r.counts.blocked} blocked)` },
    { label: "Hours", value: r.hours == null ? "— unavailable" : `${r.hours}${r.approvedHours != null ? ` (${r.approvedHours} approved)` : ""}` },
    { label: "Blocking", value: String(r.blocking) },
    { label: "Review / unverified", value: `${r.anomalies} / ${r.unverified}` },
  ];
  // Up to 6 top issues inline so the channel reads at a glance (full list lives in the app).
  const top = r.exceptions.slice(0, 6).map((e) => `• ${issueLine(e)}`).join("\n");
  return {
    title: `${PHASE_LABEL[phase]} — ${READINESS_STATUS_LABEL[r.status]}`,
    emoji: STATUS_EMOJI[r.status],
    fields,
    body: r.exceptions.length
      ? `*${r.exceptions.length} item${r.exceptions.length === 1 ? "" : "s"} to resolve before payroll:*\n${top}${r.exceptions.length > 6 ? `\n…and ${r.exceptions.length - 6} more.` : ""}`
      : r.summary,
    link: { text: "Open Payroll", url: appUrl("/payroll?tab=exceptions") },
    context: "Payroll Bot · Gusto export stays a human action — this only prepares the run.",
  };
}

function issueLine(e: ReadinessException): string {
  const who = e.workerLabel ? `*${e.workerLabel}* — ` : "";
  return `${who}${e.description} _(${e.ownerAction})_`;
}

/** One actionable card per exception (used for blocking/unverified items that need an owner to act). */
export function exceptionCard(e: ReadinessException, period: string): BotCard {
  return {
    title: `${e.kind === "BLOCKING" ? "Blocking" : e.kind === "UNVERIFIED" ? "Unverified" : "Review"}: ${e.type.replace(/_/g, " ").toLowerCase()}`,
    emoji: e.kind === "BLOCKING" ? "⛔" : "⚠️",
    fields: [
      { label: "Worker", value: e.workerLabel ?? "—" },
      { label: "Pay period", value: period },
      { label: "Source", value: e.source },
    ],
    body: `${e.description}\n\n*Action:* ${e.ownerAction}`,
    link: { text: "Open Payroll", url: appUrl("/payroll?tab=exceptions") },
    context: "Payroll Bot · resolving this re-checks the Connecteam record — a click alone does not clear it.",
  };
}

// ── Idempotent posting (content-hash dedup) ──────────────────────────────────────────────────────────
const DEDUP_KEY = "payroll.slack.dedup";
type DedupStore = Record<string, string>;

function hashCard(card: BotCard): string {
  return createHash("sha1").update(JSON.stringify(card)).digest("hex").slice(0, 16);
}

/** PURE dedup decision — post only when this key's content changed. Exported for tests. */
export function shouldPost(store: DedupStore, key: string, hash: string): boolean {
  return store[key] !== hash;
}

/**
 * Post a card to the payroll channel, deduped by (dedupKey, content). Returns skipped when the identical
 * card was already posted (so repeated scheduled runs don't flood). `force` bypasses the dedup. Falls back
 * to the ops webhook when the bot token/channel isn't configured. Never throws.
 */
async function postCardDeduped(card: BotCard, dedupKey: string, force = false): Promise<SlackResult & { skipped?: boolean }> {
  const store = getJson<DedupStore>(DEDUP_KEY, {});
  const hash = hashCard(card);
  if (!force && !shouldPost(store, dedupKey, hash)) return { ok: true, skipped: true };

  const channel = payrollChannel();
  const text = flattenCard(card);
  let result: SlackResult;
  if (channel && slackBotConfigured()) {
    result = await slackPostAs(channel, PAYROLL_PERSONA, text, { blocks: cardBlocks(card) });
    if (!result.ok) result = await slackNotify(text); // fall back so the summary is never silently lost
  } else {
    result = await slackNotify(text); // no bot/channel → ops webhook carries the flattened text
  }
  if (result.ok) {
    store[dedupKey] = hash;
    setJson(DEDUP_KEY, store);
  }
  return result;
}

function flattenCard(card: BotCard): string {
  const lines = [`${card.emoji ? `${card.emoji} ` : ""}${card.title}`.trim()];
  for (const f of card.fields ?? []) lines.push(`${f.label}: ${f.value}`);
  if (card.body?.trim()) lines.push(card.body.trim());
  if (card.link?.url) lines.push(`${card.link.text}: ${card.link.url}`);
  return lines.join("\n");
}

export interface PayrollPostResult {
  summary: { ok: boolean; skipped?: boolean };
  exceptionsPosted: number;
  channel: string | null;
}

/**
 * Post the readiness summary (+ one card per blocking/unverified exception) to the payroll channel,
 * idempotently. On a repeated run with unchanged content nothing is re-posted. Reuses the shared Slack
 * layer end to end.
 */
export async function postPayrollReadiness(r: PayrollReadiness, phase: ReadinessPhase, opts?: { force?: boolean; includeExceptionCards?: boolean }): Promise<PayrollPostResult> {
  const period = `${r.period.start}..${r.period.end}`;
  const summary = await postCardDeduped(readinessSummaryCard(r, phase), `summary:${phase}:${period}`, opts?.force);

  let exceptionsPosted = 0;
  if (opts?.includeExceptionCards !== false) {
    // Only the items that need an owner to act — blocking + unverified. Anomalies ride the summary.
    for (const e of r.exceptions.filter((x) => x.kind === "BLOCKING" || x.kind === "UNVERIFIED")) {
      const res = await postCardDeduped(exceptionCard(e, r.period.label), `exc:${e.detectKey}`, opts?.force);
      if (res.ok && !res.skipped) exceptionsPosted++;
    }
  }
  return { summary, exceptionsPosted, channel: payrollChannel() };
}

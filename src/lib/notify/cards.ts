// Reusable Slack Block Kit card builders for bot alerts. These return a `BotCard` (aiBots.ts), so they flow
// through notify()/botAnnounce() unchanged: the blocks render the designed card and the flattened text is the
// notification + webhook fallback. House style: professional, clean, NO em-dashes, NO emoji (the user's
// comms rule, and what the sibling sales-bot cards in esignCutoff.ts follow).

import type { BotCard } from "./aiBots";

/** Render text as a Slack mrkdwn blockquote (every line prefixed with "> "), so a customer's verbatim words
 *  read as an obviously-distinct quote. Collapses blank runs; returns "" for empty input. Generic — any bot
 *  card can quote source text with it. */
export function slackBlockquote(text: string): string {
  const clean = (text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!clean) return "";
  return clean
    .split("\n")
    .map((line) => `> ${line.trim()}`)
    .join("\n");
}

/** A short, human label for each customer action-item kind (bold-ready). Falls back to "Open ask". */
export const ACTION_ITEM_KIND_LABELS: Record<string, string> = {
  contract_change: "Contract change",
  pricing_question: "Pricing question",
  product_question: "Product question",
  scheduling: "Scheduling",
  decision: "Decision",
  objection: "Objection",
  other: "Open ask",
};

export function actionItemKindLabel(kind: string): string {
  return ACTION_ITEM_KIND_LABELS[kind] ?? "Open ask";
}

/** A compact relative-time phrase ("just now", "15m ago", "3h ago", "2d ago") for an ISO timestamp vs now.
 *  Returns null when the timestamp is missing or unparseable, so callers can omit the recency cleanly. */
export function relativeRecency(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diffMs = now - t;
  if (diffMs < 0) return "just now"; // a future/clock-skew stamp reads as "just now", never negative
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** The minimal shape the action-item card needs from a stored/open item (summary + kind + verbatim quote).
 *  Kept structural so the builder stays decoupled from salesos. */
export interface ActionItemCardItem {
  summary: string;
  kind: string;
  verbatimQuote: string;
}

export interface ActionItemCardInput {
  /** The customer's name (already resolved, e.g. "a customer" when unknown). */
  customer: string;
  /** The project / event label. */
  project: string;
  /** A link to the lead (Goodshuffle project, or the app). Null drops the button. */
  projectUrl?: string | null;
  /** The open asks to surface, in display order. */
  items: ActionItemCardItem[];
  /** ISO timestamp of the most recent customer inbound, for the "heard Nh ago" recency. */
  latestInboundAt?: string | null;
  /** Clock, for a deterministic recency in tests. */
  now?: number;
}

/**
 * Build the Viktor-style card for open customer action items, posted via the SALES persona. Layout:
 *   • Header   — "Open customer ask" (pluralized), so it clearly needs a response.
 *   • Subtitle — "From <customer> · <project> · heard <recency>" context line.
 *   • Sections — ONE per open ask: a bold kind label, the one-line summary, and the customer's VERBATIM
 *                quote as a Slack blockquote (their own words, visually distinct).
 *   • Body     — the closing CTA, "Needs a response."
 *   • Link     — "Open in Goodshuffle" (when a URL is available).
 *   • Context  — persona + an honesty footer (detection only, no reply was sent).
 * Presentation only: every fact comes straight from the items; nothing is added or inferred.
 */
export function buildActionItemCard(input: ActionItemCardInput): BotCard {
  const { customer, project, projectUrl, items } = input;
  const recency = relativeRecency(input.latestInboundAt, input.now);
  const subtitleParts = [`From *${customer}*`, project].filter(Boolean);
  if (recency) subtitleParts.push(`heard ${recency}`);

  const sections = items.map((it) => {
    const label = actionItemKindLabel(it.kind);
    const summary = (it.summary ?? "").trim();
    const quote = slackBlockquote(it.verbatimQuote);
    return [`*${label}*`, summary, quote].filter(Boolean).join("\n");
  });

  return {
    title: `Open customer ask${items.length === 1 ? "" : "s"}`,
    subtitle: subtitleParts.join(" · "),
    sections,
    body: "*Needs a response.*",
    link: { text: "Open in Goodshuffle", url: projectUrl ?? null },
    context: "Sales Bot · action-item detection, surfaced for a human, no reply was sent",
  };
}

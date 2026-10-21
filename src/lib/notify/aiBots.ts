// AI-bot Slack identities + channel routing. ONE Slack app (Viktor, invited to every channel) posts AS each
// bot (custom name + icon via chat:write.customize) into that bot's OWN domain channel. This gives the clean
// "one bot per domain" look without a separate Slack app + token + per-channel invite for each bot.
//
// House rule (the user's): an AI employee NEVER acts silently — every action it commits is announced so a
// human can see what it did and why, and override. `botAnnounce` routes to the domain channel and falls back
// to the ops webhook (slackNotify) if the bot token/channel isn't available, so it is never a silent no-op.
//
// Channels default to the team's existing channel NAMES (Slack resolves a name for chat.postMessage) and are
// each overridable with an env var (SLACK_CHANNEL_<BOT>, e.g. SLACK_CHANNEL_SCHEDULING) without a code change.

import { slackPostAs, slackNotify, slackBotConfigured, type BotPersona, type SlackResult } from "./slack";

export type BotId = "scheduling" | "pricing" | "sales" | "reviews" | "inventory" | "hiring" | "data" | "ops";

interface BotConfig extends BotPersona {
  /** Default channel (a NAME in the team's workspace). Overridable via SLACK_CHANNEL_<BOT>. */
  defaultChannel: string;
}

/** The roster: each bot's display persona + its home channel. Channel names match the team's workspace. */
export const BOTS: Record<BotId, BotConfig> = {
  scheduling: { name: "Scheduling Bot", icon: ":calendar:", defaultChannel: "finalized-delivery-schedules" },
  pricing: { name: "Pricing Bot", icon: ":moneybag:", defaultChannel: "delivery-pricing" },
  // SALES domain lands in `sales-ai` (Sales OS leads/outreach, quote-open, the e-signature cutoff). Was
  // "ai-outbound-calls"; consolidated here so every sales notification shares one channel. Override with
  // SLACK_CHANNEL_SALES or the SALES_AI_SLACK_CHANNEL alias (resolved in channelFor). See notify/channels.ts.
  sales: { name: "Sales Bot", icon: ":telephone_receiver:", defaultChannel: "sales-ai" },
  reviews: { name: "Customer Experience Bot", icon: ":star:", defaultChannel: "new-customer-reviews" },
  inventory: { name: "Inventory Bot", icon: ":package:", defaultChannel: "inventory-conflicts" },
  hiring: { name: "Hiring Bot", icon: ":handshake:", defaultChannel: "hiring" },
  data: { name: "Data Bot", icon: ":mag:", defaultChannel: "data-scraping-results" },
  ops: { name: "Viktor", icon: ":robot_face:", defaultChannel: "general" },
};

/** Bridge the AI-org employee/agent ids (aiorg/registry.ts) to a notify BotId, so code holding an agentId
 *  (e.g. an approval's agentId) can route to the right channel/persona. Unknown ids fall back to "ops". */
const AGENT_TO_BOT: Record<string, BotId> = {
  outreach: "sales",
  "lost-quote": "sales",
  "quote-analyst": "sales",
  "lead-intelligence": "sales",
  "sales-coach": "sales",
  "inventory-exception": "inventory",
  "event-radar": "data",
  hiring: "hiring",
  // Back-office scheduling/staffing employees → the scheduling bot's channel, so a routed schedule/shift
  // proposal's card + announcement land where that team watches (not the generic ops channel).
  scheduling: "scheduling",
  staffing: "scheduling",
  "back-office": "scheduling",
  // Marketing content → the pricing/marketing-adjacent channels have no own bot; keep content on data (the
  // marketing surface) rather than ops.
  content: "data",
  "campaign-analyst": "data",
};
export function botForAgent(agentId: string): BotId {
  return AGENT_TO_BOT[agentId] ?? "ops";
}

/** The channel a bot posts to: an env override (SLACK_CHANNEL_<BOT>), else the bot's default, else the
 *  generic AI channel. Returns null only when nothing is configured at all. The SALES bot also honors the
 *  SALES_AI_SLACK_CHANNEL alias (Part C central routing) so the team can point the sales-ai channel with a
 *  single, obviously-named secret; the generic SLACK_CHANNEL_SALES still wins if both are set. */
export function channelFor(bot: BotId): string | null {
  const override = process.env[`SLACK_CHANNEL_${bot.toUpperCase()}`]?.trim();
  const salesAlias = bot === "sales" ? process.env.SALES_AI_SLACK_CHANNEL?.trim() : undefined;
  return override || salesAlias || BOTS[bot].defaultChannel || process.env.SLACK_AI_CHANNEL?.trim() || null;
}

/** A designed announcement, rendered as a Slack Block Kit card. Pass a plain string to botAnnounce instead
 *  for a simple text line. Every field is optional except the title. */
export interface BotCard {
  /** Short header line (what happened). */
  title: string;
  /** Leading emoji for the header, e.g. "🗓️". */
  emoji?: string;
  /** A 2-column label/value grid (the facts): who / truck / value / window … */
  fields?: { label: string; value: string }[];
  /** A paragraph under the fields — the "why", or a drafted-message preview. mrkdwn. */
  body?: string;
  /** A link button ("View in app"); dropped when url is empty. */
  link?: { text: string; url: string | null };
  /** Interactive buttons (Approve / Dismiss …) — each carries an action_id + value the Slack interactivity
   *  endpoint reads. Rendered alongside the link button. */
  buttons?: { text: string; actionId: string; value: string; style?: "primary" | "danger" }[];
  /** A small footer line (persona + an override hint). mrkdwn. */
  context?: string;
}

/** The app's public base URL for "View in app" links, from PUBLIC_BASE_URL. Null → the link button drops. */
export function appUrl(path: string): string | null {
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Build Block Kit blocks for a card. Keeps within Slack's limits (10 section fields, 150-char header). */
export function cardBlocks(card: BotCard): unknown[] {
  const blocks: unknown[] = [];
  const header = `${card.emoji ? `${card.emoji} ` : ""}${card.title}`.slice(0, 150);
  blocks.push({ type: "header", text: { type: "plain_text", text: header, emoji: true } });
  blocks.push({ type: "divider" });
  if (card.fields?.length) {
    blocks.push({ type: "section", fields: card.fields.slice(0, 10).map((f) => ({ type: "mrkdwn", text: `*${f.label}:*\n${f.value}` })) });
  }
  if (card.body?.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: card.body.trim() } });
  const elements: unknown[] = [];
  for (const b of card.buttons ?? []) {
    elements.push({ type: "button", text: { type: "plain_text", text: b.text, emoji: true }, action_id: b.actionId, value: b.value, ...(b.style ? { style: b.style } : {}) });
  }
  if (card.link?.url) elements.push({ type: "button", text: { type: "plain_text", text: card.link.text, emoji: true }, url: card.link.url });
  if (elements.length) blocks.push({ type: "actions", elements });
  if (card.context?.trim()) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: card.context.trim() }] });
  return blocks;
}

/** Flatten a card to plain text — the notification/fallback text, and what the ops webhook (no Block Kit) posts. */
export function cardToText(card: BotCard): string {
  const lines = [`${card.emoji ? `${card.emoji} ` : ""}${card.title}`.trim()];
  for (const f of card.fields ?? []) lines.push(`${f.label}: ${f.value}`);
  if (card.body?.trim()) lines.push(card.body.trim());
  if (card.link?.url) lines.push(`${card.link.text}: ${card.link.url}`);
  if (card.context?.trim()) lines.push(card.context.trim());
  return lines.join("\n");
}

/**
 * Announce an AI bot's action in its OWN channel, under its OWN persona. Pass a plain string for a simple
 * line, or a BotCard for a designed Block Kit card (the card also renders as text for the notification + the
 * webhook fallback). Never silent: if the bot token or channel isn't available (or the post fails), falls
 * back to the ops webhook so the action is still surfaced. Never throws.
 */
export async function botAnnounce(bot: BotId, message: string | BotCard): Promise<SlackResult> {
  const text = typeof message === "string" ? message : cardToText(message);
  const blocks = typeof message === "string" ? undefined : cardBlocks(message);
  const channel = channelFor(bot);
  if (channel && slackBotConfigured()) {
    const r = await slackPostAs(channel, BOTS[bot], text, { blocks });
    if (r.ok) return r;
    // bot token present but post failed (e.g. not in that channel) → fall through so it's still surfaced
  }
  return slackNotify(text); // webhook can't render blocks — the flattened text carries the full content
}

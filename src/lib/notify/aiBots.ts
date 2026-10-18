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
  sales: { name: "Sales Bot", icon: ":telephone_receiver:", defaultChannel: "ai-outbound-calls" },
  reviews: { name: "Customer Experience Bot", icon: ":star:", defaultChannel: "new-customer-reviews" },
  inventory: { name: "Inventory Bot", icon: ":package:", defaultChannel: "inventory-conflicts" },
  hiring: { name: "Hiring Bot", icon: ":handshake:", defaultChannel: "hiring" },
  data: { name: "Data Bot", icon: ":mag:", defaultChannel: "data-scraping-results" },
  ops: { name: "Viktor", icon: ":robot_face:", defaultChannel: "general" },
};

/** The channel a bot posts to: an env override (SLACK_CHANNEL_<BOT>), else the bot's default, else the
 *  generic AI channel. Returns null only when nothing is configured at all. */
export function channelFor(bot: BotId): string | null {
  const override = process.env[`SLACK_CHANNEL_${bot.toUpperCase()}`]?.trim();
  return override || BOTS[bot].defaultChannel || process.env.SLACK_AI_CHANNEL?.trim() || null;
}

/**
 * Announce an AI bot's action in its OWN channel, under its OWN persona. Never silent: if the bot token or
 * channel isn't available (or the post fails), falls back to the ops webhook so the action is still surfaced.
 * Never throws. `text` is the full human-readable message (what it did + why + how to override).
 */
export async function botAnnounce(bot: BotId, text: string): Promise<SlackResult> {
  const channel = channelFor(bot);
  if (channel && slackBotConfigured()) {
    const r = await slackPostAs(channel, BOTS[bot], text);
    if (r.ok) return r;
    // bot token present but post failed (e.g. not in that channel) → fall through so it's still surfaced
  }
  return slackNotify(text);
}

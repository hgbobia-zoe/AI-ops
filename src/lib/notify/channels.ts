// Central Slack ROUTING MAP — the one place that says, per notification DOMAIN, WHERE a notification lands.
// Routing by DOMAIN (not by sprinkling channel ids at call sites) keeps it auditable: moving a domain to a
// different channel is a one-line edit here (or a secret), and a reviewer can read the whole policy at once.
//
// Domains (the user's categorization, Part C):
//   • sales    → the `sales-ai` channel, posted AS the Sales bot persona (botAnnounce("sales")). Covers
//                Sales OS leads/outreach, the quote-open alert, and the e-signature cutoff update. The
//                channel is configurable (SLACK_CHANNEL_SALES or the SALES_AI_SLACK_CHANNEL alias; see
//                aiBots.channelFor) and degrades to the ops webhook when the bot token/channel is unset —
//                never a crash, never silent.
//   • customer → the CUSTOMER-ALERTS webhook (slackNotifyAlert). Reserved for FRUSTRATED-CALLER /
//                call-sentiment alerts ONLY — the user was explicit these stay put. No-ops cleanly when the
//                alerts webhook is unset.
//   • ops      → the ops/dispatch webhook (slackNotify). Dispatch/system/integration failures.
//
// NOTE: this map covers the DOMAINS Part C routes. Operational-Opportunity / Radar alerts
// (src/lib/opportunity/alerts.ts) deliberately still use slackNotifyAlert directly and are NOT routed here
// — their domain (sales-lead vs ops) was ambiguous, so they were left exactly where they were pending a
// human call. Add them here only once that's decided.

import { botAnnounce, channelFor, cardToText, type BotCard } from "./aiBots";
import { slackNotify, slackNotifyAlert, type SlackResult } from "./slack";

export type NotifyDomain = "sales" | "customer" | "ops";

export type NotifyTransport = "sales-bot" | "customer-alerts" | "ops-webhook";

export interface DomainRoute {
  transport: NotifyTransport;
  /** The resolved channel name, when the transport targets a named channel (sales). null for the webhooks,
   *  whose destination is the webhook URL itself (SLACK_ALERT_WEBHOOK_URL / SLACK_WEBHOOK_URL). */
  channel: () => string | null;
  description: string;
}

/** The routing policy, as data — pure and directly assertable in tests. */
export const DOMAIN_ROUTING: Record<NotifyDomain, DomainRoute> = {
  sales: {
    transport: "sales-bot",
    channel: () => channelFor("sales"),
    description: "Sales OS leads/outreach, quote-open alert, e-signature cutoff → sales-ai (Sales bot persona)",
  },
  customer: {
    transport: "customer-alerts",
    channel: () => null,
    description: "Frustrated-caller / call-sentiment alerts ONLY → customer-alerts webhook",
  },
  ops: {
    transport: "ops-webhook",
    channel: () => null,
    description: "Dispatch / system / integration failures → ops webhook",
  },
};

/** The resolved sales-ai channel name (or null if nothing is configured at all). */
export function salesAiChannel(): string | null {
  return channelFor("sales");
}

/**
 * Send a notification for a DOMAIN through its configured transport. A BotCard is only meaningful for the
 * sales (bot-persona) transport; for the webhook transports it is flattened to text. Never throws; returns
 * the underlying SlackResult (ok / skipped / error) so callers can record delivery honestly.
 */
export async function notify(domain: NotifyDomain, message: string | BotCard): Promise<SlackResult> {
  const route = DOMAIN_ROUTING[domain];
  switch (route.transport) {
    case "sales-bot":
      return botAnnounce("sales", message);
    case "customer-alerts":
      return slackNotifyAlert(typeof message === "string" ? message : cardToText(message));
    case "ops-webhook":
      return slackNotify(typeof message === "string" ? message : cardToText(message));
  }
}

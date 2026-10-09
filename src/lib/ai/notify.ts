// AI Control Plane — requester notifications. When the bridge responder files a request or posts a reply
// into a session, the person who asked should hear about it in Slack. The app's Slack is webhook-only (one
// channel), so this does the honest best thing available:
//   • a true DM to the person (Slack bot token + their work email) when both exist, else
//   • a channel post that names the person ("For Lisa: …"), which works with the existing webhook today.
// Never throws; returns which path was used so callers can log honestly. Nothing here executes an
// operational change — it's a notification.

import { slackBotConfigured, slackDmByEmail, slackNotify } from "@/lib/notify/slack";

export type NotifyVia = "dm" | "channel" | "none";
export interface NotifyResult {
  ok: boolean;
  via: NotifyVia;
  error?: string;
}

/** The channel-post line when we can't DM: name the person so it's clear who it's for. PURE. */
export function requesterChannelLine(name: string | null | undefined, text: string): string {
  const who = (name ?? "").trim();
  return who ? `For ${who}: ${text}` : text;
}

/** Can we DM this requester directly right now? (bot token configured AND we have an email). PURE. */
export function canDmRequester(hasBotToken: boolean, email: string | null | undefined): boolean {
  return hasBotToken && !!(email && email.trim());
}

/** Notify the person who asked. Prefers a direct message (bot token + email); falls back to a channel post
 *  that names them. Honest about which path was used, and skips cleanly when Slack isn't configured at all. */
export async function notifyRequester(opts: { name?: string | null; email?: string | null; text: string }): Promise<NotifyResult> {
  const text = opts.text.trim();
  if (!text) return { ok: false, via: "none", error: "empty" };

  if (canDmRequester(slackBotConfigured(), opts.email)) {
    const dm = await slackDmByEmail(opts.email!.trim(), text);
    if (dm.ok) return { ok: true, via: "dm" };
    // DM failed (e.g. email maps to no Slack user) — fall through to the channel so the message still lands.
  }

  const ch = await slackNotify(requesterChannelLine(opts.name, text));
  if (ch.ok) return { ok: true, via: "channel" };
  if (ch.skipped) return { ok: false, via: "none", error: "slack_not_configured" };
  return { ok: false, via: "none", error: ch.error };
}

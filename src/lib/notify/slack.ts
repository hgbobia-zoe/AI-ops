// Slack notifications via Incoming Webhooks. Two independent channels, each a no-op that reports
// `skipped` when unset; neither ever throws:
//   • DELIVERY / OPS  → slackNotify()      → SLACK_WEBHOOK_URL (the existing dispatch channel)
//   • CUSTOMER ALERTS → slackNotifyAlert() → the "alerts.slackWebhook" secret, else
//                                            SLACK_ALERT_WEBHOOK_URL — a SEPARATE channel, on purpose.

import { getSecret } from "@/lib/secrets";

export interface SlackResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

async function post(url: string | null | undefined, text: string): Promise<SlackResult> {
  if (!url) return { ok: false, skipped: true };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `slack ${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function slackConfigured(): boolean {
  return Boolean(process.env.SLACK_WEBHOOK_URL);
}

export async function slackNotify(text: string): Promise<SlackResult> {
  return post(process.env.SLACK_WEBHOOK_URL, text);
}

/** The customer-alerts webhook — a DIFFERENT channel from delivery. Admin secret first, env fallback.
 *  Deliberately does NOT fall back to the delivery webhook: an empty config skips (no misrouting). */
function alertWebhook(): string | null {
  try {
    const secret = getSecret("alerts.slackWebhook");
    if (secret) return secret;
  } catch {
    // secrets store unavailable (e.g. non-DB context) — fall through to env
  }
  return process.env.SLACK_ALERT_WEBHOOK_URL ?? null;
}

export function slackAlertConfigured(): boolean {
  return Boolean(alertWebhook());
}

export async function slackNotifyAlert(text: string): Promise<SlackResult> {
  return post(alertWebhook(), text);
}

// ── Direct messages (Slack bot token) ───────────────────────────────────────────
// Webhooks can only post to one channel — they CANNOT DM a person. A true per-person DM needs a bot token
// (SLACK_BOT_TOKEN, scopes chat:write + users:read.email). This stays DORMANT until the token is set: every
// function below returns `skipped` without one, so the caller falls back to a channel post. We resolve the
// recipient by email (users.lookupByEmail) — the app does not yet store user emails, so this path only lights
// up once a bot token AND user emails both exist. Never throws.
export function slackBotConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN);
}

async function slackApi(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: "no_bot_token" };
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    return data.ok === true ? { ok: true, data } : { ok: false, error: String(data.error ?? `slack ${res.status}`) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** DM a person by their (work) email. Returns skipped when no bot token is set, or a clear error when the
 *  email maps to no Slack user — so the caller can fall back to a channel post. */
export async function slackDmByEmail(email: string, text: string): Promise<SlackResult> {
  if (!slackBotConfigured()) return { ok: false, skipped: true };
  const clean = email.trim();
  if (!clean) return { ok: false, error: "no_email" };
  const lookup = await slackApi("users.lookupByEmail", { email: clean });
  if (!lookup.ok) return { ok: false, error: `lookup: ${lookup.error}` };
  const userId = (lookup.data?.user as { id?: string } | undefined)?.id;
  if (!userId) return { ok: false, error: "user_not_found" };
  const sent = await slackApi("chat.postMessage", { channel: userId, text });
  return sent.ok ? { ok: true } : { ok: false, error: `post: ${sent.error}` };
}

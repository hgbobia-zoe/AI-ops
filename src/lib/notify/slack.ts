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

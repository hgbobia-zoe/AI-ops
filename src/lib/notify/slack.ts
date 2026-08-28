// Slack notifications via an Incoming Webhook. Sends only when SLACK_WEBHOOK_URL
// is set; otherwise a no-op that reports `skipped`. Never throws.

export interface SlackResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export function slackConfigured(): boolean {
  return Boolean(process.env.SLACK_WEBHOOK_URL);
}

export async function slackNotify(text: string): Promise<SlackResult> {
  const url = process.env.SLACK_WEBHOOK_URL;
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

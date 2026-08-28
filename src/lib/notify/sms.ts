// Customer SMS via OpenPhone (Quo). Fully implemented; sends only when
// OPENPHONE_API_KEY + OPENPHONE_FROM are set — otherwise it's a no-op that reports
// `skipped` so the caller can log instead. Never throws.
//
// OpenPhone API: POST https://api.openphone.com/v1/messages
//   headers: Authorization: <api key>   (raw key, not "Bearer")
//   body: { from: <your OpenPhone number, E.164>, to: [<E.164>], content: <text> }

export interface SmsResult {
  ok: boolean;
  skipped?: boolean;
  providerMsgId?: string;
  error?: string;
}

export function smsConfigured(): boolean {
  return Boolean(process.env.OPENPHONE_API_KEY && process.env.OPENPHONE_FROM);
}

export async function sendSms(to: string, body: string): Promise<SmsResult> {
  if (!smsConfigured()) return { ok: false, skipped: true, error: "sms not configured" };
  if (!to) return { ok: false, error: "no recipient phone" };
  try {
    const res = await fetch("https://api.openphone.com/v1/messages", {
      method: "POST",
      headers: {
        authorization: process.env.OPENPHONE_API_KEY!,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.OPENPHONE_FROM,
        to: [to],
        content: body,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      data?: { id?: string };
      message?: string;
    };
    if (!res.ok) {
      return { ok: false, error: `openphone ${res.status}: ${data.message ?? ""}`.trim() };
    }
    return { ok: true, providerMsgId: data.data?.id ?? data.id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

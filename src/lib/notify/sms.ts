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

/**
 * Coerce a phone number to E.164, which is what OpenPhone requires. Goodshuffle's
 * validated `e164PhoneNumber` already is; but the raw `renter.phone` ("(301) 640-0251")
 * and hand-typed numbers are not. US-defaults a bare 10-digit / 1+10-digit number.
 * Returns "" if it can't form a plausible number, so the caller reports it cleanly.
 */
export function toE164(raw: string): string {
  const trimmed = (raw || "").trim();
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed; // already E.164
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (trimmed.startsWith("+") && digits.length >= 8) return `+${digits}`;
  return "";
}

export async function sendSms(to: string, body: string): Promise<SmsResult> {
  if (!smsConfigured()) return { ok: false, skipped: true, error: "sms not configured" };
  const e164 = toE164(to);
  if (!e164) {
    return { ok: false, error: to ? `invalid recipient phone: ${to}` : "no recipient phone" };
  }
  try {
    const res = await fetch("https://api.openphone.com/v1/messages", {
      method: "POST",
      headers: {
        authorization: process.env.OPENPHONE_API_KEY!,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.OPENPHONE_FROM,
        to: [e164],
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

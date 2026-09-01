// Customer SMS — routed through whichever phone provider is active in /admin
// (OpenPhone / RingCentral / Dialpad). The provider implementations live in
// src/lib/providers.ts; this module just picks the active one, loads its credentials,
// normalizes the number to E.164, and delegates. Never throws; returns `skipped` when
// the active provider isn't configured so the caller logs instead of failing.

import { getSettings } from "@/lib/settings";
import { smsProviderById, loadSmsConfig, type SmsResult } from "@/lib/providers";

export type { SmsResult };

/**
 * Coerce a phone number to E.164. Goodshuffle's validated `e164PhoneNumber` already is;
 * the raw `renter.phone` ("(301) 640-0251") and hand-typed numbers are not. US-defaults
 * a bare 10-digit / 1+10-digit number. Returns "" if it can't form a plausible number.
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

// OpenPhone historically read its key/number from env. Keep that as a fallback so an
// existing deployment keeps sending until the team enters credentials in /admin.
function withEnvFallback(providerId: string, cfg: Record<string, string>): Record<string, string> {
  if (providerId === "openphone") {
    return {
      apiKey: cfg.apiKey || process.env.OPENPHONE_API_KEY || "",
      fromNumber: cfg.fromNumber || process.env.OPENPHONE_FROM || "",
    };
  }
  return cfg;
}

export async function sendSms(to: string, body: string): Promise<SmsResult> {
  const provider = smsProviderById(getSettings().smsProvider);
  const cfg = withEnvFallback(provider.id, loadSmsConfig(provider.id));
  const e164 = toE164(to);
  if (!e164) {
    return { ok: false, error: to ? `invalid recipient phone: ${to}` : "no recipient phone" };
  }
  return provider.send(e164, body, cfg);
}

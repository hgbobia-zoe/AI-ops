// Who's who on a call. OpenPhone transcripts label speakers by raw phone number, so to tell the Zoe
// rep from the customer we compare against Zoe's OWN numbers (the Quo from-number + the notify line).
// FACT-based: a speaker whose number is one of ours is the rep; anyone else is the customer.

import { getSettings } from "@/lib/settings";
import { loadSmsConfig } from "@/lib/providers";

export const last10 = (p?: string | null): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

/** Last-10 digits of Zoe's own phone numbers — the active provider's from-number plus the notify
 *  line — used to distinguish the rep from the customer in a call transcript. */
export function ourPhoneDigits(): Set<string> {
  const s = new Set<string>();
  try {
    const settings = getSettings();
    const cfg = loadSmsConfig(settings.smsProvider);
    const candidates = [cfg.fromNumber, process.env.OPENPHONE_FROM, settings.notifyPhone, process.env.ETA_NOTIFY_PHONE];
    for (const p of candidates) {
      const d = last10(p);
      if (d) s.add(d);
    }
  } catch {
    /* settings/secrets unavailable (e.g. tests) — return what we have */
  }
  return s;
}

/** Format a US phone for display, e.g. "+17867413005" → "(786) 741-3005". */
export function fmtPhone(p?: string | null): string | null {
  const d = (p ?? "").replace(/\D/g, "");
  const t = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (t.length === 10) return `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}`;
  return (p ?? "").trim() || null;
}

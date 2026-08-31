// Extract the "Day of Contact" (day-of coordinator) from event/notes text
// (Goodshuffle notes or a calendar-invite description).
//
// Deterministic string parse — chosen over an LLM on purpose: it's a LABELED field
// and we TEXT the number, so a regex that copies the digits exactly beats a model
// that might transpose them. If the field ever turns freeform/inconsistent, an AI
// fallback can be layered in here without touching callers.

export interface DayOfContact {
  name?: string;
  phone?: string;
}

// Label variants: "Day of Contact", "Day-of Contact", "Day of Coordinator",
// "Day of POC". Captures the remainder of the line as the value.
const LABEL = /day[\s-]*of[\s-]*(?:contact|coordinator|coord\.?|poc)\s*[:\-–]?\s*(.+)/i;

// US phone in common formats: 240-555-1234, (240) 555-1234, 240.555.1234, +1 …
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

export function parseDayOfContact(text?: string | null): DayOfContact | null {
  if (!text) return null;
  // Search line by line so the value we grab is on the label's own line.
  for (const line of text.split(/\r?\n/)) {
    const m = LABEL.exec(line);
    if (!m) continue;
    const rest = m[1].trim();
    const phoneMatch = PHONE.exec(rest);
    const phone = phoneMatch ? normalizePhone(phoneMatch[0]) : undefined;
    // Name = the text before the phone number, trimmed of trailing separators.
    const name =
      (phoneMatch ? rest.slice(0, phoneMatch.index) : rest)
        .replace(/[-–,|:]\s*$/, "")
        .trim() || undefined;
    if (!name && !phone) continue;
    return { name, phone };
  }
  return null;
}

// To E.164 (US default) — what OpenPhone/Quo expects. Returns the original if it
// doesn't look like a 10/11-digit US number.
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.trim();
}

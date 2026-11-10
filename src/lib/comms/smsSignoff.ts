// Every text Zoe sends to a lead or customer ends with the same thank-you line (owner rule, 2026-11-10).
// Added once, in code, so it never depends on a rep or a model remembering it. Idempotent: a text that
// already ends with (or contains) the line is left alone. Kill switch: SMS_SIGNOFF=false.
//
// Scope is lead and customer sales texts: the Sales OS drafts, the lead sender (single, bulk, morning),
// the Act on a call follow-up text and the automatic web lead text. Operational texts (dispatch ETAs,
// crew shifts, review requests after an event) do not get it.

import { flagOn } from "@/lib/flags";

export const SMS_SIGNOFF = "Thank you for considering us for your event.";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();
const SIGNOFF_KEY = norm(SMS_SIGNOFF);

export function hasSmsSignoff(text: string): boolean {
  return norm(text ?? "").includes(SIGNOFF_KEY);
}

/** Append the thank-you line to a customer text. Empty text stays empty; a text that already has it is
 *  returned unchanged. A missing end punctuation gets a period first so the line reads as its own sentence. */
export function withSmsSignoff(text: string): string {
  const t = (text ?? "").trim();
  if (!t || !flagOn("SMS_SIGNOFF") || hasSmsSignoff(t)) return t;
  const sep = /[.!?…]$/.test(t) ? " " : ". ";
  return `${t}${sep}${SMS_SIGNOFF}`;
}

// Sales autopsy (Phase 12) — a deterministic post-mortem of a lost deal. RULES CALCULATE the FACTs and
// the process breakpoints straight from what we recorded (the quote timing + the team's own contact
// log); an optional AI narrative (service layer) adds the "why" as clearly-labelled INFERENCE. Where
// the data doesn't say, it says Unknown — never a fabricated cause.

import { summarizeComms, type CommsSummary } from "./outreach";

export interface AutopsyInput {
  everSent: boolean;
  quoteSentDate: string | null; // YYYY-MM-DD
  eventDate: string | null; // YYYY-MM-DD
  lossReason: string | null; // team-recorded, if any
  internalNotes: string | null; // the contact log
}

export interface Breakpoint {
  area: string; // short label
  detail: string; // evidence-based explanation
}

export interface Autopsy {
  comms: CommsSummary; // attempts / channels / last contact / no-response
  quoteLeadDays: number | null; // days from quote sent to event (short = quoted late)
  recordedReason: string | null; // the team's tagged loss reason (FACT), if present
  breakpoints: Breakpoint[]; // where the process likely broke (deterministic)
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Deterministic autopsy: comms summary + quote lead time + process breakpoints, all evidence-based. */
export function analyzeLostDeal(i: AutopsyInput): Autopsy {
  const comms = summarizeComms(i.internalNotes, null);
  const quoteLeadDays = i.quoteSentDate && i.eventDate ? daysBetween(i.quoteSentDate, i.eventDate) : null;

  const breakpoints: Breakpoint[] = [];
  if (!i.everSent) {
    breakpoints.push({ area: "Quote never sent", detail: "The quote never went to the client — the deal died before it started." });
  } else {
    if (comms.attempts <= 1) breakpoints.push({ area: "No follow-up", detail: "Quote sent, but little or no follow-up is logged." });
    if (comms.noResponse && comms.attempts >= 5) breakpoints.push({ area: "Went dark", detail: `${comms.attempts} attempts logged, mostly unanswered — no channel reached them.` });
    if (quoteLeadDays != null && quoteLeadDays >= 0 && quoteLeadDays <= 3) breakpoints.push({ area: "Quoted late", detail: `Quote sent ${quoteLeadDays} day(s) before the event — likely too late to win.` });
  }
  if (breakpoints.length === 0) breakpoints.push({ area: "Unknown", detail: "No clear process breakpoint in the data — the loss reason may be external (price, availability, competitor)." });

  return { comms, quoteLeadDays, recordedReason: i.lossReason, breakpoints };
}

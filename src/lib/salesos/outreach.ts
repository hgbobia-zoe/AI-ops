// Outreach drafting — the deterministic core. Turns a lead + its Goodshuffle comms history (the
// team's internal call/text/email log) into a suggested next message and call strategy. RULES
// CALCULATE the honest baseline; an optional LLM layer (service) refines it against the raw history.
// Nothing is ever sent automatically — this is a suggestion a human reviews and sends.

import type { SalesStage } from "./calc";

export interface CommsSummary {
  attempts: number; // dated log entries found in the notes
  lastContact: string | null; // the most recent date token in the notes (as written)
  channels: string[]; // channels seen: call / text / email / voicemail
  noResponse: boolean; // the log is dominated by no-answer attempts
  latestNote: string | null; // the last substantive line (often the key context)
  clientContext: string | null; // client-visible note (e.g. "on paternity leave")
}

const DATE_LINE = /^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/;

/** Parse the free-text internal notes into a structured, honest summary. No inference beyond what the
 *  text literally says — counts dated lines, spots channel keywords, keeps the last real line. */
export function summarizeComms(internalNotes?: string | null, clientNotes?: string | null): CommsSummary {
  const raw = (internalNotes ?? "").trim();
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const dated = lines.filter((l) => DATE_LINE.test(l));
  const lastContact = dated.length ? (dated[dated.length - 1].match(DATE_LINE)?.[1] ?? null) : null;

  const channels: string[] = [];
  const has = (re: RegExp): boolean => re.test(raw);
  if (has(/\bcall(ed|ing)?\b/i)) channels.push("call");
  if (has(/\b(text|message|sms)\b/i)) channels.push("text");
  if (has(/\bemail(ed|s)?\b/i)) channels.push("email");
  if (has(/\bvoicemail|\bvm\b/i)) channels.push("voicemail");

  const noResponseHits = (raw.match(/no response|no answer|didn't answer|voicemail/gi) ?? []).length;
  const noResponse = dated.length >= 3 && noResponseHits >= Math.ceil(dated.length / 2);

  const latestNote = lines.length ? lines[lines.length - 1] : null;
  const clientContext = (clientNotes ?? "").trim() || null;

  return { attempts: dated.length, lastContact, channels, noResponse, latestNote, clientContext };
}

export interface OutreachLead {
  firstName: string;
  eventName: string;
  eventDateLong: string | null; // formatted, e.g. "Saturday, Sep 20"
  daysToEvent: number | null;
  stage: SalesStage;
}

export type OutreachSource = "template" | "ai";

export interface OutreachDraft {
  sms: string;
  callStrategy: string;
  cadence: string; // when to reach out
  source: OutreachSource;
  caution: string | null; // a heads-up drawn from the history (e.g. many no-answers, client on leave)
}

const firstName = (name: string): string => (name || "").trim().split(/\s+/)[0] || "there";

/** Strip em/en dashes so drafts read like a person texting, not a brochure. Em dash → comma; a dash
 *  between digits ("2–3") → "to"; stray en dash → comma. Applied to templates AND any LLM output. */
export function humanize(text: string): string {
  return (text || "")
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Deterministic outreach by stage, adjusted for the comms history. Always available; the honest floor. */
export function templateOutreach(lead: OutreachLead, comms: CommsSummary): OutreachDraft {
  const fn = firstName(lead.firstName);
  const ev = lead.eventName || "your event";
  const when = lead.eventDateLong ? ` on ${lead.eventDateLong}` : "";

  // A caution surfaces when the history says "stop chasing the same way".
  let caution: string | null = null;
  if (comms.clientContext) caution = `Client note on file: "${comms.clientContext}". Factor this in before reaching out.`;
  else if (comms.noResponse && comms.attempts >= 5) caution = `${comms.attempts} attempts logged with little response. Try a different approach (new contact, new channel, or give it room) rather than another identical follow-up.`;

  let sms: string;
  let callStrategy: string;
  let cadence: string;

  switch (lead.stage) {
    case "unsent":
      sms = `Hi ${fn}, it's Zoe Events & Party Rentals. Your quote for ${ev} is ready to go. Want me to send it over, or is there anything you'd like to tweak first?`;
      callStrategy = `Quick call to confirm the details (date, count, delivery), then send the quote on the spot. Goal is to get it out today.`;
      cadence = "Now, it hasn't gone out yet.";
      break;
    case "awaiting":
      sms = `Hi ${fn}, just making sure the quote for ${ev} came through okay. Happy to answer any questions whenever you're ready.`;
      callStrategy = `Keep it light, the quote is still fresh. A soft "did it come through?" beats a hard push. Save the real follow-up for a few days out.`;
      cadence = "Give it 2 to 3 days before a real follow-up.";
      break;
    case "follow_up":
      sms = `Hi ${fn}, following up on your ${ev} quote. Happy to tweak anything or answer questions. Are you leaning toward moving forward?`;
      callStrategy = `Reference the quote, ask an open question (what's holding it up?), and offer to adjust. Listen for the real objection.`;
      cadence = "Today.";
      break;
    case "cold":
      sms = `Hi ${fn}, checking in one last time on your ${ev} rental quote. Should I keep it open for you, or have your plans changed? Either way, just let me know.`;
      callStrategy = `A respectful last attempt, give them an easy out. If no answer, try a different contact or channel, or mark it lost. Don't repeat the same chase.`;
      cadence = "Soon, then close it out.";
      break;
    case "closing":
    default:
      sms = `Hi ${fn}, your ${ev}${when} is coming up fast. Want to lock in your rentals? I can hold your items today so nothing sells out before your date.`;
      callStrategy = `Lead with the date${when}. Create real urgency, availability isn't guaranteed until it's signed. Offer to send the contract right now.`;
      cadence = "Now, the event is close and it's still unsigned.";
      break;
  }

  return { sms: humanize(sms), callStrategy: humanize(callStrategy), cadence: humanize(cadence), source: "template", caution: caution ? humanize(caution) : null };
}

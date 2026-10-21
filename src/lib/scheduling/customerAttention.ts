// The AI CUSTOMER-ATTENTION heads-up for the pre-shift driver debrief. This is explicitly an INTELLIGENCE
// task (free-text interpretation of the office's project notes and the customer's own messages), so an LLM
// writes the one-line warning — NOT keywords. Governing law (RULES CALCULATE, AI INTERPRETS): the gather
// below is deterministic (it only loads notes/comms that are already in our DB, keyed by each stop's
// Goodshuffle tx_id), and the LLM is asked ONLY to flag what those notes actually say. It never invents a
// sender, a message body, or a concern; when there is nothing worth flagging it returns the single token
// NONE and the debrief line drops. FAIL-SAFE: any LLM error / timeout / not-configured returns undefined,
// so the debrief ALWAYS still sends (the heads-up is additive, never a blocker). House comms style (no
// em-dashes, no emoji, short, natural) is enforced up front by COMMS_STYLE and again by humanize().

import { getBookingById, getEmailEventsForLead } from "@/lib/db/repo";
import { chat, llmConfigured } from "@/lib/llm";
import { humanize } from "@/lib/salesos/outreach";

/** One route stop, as much as the gather needs: the customer name and the Goodshuffle project id (tx_id)
 *  that joins the stop to its booking (Event tx_id === booking id in the same GS id space). */
export interface AttentionStop {
  txId?: string | null;
  custName?: string | null;
}

export interface CustomerAttentionOpts {
  timeoutMs?: number;
  /** Max characters of notes/comms text fed in per customer (bounds the prompt + cost). */
  maxCharsPerCustomer?: number;
  /** Max distinct customers folded into the single call (keeps one route to one bounded call). */
  maxCustomers?: number;
}

const DEFAULT_MAX_CHARS_PER_CUSTOMER = 1200;
const DEFAULT_MAX_CUSTOMERS = 8;
const DEFAULT_TIMEOUT_MS = 20000;

/** The facts-only context for one customer on the route. Only fields we actually hold are filled; a missing
 *  field is simply absent (never a guess). `signals` is the raw text the LLM interprets. */
interface CustomerFacts {
  customer: string;
  signals: string[];
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

/** DETERMINISTIC gather: for each stop with a tx_id, pull the project's internal notes (the office's
 *  call/text/email LOG per the app's design), the client-visible notes, and the captured client-email
 *  thread (subject + short snippet). Returns facts-only context per customer, deduped by tx_id, bounded. */
export function gatherCustomerFacts(stops: AttentionStop[], opts: CustomerAttentionOpts = {}): CustomerFacts[] {
  const maxChars = opts.maxCharsPerCustomer ?? DEFAULT_MAX_CHARS_PER_CUSTOMER;
  const maxCustomers = opts.maxCustomers ?? DEFAULT_MAX_CUSTOMERS;
  const out: CustomerFacts[] = [];
  const seen = new Set<string>();

  for (const stop of stops) {
    const txId = stop.txId?.trim();
    if (!txId || seen.has(txId)) continue;
    seen.add(txId);

    const booking = getBookingById(txId);
    const customer = (stop.custName || booking?.clientName || "").trim() || "This customer";
    const signals: string[] = [];

    const internal = booking?.internalNotes?.trim();
    if (internal) signals.push(`Office notes: ${internal}`);
    const client = booking?.clientNotes?.trim();
    if (client) signals.push(`Client notes: ${client}`);

    // The captured client-email thread (facts only: subject + short snippet the pull stored; never a body
    // we did not capture). Newest first; a few messages are plenty of signal and keep the prompt bounded.
    try {
      for (const em of getEmailEventsForLead(txId, 6)) {
        const parts: string[] = [];
        if (em.subject) parts.push(`subject "${em.subject.trim()}"`);
        if (em.snippet) parts.push(em.snippet.trim());
        if (parts.length) signals.push(`Email (${em.direction ?? "unknown direction"}): ${parts.join(" - ")}`);
      }
    } catch {
      /* email read is best-effort; a gather failure must never block the debrief */
    }

    if (!signals.length) continue; // no signal for this customer → nothing to interpret
    out.push({ customer, signals: [clip(signals.join("\n"), maxChars)] });
    if (out.length >= maxCustomers) break;
  }
  return out;
}

const SYSTEM_PROMPT =
  "You are briefing a delivery crew for an event rental company. From the customer notes and messages " +
  "given, write at most 1 to 2 short sentences flagging anything the crew should pay attention to for a " +
  "smooth delivery: a customer who had PAST DELAYS or a bad prior experience, asked for an EARLIER or " +
  "tight delivery time, or raised a specific concern. Only state what the notes actually say. Name the " +
  "customer when you flag them. If several customers have signals, combine them concisely. If there is " +
  "nothing worth flagging, reply with the single token NONE. No sign-off, no emoji, no dashes.";

function buildUserPrompt(facts: CustomerFacts[]): string {
  const blocks = facts.map((f) => `Customer: ${f.customer}\n${f.signals.join("\n")}`);
  return `Customer notes and messages for the stops on this route:\n\n${blocks.join("\n\n---\n\n")}`;
}

/** Is the result the model's honest "nothing to flag"? NONE (any case/punctuation) or empty → no line. */
function isNone(text: string): boolean {
  const t = text.trim().replace(/[.!]+$/, "");
  return t.length === 0 || /^none$/i.test(t);
}

/**
 * The AI customer-attention heads-up for a route, or undefined when there is nothing to say. One bounded
 * LLM call per route (never per stop). Returns undefined — so the {customerAttention} debrief line drops —
 * when: the LLM is not configured, the gather found no signal, the model replied NONE/empty, or ANY error /
 * timeout occurred. NEVER throws: the debrief must still send. The returned line is run through humanize()
 * so no dash or emoji the model slips in survives.
 */
export async function customerAttentionNote(
  route: { stops: AttentionStop[] } | null | undefined,
  opts: CustomerAttentionOpts = {},
): Promise<string | undefined> {
  try {
    if (!llmConfigured()) return undefined;
    const stops = route?.stops ?? [];
    if (!stops.length) return undefined;

    const facts = gatherCustomerFacts(stops, opts);
    if (!facts.length) return undefined;

    const res = await chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(facts) },
      ],
      { temperature: 0.2, maxTokens: 220, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
    if (!res.ok || !res.text) return undefined;
    if (isNone(res.text)) return undefined;

    const line = humanize(res.text.trim());
    return line.length ? line : undefined;
  } catch {
    // Fail-safe: never let the heads-up break the debrief send.
    return undefined;
  }
}

// Autopsy service — assembles a lost deal's post-mortem: the deterministic analysis (analyzeLostDeal)
// plus an optional AI narrative (why it likely slipped + what an elite Zoe rep would have done),
// grounded in the actual contact log and clearly labelled INFERENCE. No LLM ⇒ deterministic only.

import { getBookingById } from "@/lib/db/repo";
import { sentFromStatus } from "./calc";
import { chat, llmConfigured } from "@/lib/llm";
import { analyzeLostDeal, type Autopsy } from "./autopsy";

export interface AutopsyResult {
  id: string;
  eventName: string;
  clientName: string;
  value: number | null;
  eventDate: string | null;
  statusLabel: string;
  internalNotes: string | null;
  autopsy: Autopsy;
  narrative: { why: string; eliteMove: string; model?: string } | null;
}

const SYSTEM =
  "You are a sales coach reviewing a LOST event-rental deal for Zoe Events (a premium DC/MD/VA company). " +
  "Given the facts and the rep's own contact log, explain in plain terms why it most likely slipped, and " +
  "what an elite Zoe rep would have done differently. Ground every claim in the log — if the data doesn't " +
  "say why, say the loss reason is likely external and unknown. Zoe wins on reliability/execution, not price: " +
  "never say 'lower the price' as the fix. Output RAW JSON ONLY: " +
  '{"why": "1-2 sentences", "eliteMove": "1-2 sentences"}.';

function extractJson(text: string): unknown {
  let s = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const f = s.indexOf("{");
  const l = s.lastIndexOf("}");
  if (f >= 0 && l > f) s = s.slice(f, l + 1);
  return JSON.parse(s);
}

async function llmNarrative(facts: string): Promise<{ why: string; eliteMove: string; model?: string } | null> {
  if (!llmConfigured()) return null;
  const r = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: facts.slice(0, 6000) }], { json: true, temperature: 0.3, timeoutMs: 40000 });
  if (!r.ok || !r.text) return null;
  try {
    const p = extractJson(r.text) as { why?: unknown; eliteMove?: unknown };
    if (typeof p.why !== "string") return null;
    return { why: p.why.trim(), eliteMove: typeof p.eliteMove === "string" ? p.eliteMove.trim() : "", model: r.model };
  } catch {
    return null;
  }
}

export async function getAutopsy(leadId: string): Promise<AutopsyResult | null> {
  const b = getBookingById(leadId);
  if (!b) return null;
  const everSent = sentFromStatus(b.statusLabel) ?? !!b.quoteSentDate;
  const autopsy = analyzeLostDeal({ everSent, quoteSentDate: b.quoteSentDate, eventDate: b.eventDate, lossReason: b.lossReason, internalNotes: b.internalNotes });

  const facts = JSON.stringify({
    event: b.eventName,
    eventDate: b.eventDate,
    quoteSentDate: b.quoteSentDate,
    quoteLeadDays: autopsy.quoteLeadDays,
    recordedLossReason: b.lossReason ?? "(none recorded)",
    attempts: autopsy.comms.attempts,
    channelsTried: autopsy.comms.channels,
    wentDark: autopsy.comms.noResponse,
    contactLog: (b.internalNotes ?? "").slice(0, 4000) || "(no log)",
    processBreakpoints: autopsy.breakpoints.map((x) => x.area),
  });

  return {
    id: b.bookingId,
    eventName: b.eventName,
    clientName: b.clientName,
    value: b.grandTotal,
    eventDate: b.eventDate,
    statusLabel: b.statusLabel,
    internalNotes: b.internalNotes,
    autopsy,
    narrative: await llmNarrative(facts),
  };
}

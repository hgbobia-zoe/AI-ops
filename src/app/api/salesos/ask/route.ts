// Ask-the-sale: an AI helper scoped to ONE lead. The rep asks "how should I answer this?" or anything
// about the project and gets grounded, practical help — built only from what we actually know about the
// lead (state, notes, conversation). INFERENCE, not fact: it's coaching for the rep to use, never an
// auto-send. Proxy-gated to signed-in console users.

import { NextResponse } from "next/server";
import { getLead } from "@/lib/salesos/service";
import { getBookingById, getCustomerState, getCommsForLead } from "@/lib/db/repo";
import { resolveDeterministic, fromStored, replyMinutesAgo } from "@/lib/salesos/stateService";
import { nextBestAction } from "@/lib/salesos/nba";
import { STATE_LABEL } from "@/lib/salesos/state";
import { chat, llmConfigured } from "@/lib/llm";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const COACH_MODEL = process.env.COACH_MODEL?.trim() || undefined;

export async function POST(req: Request): Promise<NextResponse> {
  if (!llmConfigured()) return NextResponse.json({ error: "The AI model isn't configured (set ANTHROPIC_API_KEY)." }, { status: 400 });

  let body: { id?: string; question?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  const question = (body.question ?? "").trim();
  if (!id || !question) return NextResponse.json({ error: "id and question required" }, { status: 400 });

  const lead = getLead(id);
  if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 });

  const showMoney = canSeeFinancials(await viewerRole());
  const booking = getBookingById(id);
  const stored = getCustomerState(id);
  const cstate = stored ? fromStored(stored) : booking ? resolveDeterministic(booking) : null;
  const nba = cstate ? nextBestAction({ state: cstate.state, value: lead.value, daysToEvent: lead.signals.daysToEvent, repliedMinutesAgo: replyMinutesAgo(id) }) : null;

  const dte = lead.signals.daysToEvent;
  const eventWhen = dte == null ? "no event date" : dte < 0 ? `${Math.abs(dte)} days ago` : dte === 0 ? "today" : dte === 1 ? "tomorrow" : `in ${dte} days`;

  const convo = getCommsForLead(id, 12)
    .reverse()
    .map((c) => `${c.direction === "inbound" ? "Customer" : c.channel === "call" ? "Call" : "Zoe"}: ${(c.body ?? "").slice(0, 300)}`)
    .join("\n");

  const context = [
    `Event: ${lead.eventName || "(unnamed)"}`,
    `Client: ${lead.clientName || "(unknown)"}`,
    `Goodshuffle status: ${lead.statusLabel || "(none)"}`,
    `Event date: ${lead.eventDate ?? "not set"} (${eventWhen})`,
    showMoney && lead.value != null ? `Quote total: $${Math.round(lead.value).toLocaleString("en-US")}` : "",
    cstate ? `Customer state: ${STATE_LABEL[cstate.state]}${cstate.reason ? ` — ${cstate.reason}` : ""}${cstate.evidence && cstate.source === "inbound_reply" ? ` (they said: "${cstate.evidence}")` : ""}` : "",
    nba ? `Recommended next step: ${nba.objective}${nba.doNot ? ` (do NOT: ${nba.doNot})` : ""}` : "",
    lead.clientNotes ? `Client note: ${lead.clientNotes.slice(0, 500)}` : "",
    lead.internalNotes ? `Prior contact log (Goodshuffle):\n${lead.internalNotes.slice(0, 2500)}` : "",
    convo ? `Recent conversation (oldest→newest):\n${convo}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const system =
    "You are a sharp, practical sales coach for Zoe Events, a premium event & party rental company in the DC/MD/VA area. " +
    "A sales rep is asking for help with ONE specific lead. Answer their question directly and concisely using ONLY the context provided. " +
    "Zoe's methodology: discovery before discounting, verify before promising, always follow a call with a text and an email. " +
    "If asked how to respond, offer a short ready-to-send reply they can edit. If the context doesn't contain something (e.g. exact pricing or availability), say so plainly and tell them to confirm in Goodshuffle — never invent prices, dates, or commitments. Keep it tight and actionable.";

  const res = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: `LEAD CONTEXT\n${context}\n\nREP'S QUESTION\n${question}` },
    ],
    { model: COACH_MODEL, maxTokens: 700, timeoutMs: 45000 },
  );

  if (!res.ok) return NextResponse.json({ error: res.error || "The AI couldn't answer right now." }, { status: 200 });
  return NextResponse.json({ answer: res.text ?? "" });
}

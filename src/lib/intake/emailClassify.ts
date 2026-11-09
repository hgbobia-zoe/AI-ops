// The paid step of the hello@ email triage, kept as small as possible: ONE short Claude Haiku call, and only
// for emails that already passed every free check in emailLead.ts (so newsletters, our own mail, replies and
// platform notices never reach it). It confirms the email is a new rental inquiry and pulls out the event
// details. About a cent for every few emails. Without an LLM key the route falls back to the rules alone.

import { chat, llmConfigured } from "@/lib/llm";
import type { InboundEmail, ModelExtract } from "./emailLead";

export type EmailIntent = "new_inquiry" | "existing_conversation" | "vendor_or_pitch" | "job_or_partnership" | "spam_or_automated" | "other";

export interface EmailClassification extends ModelExtract {
  intent: EmailIntent;
  confidence: number;
  summary: string;
}

const INTENTS: EmailIntent[] = ["new_inquiry", "existing_conversation", "vendor_or_pitch", "job_or_partnership", "spam_or_automated", "other"];

/** The confidence a "new_inquiry" needs before a Goodshuffle project is made. */
export const LEAD_CONFIDENCE = 0.6;

export function emailClassifierAvailable(): boolean {
  return llmConfigured() && process.env.EMAIL_INTAKE_AI !== "false";
}

function prompt(e: InboundEmail, today: string): string {
  return [
    "You triage email sent to hello@ at Zoe Events & Party Rentals, an event rental company near Washington DC",
    "(tents, tables, chairs, linens, lounge furniture, staging, delivered and set up).",
    "Decide if this email is a NEW customer asking about renting for an event. Event planners, coordinators,",
    "designers, venues and companies asking us to rent, quote or supply items for an event (their own or a",
    "client's) ARE customers: new_inquiry, even when they describe their own business or ask for an item we",
    "may not carry. vendor_or_pitch is ONLY someone trying to sell their own products or services TO us.",
    "Job seekers, partnership or sponsorship requests, invoices, newsletters and automated mail are not customers.",
    "A client already in a conversation with us (talking about an existing order, a payment, a contract) is",
    `existing_conversation. Today is ${today}. Resolve relative dates ("next Saturday") to YYYY-MM-DD.`,
    "",
    "Reply with JSON only, no prose:",
    '{"intent":"new_inquiry|existing_conversation|vendor_or_pitch|job_or_partnership|spam_or_automated|other",',
    '"confidence":0.0,"firstName":"","lastName":"","phone":"","eventType":"wedding|corporate|social|other or empty",',
    '"eventDate":"YYYY-MM-DD or empty","guestCount":null,"summary":"one short sentence"}',
    "Use the signature for the name when it is clearer than the sender name. Leave a field empty when the email does not say.",
    "",
    `From: ${e.fromName} <${e.fromEmail}>`,
    `Subject: ${e.subject}`,
    "",
    e.body.slice(0, 3000),
  ].join("\n");
}

/** Pull the first JSON object out of a model reply (tolerates a code fence or a stray sentence). */
export function parseClassification(text: string): EmailClassification | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const intent = INTENTS.includes(j.intent as EmailIntent) ? (j.intent as EmailIntent) : "other";
  const conf = Number(j.confidence);
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const gc = j.guestCount == null || j.guestCount === "" ? null : Number(String(j.guestCount).replace(/[^\d]/g, "")) || null;
  return {
    intent,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    summary: s(j.summary).slice(0, 200),
    firstName: s(j.firstName),
    lastName: s(j.lastName),
    phone: s(j.phone),
    eventType: s(j.eventType),
    eventDate: /^\d{4}-\d{2}-\d{2}$/.test(s(j.eventDate)) ? s(j.eventDate) : "",
    guestCount: gc,
  };
}

/** One Haiku call. Null when no model is set up or the call fails (the caller then uses the rules alone). */
export async function classifyEmail(e: InboundEmail, today: string): Promise<EmailClassification | null> {
  if (!emailClassifierAvailable()) return null;
  const r = await chat([{ role: "user", content: prompt(e, today) }], {
    json: true,
    temperature: 0,
    maxTokens: 300,
    timeoutMs: 20_000,
    model: process.env.EMAIL_INTAKE_MODEL?.trim() || undefined,
  });
  return r.ok && r.text ? parseClassification(r.text) : null;
}

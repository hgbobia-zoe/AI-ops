// Outreach service — assembles the suggested next message / call strategy for a lead. Deterministic
// template first (always), then an LLM pass that reads the ACTUAL Goodshuffle comms history (the
// internal call/text/email log) and tailors the copy — e.g. it won't tell you to send another chase
// to a client who's been contacted 20 times and is on leave. Human reviews and sends; nothing auto-sends.
//
// The LLM is used when configured, unless OUTREACH_LLM=off. Drafting is on-demand (a salesperson
// clicks "draft"), so the per-use cost is small — no need to gate it off by default.

import { getLead } from "./service";
import { STAGE_LABEL, type SalesStage } from "./calc";
import { summarizeComms, templateOutreach, humanize, type CommsSummary, type OutreachDraft, type OutreachLead } from "./outreach";
import { chat, llmConfigured, llmModel } from "@/lib/llm";
import { formatYmdLong } from "@/lib/dates";

export interface OutreachResult {
  id: string;
  clientName: string;
  clientPhone: string;
  canText: boolean; // a phone is on file → the Send-via-Quo path is available
  eventName: string;
  stage: SalesStage;
  stageLabel: string;
  comms: CommsSummary;
  draft: OutreachDraft;
  historyRaw: string | null; // the internal notes, for display
  llmModel?: string;
}

function outreachLlmEnabled(): boolean {
  const v = (process.env.OUTREACH_LLM ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

const SYSTEM =
  "You are a sales coach for Zoe Events & Party Rentals (an event-rental company in the DC/Maryland/" +
  "Virginia area). Given ONE open quote — its stage, event, and the rep's own logged history of calls/" +
  "texts/emails — write the single best next outreach. Read the history carefully: do NOT suggest another " +
  "identical follow-up when the client has been contacted many times with no response, and respect any " +
  "context note (e.g. on leave, deferred to another contact). " +
  "Write like a real person texting a customer: warm, natural, and concise. Contractions are good. Do NOT " +
  "sound like a brochure or a mass marketing blast, and do NOT use buzzwords like 'unforgettable'. " +
  "Open the text by greeting the customer by first name and introducing the rep by name: " +
  "'Hi {customer first name}, this is {repFirstName} from Zoe Events, ...'. If repFirstName is empty, use " +
  "'Hi {customer first name}, it's Zoe Events, ...' instead. " +
  "Refer to the customer's event by its DATE, 'your event on {eventDateLong}', and NEVER by the internal " +
  "project name (it's often just a last name and reads oddly to the client). If no date is given, say " +
  "'your event'. " +
  "CRITICAL STYLE RULE: never use an em dash or en dash (— or –) anywhere — use commas, periods, or a new " +
  "sentence instead. No emojis. Sign texts as Zoe Events. The rep will review and send it themselves, so " +
  "never imply it was already sent. " +
  'Output RAW JSON ONLY, no markdown/fences: {"sms": string, "callStrategy": string, "cadence": string, "caution": string}. ' +
  "sms <= 320 characters. caution = one short heads-up drawn from the history, or empty string if none.";

function extractJson(text: string): unknown {
  let s = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}

async function llmDraft(lead: OutreachLead, clientName: string, eventDate: string | null, history: string | null, clientContext: string | null): Promise<{ draft: OutreachDraft; model?: string } | null> {
  const user = JSON.stringify({
    stage: lead.stage,
    stageMeaning: STAGE_LABEL[lead.stage],
    client: clientName,
    repFirstName: lead.repFirstName ?? "", // the signed-in rep — introduce them by name in the opening
    internalProjectName: lead.eventName, // context only — do NOT use in the customer-facing copy
    eventDate,
    eventDateLong: lead.eventDateLong ?? null, // say "your event on {this}"
    daysToEvent: lead.daysToEvent,
    clientContextNote: clientContext ?? "",
    commsHistory: (history ?? "").slice(0, 6000) || "(no prior contact logged)",
  });
  const r = await chat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    { json: true, temperature: 0.4, timeoutMs: 45000 },
  );
  if (!r.ok || !r.text) return null;
  try {
    const p = extractJson(r.text) as { sms?: unknown; callStrategy?: unknown; cadence?: unknown; caution?: unknown };
    if (typeof p.sms !== "string" || !p.sms.trim()) return null;
    return {
      draft: {
        // humanize() strips any em/en dashes the model slips in, so drafts always read like a person.
        sms: humanize(p.sms),
        callStrategy: typeof p.callStrategy === "string" ? humanize(p.callStrategy) : "",
        cadence: typeof p.cadence === "string" ? humanize(p.cadence) : "",
        caution: typeof p.caution === "string" && p.caution.trim() ? humanize(p.caution) : null,
        source: "ai",
      },
      model: r.model ?? llmModel(),
    };
  } catch {
    return null;
  }
}

/** Draft the next outreach for a lead: template baseline, LLM-refined against the real comms history.
 *  `repFirstName` (the signed-in rep) personalizes the opening: "Hi {customer}, this is {rep}...". */
export async function draftLeadOutreach(id: string, repFirstName?: string | null): Promise<OutreachResult | null> {
  const l = getLead(id);
  if (!l) return null;

  const comms = summarizeComms(l.internalNotes, l.clientNotes);
  const oLead: OutreachLead = {
    firstName: l.clientName,
    eventName: l.eventName,
    eventDateLong: l.eventDate ? formatYmdLong(l.eventDate) : null,
    daysToEvent: l.signals.daysToEvent,
    stage: l.stage,
    repFirstName: repFirstName ?? null,
  };

  let draft = templateOutreach(oLead, comms);
  let model: string | undefined;
  if (outreachLlmEnabled() && llmConfigured()) {
    const ai = await llmDraft(oLead, l.clientName, l.eventDate, l.internalNotes, l.clientNotes);
    if (ai) {
      draft = ai.draft;
      model = ai.model;
      if (!draft.caution && comms.clientContext) draft.caution = humanize(`Client note: "${comms.clientContext}".`);
    }
  }

  return {
    id: l.id,
    clientName: l.clientName,
    clientPhone: l.clientPhone,
    canText: l.clientPhone.trim().length > 0,
    eventName: l.eventName,
    stage: l.stage,
    stageLabel: STAGE_LABEL[l.stage],
    comms,
    draft,
    historyRaw: l.internalNotes,
    llmModel: model,
  };
}

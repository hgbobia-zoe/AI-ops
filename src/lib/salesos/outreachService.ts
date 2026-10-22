// Outreach service — assembles the suggested next message / call strategy for a lead. Deterministic
// template first (always), then an LLM pass that reads the ACTUAL Goodshuffle comms history (the
// internal call/text/email log) and tailors the copy — e.g. it won't tell you to send another chase
// to a client who's been contacted 20 times and is on leave. Human reviews and sends; nothing auto-sends.
//
// The LLM is used when configured, unless OUTREACH_LLM=off. Drafting is on-demand (a salesperson
// clicks "draft"), so the per-use cost is small — no need to gate it off by default.

import { getLead } from "./service";
import { buildLeadTimeline } from "./timeline";
import { STAGE_LABEL, type SalesStage } from "./calc";
import { summarizeComms, templateOutreach, humanize, renderConversationContext, type CommsSummary, type ConversationContext, type OutreachDraft, type OutreachLead } from "./outreach";
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
  "Virginia area). Given ONE open quote — its stage, event, the rep's own logged history of calls/" +
  "texts/emails, the two-way CONVERSATION (the customer's own texts/calls/emails, both directions), and " +
  "the single most recent thing the CUSTOMER said — write the single best next outreach. Read the history " +
  "carefully: do NOT suggest another identical follow-up when the client has been contacted many times " +
  "with no response, and respect any context note (e.g. on leave, deferred to another contact). " +
  "GROUND THE MESSAGE IN WHAT THE CUSTOMER ACTUALLY SAID. If the customer said they need to decide with a " +
  "spouse, partner, or family, are travelling, asked for time, or raised a specific question or concern, " +
  "ACKNOWLEDGE that directly and build the message on it: a gentle, no-pressure check-in that offers to " +
  "help, matched to their stated situation, never a generic chase. " +
  "DO NOT INVENT A SITUATION THE CUSTOMER NEVER STATED. In particular, do NOT frame this as comparing " +
  "vendors, weighing options, or an 'apples to apples' comparison unless the customer actually said they " +
  "are comparing or shopping around. Never state any fact that is not in the context you were given. " +
  "If there is no conversation, notes, or call summary at all, write a brief, neutral, low-pressure " +
  "follow-up and do not assume any reason for the silence. " +
  "Write like a real person texting a customer: warm, natural, and concise. Contractions are good. Do NOT " +
  "sound like a brochure or a mass marketing blast, and do NOT use buzzwords like 'unforgettable'. " +
  "Open the text by greeting the customer by first name and introducing the rep by name: " +
  "'Hi {customer first name}, this is {repFirstName} from Zoe Events, ...'. If repFirstName is empty, use " +
  "'Hi {customer first name}, it's Zoe Events, ...' instead. " +
  "Refer to the customer's event by its DATE, 'your event on {eventDateLong}', and NEVER by the internal " +
  "project name (it's often just a last name and reads oddly to the client). If no date is given, say " +
  "'your event'. " +
  "CRITICAL STYLE RULE: never use an em dash or en dash (— or –) anywhere — use commas, periods, or a new " +
  "sentence instead. No emojis. " +
  "Do NOT add a closing sign-off or signature line. No 'Best,', no 'Thanks,', no 'Sincerely,', no 'Warm " +
  "regards,', and no trailing 'Zoe Events' name line. The opening greeting already identifies the rep and " +
  "the company, and when this is sent as an email Goodshuffle automatically appends the Zoe Events " +
  "signature, so any closing you add would be a duplicate. End at your last real sentence. " +
  "The rep will review and send it themselves, so never imply it was already sent. " +
  'Output RAW JSON ONLY, no markdown/fences: {"sms": string, "callStrategy": string, "cadence": string, "caution": string}. ' +
  "sms <= 320 characters. caution = one short heads-up drawn from the history, or empty string if none.";

function extractJson(text: string): unknown {
  let s = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}

async function llmDraft(lead: OutreachLead, clientName: string, eventDate: string | null, history: string | null, clientContext: string | null, convo: ConversationContext): Promise<{ draft: OutreachDraft; model?: string } | null> {
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
    // The genuine two-way conversation (texts/calls/emails, both directions) + the latest customer
    // statement — so the draft is tailored to what they actually said, not a generic follow-up.
    conversation: convo.thread || "(no two-way conversation captured)",
    latestCustomerMessage: convo.latestInbound ?? "",
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
export async function draftLeadOutreach(id: string, repFirstName?: string | null, opts?: { skipLlm?: boolean }): Promise<OutreachResult | null> {
  const l = getLead(id);
  if (!l) return null;

  const comms = summarizeComms(l.internalNotes, l.clientNotes);
  // The FULL two-way picture: merged texts/calls/emails (incl. the latest inbound) + call summaries, from
  // the same deterministic timeline the drawer shows. Assembled here, never inferred — the LLM only drafts.
  const convo = renderConversationContext(buildLeadTimeline(l.id));
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
  // skipLlm: return the deterministic template draft only (no model call). The bulk cockpit uses this to
  // build every row instantly, then upgrades rows to the LLM draft within a bounded time budget — so one
  // slow/unavailable model never hangs the whole page on a sequential per-lead draft.
  if (!opts?.skipLlm && outreachLlmEnabled() && llmConfigured()) {
    const ai = await llmDraft(oLead, l.clientName, l.eventDate, l.internalNotes, l.clientNotes, convo);
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

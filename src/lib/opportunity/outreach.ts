// Opportunity Radar — outreach drafting (§10). DETECT → DRAFT → HUMAN APPROVAL → SEND → TRACK. This
// produces a DRAFT only: a deterministic template floor (always available, in the house voice) that the
// LLM refines when configured. Nothing is sent here — a human approves/edits, and sending is a separate
// recorded action. Facts only; never invents a contact, date, or requirement.

import { chat, llmConfigured, llmModel } from "@/lib/llm";
import { humanize } from "@/lib/salesos/outreach";
import { singleView, type OpportunityView } from "./service";
import { JURISDICTION_LABEL, ZOE_CATEGORY_LABEL } from "./types";
import { CATEGORY_ANALOG } from "./research";

export interface OutreachDraft {
  channel: "email";
  subject: string;
  body: string;
  callScript: string;
  followUps: string[];
  reason: string;
  source: "template" | "ai";
  model?: string;
}

const ZOE_LINE = "Zoe Event Rentals provides tents, tables, chairs, flooring, linens and event infrastructure for large-scale events across the DC, Maryland and Virginia area.";

function categoriesPhrase(v: OpportunityView): string {
  return v.opp.zoeCategories.length ? v.opp.zoeCategories.map((c) => ZOE_CATEGORY_LABEL[c].toLowerCase()).join(", ") : CATEGORY_ANALOG[v.opp.kind];
}

function templateDraft(v: OpportunityView, targetName: string | null, repName: string): OutreachDraft {
  const e = v.opp;
  const who = targetName ?? (e.organization ?? "your team");
  const subject = `Event rentals for ${e.name}`;
  const body = humanize(
    `Hi ${targetName ? targetName.split(" ")[0] : "there"}, I'm ${repName} with Zoe Event Rentals. ` +
      `We came across ${e.name} in ${JURISDICTION_LABEL[e.jurisdiction]} and wanted to introduce ourselves. ` +
      `${ZOE_LINE} ` +
      `If ${who} is coordinating ${e.name}, we would love to be a resource for ${categoriesPhrase(v)}. ` +
      `Would you be open to a quick call to see if we can help?`,
  );
  const callScript = humanize(
    `Opening: Hi, this is ${repName} with Zoe Event Rentals. Reason: we saw ${e.name} in ${JURISDICTION_LABEL[e.jurisdiction]} and think you may need ${categoriesPhrase(v)}. ` +
      `Value: we handle event infrastructure for large DMV events end to end, delivery through pickup. ` +
      `Ask: who handles rentals for this, and can we send a quick capabilities overview? Close: set a follow up.`,
  );
  const followUps = ["Day 3: short email nudge with a one-page capabilities overview", "Day 7: brief call to answer questions", "Day 14: value-add resource (past similar event, references)"];
  const reason = v.recommendedAction;
  return { channel: "email", subject, body, callScript, followUps, reason, source: "template" };
}

/** Draft outreach for an opportunity's primary (or chosen) target. Template floor + optional AI refine. */
export async function draftOpportunityOutreach(id: string, opts: { targetName?: string; repName?: string } = {}): Promise<OutreachDraft | null> {
  const v = singleView(id);
  if (!v) return null;
  const targetName = opts.targetName ?? v.primaryTarget?.edge.entity.name ?? null;
  const repName = opts.repName?.trim() || "the Zoe team";
  const floor = templateDraft(v, targetName, repName);
  if (!llmConfigured()) return floor;

  const sys =
    "You write a short, warm B2B outreach email + a call script for Zoe Event Rentals (event infrastructure: tents, tables, chairs, staging, flooring, linens) in the DC/MD/VA area. Use ONLY the facts given; never invent contacts, dates, dollar amounts, or requirements. No dashes as punctuation, no emojis, plain and human. Return strict JSON: {\"subject\": string, \"body\": string (<=110 words), \"callScript\": string (<=90 words)}.";
  const facts = { opportunity: v.opp.name, jurisdiction: JURISDICTION_LABEL[v.opp.jurisdiction], organization: v.opp.organization, target: targetName, rep: repName, zoeProvides: categoriesPhrase(v) };
  const res = await chat([{ role: "user", content: `${sys}\n\nFACTS:\n${JSON.stringify(facts, null, 2)}` }], { json: true, temperature: 0.4, maxTokens: 500 });
  if (res.ok && res.text) {
    try {
      const p = JSON.parse(res.text) as { subject?: string; body?: string; callScript?: string };
      return {
        ...floor,
        subject: (p.subject ?? floor.subject).trim(),
        body: humanize((p.body ?? floor.body).trim()),
        callScript: humanize((p.callScript ?? floor.callScript).trim()),
        source: "ai",
        model: res.model ?? llmModel(),
      };
    } catch { /* keep template */ }
  }
  return floor;
}
